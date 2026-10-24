/**
 * 解析层：纯函数，零 I/O。
 *
 * 这里集中处理三类"看起来是字符串细节、实际是安全边界"的解析：
 *   1. 上游主机名（必须拒掉"host:port" 混写、必须把 IDN 归一到 punycode）
 *   2. CONNECT 目标命令（IPv4 / 带方括号的 IPv6 / 域名 三分法，禁止冒号判断）
 *   3. CONNECT 上游响应（必须完整解析状态行，不能见 \r\n\r\n 就当成功）
 *
 * @module dsh-proxy-egress/parse
 */

import net from 'node:net'

export const MAX_PORT = 65535

/** 逐跳头（RFC 7230 §6.1）+ 代理专有头。这些东西绝不能原样转发。 */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function bad(field, message) {
  return { ok: false, error: { field, message } }
}

/**
 * 归一化"上游主机名"，**不含端口**。
 *
 * 规则（对应需求文档 V1/V4）：
 *   - 不写协议前缀
 *   - IPv6 必须用 [..] 包起来：`[2001:db8::1]`。裸 IPv6 一律拒绝——否则
 *     无法区分 `2001:db8::1:8080` 到底是地址还是"地址:端口"。
 *   - 域名里出现冒号 ⇒ 一定是把 host:port 写混了，直接拒绝并给出可执行提示。
 *   - 域名做 IDN→punycode 归一，并小写、去掉尾点。
 *
 * @param {unknown} raw
 * @param {string} [field]
 * @returns {{ok: true, value: string} | {ok: false, error: {field: string, message: string}}}
 */
export function normalizeUpstreamHost(raw, field = 'upstream.host') {
  if (typeof raw !== 'string') return bad(field, '必须是字符串')
  const text = raw.trim()
  if (text === '') return bad(field, '不能为空')
  if (text.includes('://')) return bad(field, '不要写协议前缀（http:// 等），只写主机名或 IP')
  if (/[/?#@\s]/.test(text)) return bad(field, '不能包含空格或 / ? # @')

  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return bad(field, 'IPv6 地址必须写成 [地址]，端口另写在 upstream.port')
    const inner = text.slice(1, -1)
    if (net.isIP(inner) !== 6) return bad(field, `[${inner}] 不是合法的 IPv6 地址`)
    return { ok: true, value: inner }
  }

  if (net.isIP(text) === 6) {
    return bad(field, `IPv6 请写成 [${text}]（加方括号），否则无法与"主机:端口"区分`)
  }
  if (net.isIP(text) === 4) return { ok: true, value: text }

  if (text.includes(':')) {
    const hint = text.slice(0, text.lastIndexOf(':'))
    return bad(field, `这里只写主机名，不要带端口。端口请写到 upstream.port（疑似想写：host=${hint}）`)
  }

  let ascii
  try {
    ascii = new URL(`http://${text}`).hostname
  } catch {
    return bad(field, '不是合法的主机名')
  }
  if (ascii === '') return bad(field, '不是合法的主机名')
  return { ok: true, value: ascii.replace(/\.$/, '').toLowerCase() }
}

/**
 * 解析 CONNECT 的请求目标 `host:port`。
 *
 * 三分法（绝不用"含冒号就是端口"这种判断）：
 *   - `[2001:db8::1]:443` → host=`2001:db8::1`, port=443
 *   - `1.2.3.4:443`       → host=`1.2.3.4`, port=443
 *   - `api.x.com:443`     → host=`api.x.com`, port=443
 *
 * @param {unknown} authority
 * @returns {{ok: true, value: {host: string, port: number}} | {ok: false, error: {field: string, message: string}}}
 */
export function parseHostPort(authority, field = 'connect.target') {
  if (typeof authority !== 'string') return bad(field, '请求目标必须是字符串')
  const text = authority.trim()
  if (text === '') return bad(field, '请求目标不能为空')

  let host
  let portText

  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close === -1) return bad(field, 'IPv6 目标缺少右方括号')
    host = text.slice(1, close)
    if (net.isIP(host) !== 6) return bad(field, '方括号内不是合法 IPv6 地址')
    const after = text.slice(close + 1)
    if (!after.startsWith(':')) return bad(field, 'IPv6 目标必须写成 [地址]:端口')
    portText = after.slice(1)
  } else {
    const idx = text.lastIndexOf(':')
    if (idx === -1) return bad(field, '目标必须写成 主机:端口')
    host = text.slice(0, idx)
    portText = text.slice(idx + 1)
    if (host.includes(':')) return bad(field, 'IPv6 目标必须写成 [地址]:端口')
    if (host === '') return bad(field, '目标主机为空')
  }

  if (!/^\d{1,5}$/.test(portText)) return bad(field, `端口不是十进制数字：${portText}`)
  const port = Number(portText)
  if (port < 1 || port > MAX_PORT) return bad(field, `端口超出范围：${port}`)

  // 目标主机不在这里做"必须是域名"的强校验：CONNECT 允许直连 IP。
  // 但绝不允许空、不允许空白字符。
  if (/[\s/]/.test(host)) return bad(field, '目标主机含非法字符')

  return { ok: true, value: { host, port } }
}

/**
 * 找到 HTTP 头结束位置（`\r\n\r\n` 之后的下标）。找不到返回 -1。
 * @param {Buffer} buffer
 * @returns {number}
 */
export function findHeaderEnd(buffer) {
  return buffer.indexOf('\r\n\r\n')
}

/**
 * 从 CONNECT 上游响应头里取状态码。
 *
 * 必须严格匹配状态行；解析不出来返回 null（调用方按失败处理），
 * 绝不"看到头结束就认为成功"。
 *
 * @param {string} headText 拉丁1 解码后的响应头文本
 * @returns {number | null}
 */
export function parseConnectStatus(headText) {
  if (typeof headText !== 'string' || headText === '') return null
  const line = headText.split('\r\n', 1)[0]
  const match = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?$/.exec(line)
  if (match === null) return null
  return Number(match[1])
}

/**
 * 逐跳头剥离 + 可选移除代理认证头。
 *
 * @param {Record<string, unknown>} headers
 * @param {{dropAuth?: boolean}} [options]
 * @returns {Record<string, string | string[]>}
 */
export function filterHeaders(headers, options = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (options.dropAuth === true && lower === 'proxy-authorization') continue
    out[lower] = /** @type {string | string[]} */ (value)
  }
  return out
}

/**
 * 构造 Basic 认证头的值。凭据**只在这里短暂出现于内存**。
 *
 * RFC 7617：用户名不得含冒号；密码逐字使用（**不做 trim**，trim 会改写有效凭据）。
 *
 * @param {string} username
 * @param {string} password
 * @returns {string} `Basic <base64>`
 */
export function buildBasicAuth(username, password) {
  if (typeof username !== 'string' || username === '') throw new TypeError('username 不能为空')
  if (username.includes(':')) throw new TypeError('username 不能包含冒号（RFC 7617）')
  if (typeof password !== 'string') throw new TypeError('password 必须是字符串')
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

/**
 * 回环判定：本插件只允许监听回环地址。
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}
