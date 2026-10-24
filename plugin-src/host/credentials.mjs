/**
 * 凭据层：把"凭据从哪来"收敛到唯一一处。
 *
 * 铁律：
 *   1. 凭据**只在这里**变成内存里的两个字符串，之后只在构建 Basic 头时被用到；
 *   2. 任何返回值、日志、工具输出、错误消息里都不出现 password，也不出现完整 username；
 *   3. 对外只暴露一个**指纹**（sha256 前 8 位）——足够让人确认"当前加载的是哪一份凭据"，
 *      又不足以反推；
 *   4. 密码逐字使用：不 trim、不改写（trim 会把带首尾空格的合法密码改坏）。
 *
 * @module dsh-proxy-egress/credentials
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export class CredentialError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/**
 * 指纹：只用于"同一份凭据？"这种自检，不可反推。
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
export function credentialFingerprint(username, password) {
  return createHash('sha256').update(`${username}\u0000${password}`, 'utf8').digest('hex').slice(0, 8)
}

/**
 * 从独立的 JSON 文件读凭据。文件格式：{ "username": "...", "password": "..." }
 * @param {string} filePath
 * @returns {Promise<{username: string, password: string}>}
 */
export async function readCredentialFile(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new CredentialError('CREDENTIAL_FILE_UNREADABLE',
      `凭据文件读不到：${filePath}（${error?.code ?? String(error?.message ?? error)}）`)
  }

  // Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写出带 BOM 的 UTF-8。
  // BOM 会让 JSON.parse 直接抛错，而文件内容其实是对的 —— 这里替使用者兜住。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CredentialError('CREDENTIAL_FILE_INVALID_JSON',
      `凭据文件不是合法 JSON：${filePath}（若内容看起来正确，多半是编码问题：请存成 UTF-8 无 BOM）`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialError('CREDENTIAL_FILE_INVALID_SHAPE', '凭据文件必须是 {"username":"..","password":".."} 形式')
  }
  const username = parsed.username
  const password = parsed.password
  if (typeof username !== 'string' || username === '') {
    throw new CredentialError('CREDENTIAL_FILE_MISSING_USERNAME', '凭据文件缺少非空字符串 username')
  }
  if (typeof password !== 'string' || password === '') {
    throw new CredentialError('CREDENTIAL_FILE_MISSING_PASSWORD', '凭据文件缺少非空字符串 password')
  }
  if (username.includes(':')) {
    throw new CredentialError('CREDENTIAL_USERNAME_HAS_COLON', 'username 不能包含冒号（HTTP Basic 认证的限制）')
  }
  return { username, password }
}

/**
 * 解析本次启动要用的凭据。
 *
 * @param {object} config normalizeConfig 的产出
 * @returns {Promise<null | {username: string, password: string, source: 'config'|'file', fingerprint: string}>}
 *         返回 null 表示上游无需认证。
 */
export async function resolveCredentials(config) {
  if (config.credentialSource === 'config') {
    const { username, password } = config.upstream
    if (username === undefined || password === undefined) return null
    return { username, password, source: 'config', fingerprint: credentialFingerprint(username, password) }
  }

  const { username, password } = await readCredentialFile(config.credentialFile)
  return { username, password, source: 'file', fingerprint: credentialFingerprint(username, password) }
}

/**
 * 校验面板提交的凭据输入。
 *
 * **纯函数**：不读文件、不写文件、不碰网络 —— 因此可以单测，
 * 也保证"校验"和"落盘"两件事不会被搅在一起。
 *
 * @param {unknown} payload
 * @returns {{ok: true, value: {username: string, password: string}}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function parseCredentialInput(payload) {
  const record = payload !== null && typeof payload === 'object' ? payload : {}
  const username = typeof record.username === 'string' ? record.username : ''
  const password = typeof record.password === 'string' ? record.password : ''
  if (username === '' || password === '') {
    return { ok: false, error: { code: 'EMPTY_FIELD', message: '账号与密码都必须非空' } }
  }
  if (username.includes(':')) {
    return { ok: false, error: { code: 'USERNAME_HAS_COLON', message: '账号不能包含冒号（HTTP Basic 的限制）' } }
  }
  // 密码逐字保留：不 trim、不转义、不做任何"友好化"改写。
  return { ok: true, value: { username, password } }
}

/**
 * 凭据文件的**唯一**序列化形态：只允许 username / password 两个键。
 *
 * 单独抽出来是为了能被断言 —— 将来谁往这里多加一个字段（比如为了调试塞个 source），
 * 就等于多开一处泄漏面，测试会立刻红。
 *
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
export function credentialFileBody(username, password) {
  return JSON.stringify({ username, password })
}
