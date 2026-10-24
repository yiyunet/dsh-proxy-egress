/**
 * 凭据层测试。
 *
 * 这里守的是**泄漏面**：凭据文件只允许两个键、密码逐字不加工、返回值里只有指纹。
 * 另外把 UTF-8 BOM 也钉住 —— 它是「文件内容完全正确却报不是合法 JSON」的经典元凶
 * （Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM）。
 *
 * 运行：node --test test/credentials.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  credentialFileBody,
  credentialFingerprint,
  CredentialError,
  parseCredentialInput,
  readCredentialFile,
  resolveCredentials,
} from '../plugin-src/host/credentials.mjs'

async function withTempFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-proxy-egress-'))
  const file = join(dir, 'cred.json')
  try {
    if (content !== undefined) await writeFile(file, content, 'utf8')
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── 面板输入校验 ────────────────────────────────────────────────────────────
test('输入校验：空账号或空密码一律拒绝', () => {
  assert.equal(parseCredentialInput({ username: '', password: 'p' }).ok, false)
  assert.equal(parseCredentialInput({ username: 'u', password: '' }).ok, false)
  assert.equal(parseCredentialInput({}).ok, false)
  assert.equal(parseCredentialInput(null).ok, false)
  assert.equal(parseCredentialInput('u:p').ok, false)
})

test('输入校验：账号不能含冒号（HTTP Basic 的限制）', () => {
  const result = parseCredentialInput({ username: 'u:1', password: 'p' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'USERNAME_HAS_COLON')
})

test('输入校验：密码逐字保留，不 trim 不改写', () => {
  const result = parseCredentialInput({ username: 'u1', password: '  p 1 ' })
  assert.equal(result.ok, true)
  assert.equal(result.value.password, '  p 1 ')
})

test('输入校验：多余字段被忽略，不会带进结果', () => {
  const result = parseCredentialInput({ username: 'u', password: 'p', extra: 'x', token: 'y' })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.value).sort(), ['password', 'username'])
})

// ── 落盘形态 ────────────────────────────────────────────────────────────────
test('凭据文件体：只有 username / password 两个键', () => {
  const body = credentialFileBody('u1', 'p1')
  assert.deepEqual(JSON.parse(body), { username: 'u1', password: 'p1' })
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['password', 'username'])
})

test('凭据文件体：含引号/反斜杠/中文的密码能被 JSON 正确往返', () => {
  const nasty = 'p"a\\s,s\u4e2d \t'
  const parsed = JSON.parse(credentialFileBody('u1', nasty))
  assert.equal(parsed.password, nasty)
})

test('指纹：稳定、8 位、随输入变化', () => {
  const a = credentialFingerprint('u', 'p')
  assert.equal(a, credentialFingerprint('u', 'p'))
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.notEqual(a, credentialFingerprint('u', 'p2'))
  assert.notEqual(a, credentialFingerprint('u2', 'p'))
})

// ── 读文件 ──────────────────────────────────────────────────────────────────
test('读文件：正常内容可解析', async () => {
  await withTempFile('{"username":"u","password":"p"}', async (file) => {
    const value = await readCredentialFile(file)
    assert.deepEqual(value, { username: 'u', password: 'p' })
  })
})

test('读文件：容忍 UTF-8 BOM（PowerShell 5.1 的经典坑）', async () => {
  await withTempFile('\uFEFF{"username":"u","password":"p"}', async (file) => {
    const value = await readCredentialFile(file)
    assert.deepEqual(value, { username: 'u', password: 'p' })
  })
})

test('读文件：内容坏了要给出可执行的错误码', async () => {
  await withTempFile('{not json', async (file) => {
    await assert.rejects(readCredentialFile(file), (error) => {
      assert.ok(error instanceof CredentialError)
      assert.equal(error.code, 'CREDENTIAL_FILE_INVALID_JSON')
      assert.match(error.message, /编码/)
      return true
    })
  })
})

test('读文件：文件不存在 → CREDENTIAL_FILE_UNREADABLE（不抛裸 ENOENT）', async () => {
  await withTempFile(undefined, async (file) => {
    await assert.rejects(readCredentialFile(file), (error) => {
      assert.equal(error.code, 'CREDENTIAL_FILE_UNREADABLE')
      return true
    })
  })
})

test('读文件：缺字段要指名道姓', async () => {
  await withTempFile('{"username":"u"}', async (file) => {
    await assert.rejects(readCredentialFile(file), (error) => {
      assert.equal(error.code, 'CREDENTIAL_FILE_MISSING_PASSWORD')
      return true
    })
  })
})

// ── 组装 ────────────────────────────────────────────────────────────────────
test('解析凭据：config 模式未写账号 → 返回 null（上游无需认证）', async () => {
  const value = await resolveCredentials({ credentialSource: 'config', upstream: {} })
  assert.equal(value, null)
})

test('解析凭据：config 模式带账号 → 带指纹，不含明文以外的信息', async () => {
  const value = await resolveCredentials({ credentialSource: 'config', upstream: { username: 'u', password: 'p' } })
  assert.equal(value.source, 'config')
  assert.equal(value.fingerprint, credentialFingerprint('u', 'p'))
  assert.deepEqual(Object.keys(value).sort(), ['fingerprint', 'password', 'source', 'username'])
})

test('解析凭据：file 模式读文件并给出指纹', async () => {
  await withTempFile('{"username":"u","password":"p"}', async (file) => {
    const value = await resolveCredentials({ credentialSource: 'file', credentialFile: file })
    assert.equal(value.source, 'file')
    assert.equal(value.username, 'u')
    assert.equal(value.password, 'p')
    assert.equal(value.fingerprint, credentialFingerprint('u', 'p'))
  })
})
