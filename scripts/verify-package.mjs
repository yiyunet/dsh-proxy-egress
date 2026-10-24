#!/usr/bin/env node
/**
 * 发布契约断言（P4）。
 *
 * 规则：**每条断言都必须对应一个真实失败模式**，否则就是形式主义。
 * 下面每条都写了「不查它会怎样」，写不出后果的断言不该存在。
 *
 * 运行：npm run verify
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const failures = []
const notes = []

function check(label, condition, consequence, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push({ label, consequence, detail })
  console.log(`  ✗ ${label}`)
  if (detail !== undefined) console.log(`      ${detail}`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 递归列出 `files` 白名单会打进包的所有文件（只处理白名单里的顶层条目）。 */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const pkg = await readJson(join(ROOT, 'package.json'))
const files = Array.isArray(pkg.files) ? pkg.files : []

console.log('契约断言：')

// ── A1 能被发布 ─────────────────────────────────────────────────────────────
// 不查：`private: true` 会让 npm publish 直接拒绝，而 link:' 装载时完全看不出来。
check('package.json 不是 private', pkg.private !== true,
  'private:true 时 npm publish 被拒，但本地 link: 装载一切正常，直到发布当天才发现')

// ── A2 入口真实存在 ─────────────────────────────────────────────────────────
// 不查：main/exports 指向不存在的文件时，装到别人机器上插件直接加载不了（B6）。
for (const [field, target] of [
  ['main', pkg.main],
  ['exports["."]', pkg.exports?.['.']],
  ['exports["./client"]', pkg.exports?.['./client']],
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
]) {
  if (typeof target !== 'string') {
    check(`${field} 有声明`, false, '缺少入口声明，宿主无法加载插件')
    continue
  }
  const path = join(ROOT, target)
  check(`${field} → ${target} 存在`, await exists(path),
    '入口指向不存在的文件：消费者安装后插件加载失败')
}

