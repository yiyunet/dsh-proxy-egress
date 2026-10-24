#!/usr/bin/env node
/**
 * 公开前脱敏扫描（P6）。
 *
 * ── 为什么词表必须放在仓库之外 ────────────────────────────────────────────
 *   npm 的 `files` 白名单**优先级高于** `.gitignore`。词表若放进仓库里
 *   （比如 scripts/），它会被**原样打进发布包** —— 防泄漏机制自己成了泄漏源。
 *   所以：词表放在仓库外，用环境变量挂进来；未设置时**自动跳过**，
 *   这样 CI 永远接触不到这些词。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   把词表放在**仓库之外**的某个目录，然后只把「路径」交给环境变量：
 *
 *   Windows PowerShell（5.1 与 7 均可，用 .NET 写无 BOM 文件）：
 *     $t = "第一行词`n第二行词`n"
 *     [System.IO.File]::WriteAllText('<词表文件绝对路径>', $t, (New-Object System.Text.UTF8Encoding($false)))
 *     $env:DSH_PRIVATE_TERMS = '<词表文件绝对路径>'
 *     npm run scan
 *   bash:
 *     DSH_PRIVATE_TERMS=<词表文件绝对路径> npm run scan
 *
 *   词表格式：一行一个词，`#` 开头为注释。读不到文件会**报错退出**，不会猜。
 *
 * ⚠️ 本文件会被打进发布包（`files` 含 `scripts/`），所以**这里绝不能写真实路径**。
 *
 * ── 控制组原则（本脚本的重点）─────────────────────────────────────────────
 *   "0 命中"什么都不证明 —— 必须配一个**必定命中**的对照。
 *   这里用包名本身做对照：如果连包名都搜不到，说明扫描路径或读文件逻辑坏了，
 *   此时**任何**零命中断言都不可信，脚本直接报错而不是放过。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.lib-staging', '.lib-backup', 'dist'])
const TEXT_EXT = /\.(mjs|js|json|yml|yaml|md|txt|ps1|sh)$/
const MAX_BYTES = 2 * 1024 * 1024

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(path, out)
    } else if (entry.isFile() && TEXT_EXT.test(entry.name)) {
      const info = await stat(path)
      if (info.size <= MAX_BYTES) out.push(path)
    }
  }
  return out
}

/** 读私有词表。**读不到就报错退出，绝不猜**。 */
async function loadTerms() {
  const raw = process.env.DSH_PRIVATE_TERMS
  if (raw === undefined || raw.trim() === '') return null

  let text
  try {
    text = await readFile(raw, 'utf8')
  } catch (error) {
    // 这里曾经有一条"读不到就把它当逗号分隔词表"的兜底 —— 那是个**真实缺陷**：
    // 路径写错 / 文件没建 / 权限不足，都会被悄悄降级成"搜这个路径字符串"，
    // 运气好报假阳性，运气坏报**零命中**——而你以为扫干净了，其实词表没加载。
    // 脱敏扫描器必须 fail-closed：读不到就停，不能猜。
    console.error(`✗ DSH_PRIVATE_TERMS 指向的文件读不到：${raw}（${error?.code ?? String(error?.message ?? error)}）`)
    console.error('  这不是警告，是失败：词表没加载时"零命中"毫无意义。')
    console.error('  请确认路径正确、文件存在；或清空该环境变量以显式跳过。')
    process.exit(1)
  }

  // 容忍 UTF-8 BOM：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
  // 不剥掉的话**第一条词**会带上 \uFEFF 而永远匹配不到 —— 一个静默的假阴性。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const files = await walk(ROOT)

console.log(`扫描仓库文本文件 ${files.length} 个（词表：${process.env.DSH_PRIVATE_TERMS ? '已挂载' : '未设置'}）`)

// ── 控制组：用一个**必定存在**的串验证扫描器本身是好的 ──────────────────────
const control = pkg.name
let controlHits = 0
const contents = new Map()
for (const path of files) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    continue
  }
  contents.set(path, text)
  if (text.includes(control)) controlHits += 1
}
if (files.length === 0 || controlHits === 0) {
  console.error(`✗ 控制组失败：连 "${control}" 都搜不到（文件 ${files.length} 个，命中 ${controlHits} 个）。`)
  console.error('  这说明扫描路径或读文件逻辑坏了 —— 此时"零命中"毫无意义，必须先修扫描器。')
  process.exit(1)
}
console.log(`控制组通过：包名在 ${controlHits} 个文件里被命中（证明扫描器有效）`)

const terms = await loadTerms()
if (terms === null) {
  console.log('未设置 DSH_PRIVATE_TERMS —— 按设计跳过私有词扫描（CI 无需接触这些词）。')
  process.exit(0)
}
if (terms.length === 0) {
  console.error('✗ DSH_PRIVATE_TERMS 已设置但词表为空 —— 空词表会让本步骤变成形式主义。')
  process.exit(1)
}

const hits = []
for (const [path, text] of contents) {
  const lines = text.split(/\r?\n/)
  for (const term of terms) {
    lines.forEach((line, index) => {
      if (line.includes(term)) {
        hits.push({ file: relative(ROOT, path), line: index + 1, term })
      }
    })
  }
}

if (hits.length > 0) {
  console.error(`\n✗ 命中 ${hits.length} 处私有词：`)
  for (const hit of hits) {
    console.error(`  · ${hit.file}:${hit.line}  ← ${hit.term}`)
  }
  console.error('\n这些内容不得进入公开仓库 / 发布包。')
  process.exit(1)
}

console.log(`✓ 私有词 ${terms.length} 个，零命中（控制组已证明扫描有效）`)