// ── A3 白名单自洽（B1/B2）────────────────────────────────────────────────────
// 不查：files 漏掉入口所在目录时，本地（link:）一切正常，消费者 npm install 后加载失败。
// 关键点：`link:` 装载**完全不读 files**，所以这个缺陷在开发机上永远看不见。
const required = new Set()
for (const target of [pkg.main, pkg.exports?.['.'], pkg.exports?.['./client'], pkg.dsh?.bundle?.patch]) {
  if (typeof target === 'string') required.add(target.replace(/^\.\//, '').split('/')[0])
}
for (const entry of required) {
  check(`files 白名单覆盖 "${entry}"`, files.includes(entry),
    `"${entry}" 是运行时必需的顶层条目，却在 files 白名单之外：发布包会缺文件`)
}
check('files 白名单非空', files.length > 0, 'files 为空时 npm 会按 .gitignore 推断，产物不可预测')

// ── A4 不声明安装期脚本（B7）────────────────────────────────────────────────
// 不查：pnpm 10+ 会拦截 postinstall，**消费者安装直接失败**；本地 npm install 看不见。
const LIFECYCLE = ['preinstall', 'install', 'postinstall']
const declared = LIFECYCLE.filter((name) => pkg.scripts?.[name] !== undefined)
check(`未声明安装期脚本（${LIFECYCLE.join('/')}）`, declared.length === 0,
  'pnpm 10+ 会拦截安装期脚本，消费者 npm/pnpm install 直接失败', declared.join(', '))

// prepublishOnly 是好事，但必须真的能跑
check('声明了 prepublishOnly（发布前自检）', pkg.scripts?.prepublishOnly !== undefined,
  '没有发布前自检，坏产物可能被直接推上 registry')

// ── A5 装载行与包名一致 ─────────────────────────────────────────────────────
// 不查：cordis.patch.yml 里的 name 写错（例如沿用旧包名）时，宿主解析不到模块，
// 表现是"插件行加载失败"，且错误信息离真正原因很远。
const patchText = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
const rows = [...patchText.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((match) => match[1])
check('cordis.patch.yml 的 name 与包名一致',
  rows.length === 1 && rows[0] === pkg.name,
  '装载行的 name 与 package.json name 不一致：宿主按说明符解析不到这个包',
  `patch 里读到：${rows.join(', ') || '（无）'}；包名：${pkg.name}`)
const rowIds = [...patchText.matchAll(/^\s*- id:\s*(\S+)/gm)].map((match) => match[1])
check('装载行恰好一行、且有 id',
  rowIds.length === 1 && rowIds[0] !== '',
  '多行或少行会让宿主出现重复 id 或空行')

// ── A6 客户端半侧契约 ───────────────────────────────────────────────────────
// 不查：id 写错 / 引了平台表外的模块时，**整个 /plugins 拼接 bundle 全灭**，
// 症状还会报在别的插件上（例如 client-connection 未注册）。
check('dsh.client.platform 是 web', pkg.dsh?.client?.platform === 'web',
  '平台不匹配时客户端半侧不会被加载')
check('dsh.client.inject 非空', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
  '没有 inject 列表时客户端模块可能缺依赖而加载失败')
const clientPath = join(ROOT, pkg.exports?.['./client'] ?? '')
if (await exists(clientPath)) {
  const client = await readFile(clientPath, 'utf8')
  check('客户端以 __ModuleLoader__.load 注册', client.includes('window.__ModuleLoader__.load'),
    '不是官方装载器格式：浏览器侧不会注册这个模块')
  const idMatch = /id:\s*'([^']+)'/.exec(client)
  check('装载器 id 等于包名', idMatch !== null && idMatch[1] === pkg.name,
    '装载器 id 必须是包名，否则加载器无法把它匹配到 Loader 行',
    idMatch === null ? '（没读到 id）' : `读到：${idMatch[1]}`)
  const badRequires = [...client.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('react'))
  check('客户端只 require react 系', badRequires.length === 0,
    '平台冻结模块表只保证 react / react-dom；引其它模块会在浏览器里加载失败',
    badRequires.join(', '))
}

// ── A7 发布包里不得出现凭据形态的串 ─────────────────────────────────────────
// 不查：文档里举例时写了一个"像真的"账密地址，就会被原样打进包并永久留在 registry。
const shipped = []
for (const entry of files) {
  const path = join(ROOT, entry)
  if (!await exists(path)) continue
  const info = await stat(path)
  if (info.isDirectory()) shipped.push(...await walk(path))
  else shipped.push(path)
}
check('白名单能枚举出文件', shipped.length > 0, '枚举不到任何文件：白名单写错了')

const SUSPICIOUS = [
  // 刻意排除尖括号：文档里用 `http://<账号>:<密码>@<主机>` 这种占位符是**正确写法**，
  // 不该被自己的断言误报。真实凭据几乎不含 <>。
  { name: 'url 内嵌账密', re: /[a-z]+:\/\/[^\s/@:'"<>]+:[^\s/@'"<>]+@[^\s/<>]+/i },
  { name: '疑似真实令牌', re: /\bnpm_[A-Za-z0-9]{30,}/ },
]
const hits = []
for (const path of shipped) {
  if (!/\.(mjs|js|json|yml|md)$/.test(path)) continue
  const text = await readFile(path, 'utf8')
  for (const rule of SUSPICIOUS) {
    if (rule.re.test(text)) hits.push(`${relative(ROOT, path)}: ${rule.name}`)
  }
}
check('发布文件里没有凭据形态的串', hits.length === 0,
  '凭据一旦进了发布包就会永久留在 registry 上', hits.join('\n      '))
notes.push(`扫描文件数：${shipped.length}（这个数字必须 > 0，否则"零命中"没有意义）`)

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('')
for (const note of notes) console.log(`· ${note}`)

if (failures.length > 0) {
  console.log('')
  console.error(`✗ 契约断言未通过 ${failures.length} 条：`)
  for (const failure of failures) {
    console.error(`  · ${failure.label}`)
    console.error(`      后果：${failure.consequence}`)
    if (failure.detail) console.error(`      实况：${failure.detail}`)
  }
  process.exit(1)
}
console.log('\n✓ 契约断言全部通过')
