/**
 * 配置层：把装载行里的 config 归一化 + 校验。
 *
 * 设计选择——**不导出 cordis 的 `Config` schema，改在 apply() 里自己校验**：
 *   1. 零运行时依赖：不必去赌 `@deepseek-ai/schemastery` 在这个装载路径下能否裸导入；
 *   2. 报错可执行：schema 报的是"某字段不符合 pattern"，这里报的是"你把端口写进主机名了，
 *      应该写到 upstream.port"——出问题的人不是写代码的人；
 *   3. 失败即不启动：任何一条不通过，本插件不监听任何端口（V6：宁可不可用，不做默认兜底）。
 *
 * @module dsh-proxy-egress/config
 */

import { normalizeUpstreamHost, isLoopback } from './parse.mjs'

/** 不提供、且永远不会提供的开关。写了就报错，而不是默默忽略。 */
const FORBIDDEN_KEYS = {
  allowDirectFallback: '本插件不提供直连降级开关：上游不通时一律断联',
  fallbackDirect: '本插件不提供直连降级开关：上游不通时一律断联',
  directFallback: '本插件不提供直连降级开关：上游不通时一律断联',
  retryDirect: '本插件不提供直连降级开关：上游不通时一律断联',
}

export const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8899 },
  upstream: { type: 'http' },
  credentialSource: 'config',
  allowConnectPorts: [443],
  expectedEgressIps: [],
  egressMismatchAction: 'warn',
  handshakeTimeoutMs: 15000,
  maxHeaderBytes: 16384,
  selfCheck: {
    enabled: true,
    url: 'https://api.ipify.org?format=json',
    timeoutMs: 12000,
  },
}

function fail(errors, field, message) {
  errors.push({ field, message })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 归一化并校验配置。
 *
 * @param {unknown} raw 装载行的 config
 * @returns {{ok: true, value: object, warnings: string[]} | {ok: false, errors: {field: string, message: string}[]}}
 */
export function normalizeConfig(raw) {
  /** @type {{field: string, message: string}[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  const input = isPlainObject(raw) ? raw : {}

  if (raw !== undefined && !isPlainObject(raw)) {
    fail(errors, 'config', '插件 config 必须是一个映射对象')
    return { ok: false, errors }
  }

  for (const [key, message] of Object.entries(FORBIDDEN_KEYS)) {
    if (key in input) fail(errors, key, message)
  }

  // ── 监听地址 ────────────────────────────────────────────────────────────
  const listenIn = isPlainObject(input.listen) ? input.listen : {}
  const listenHost = typeof listenIn.host === 'string' && listenIn.host !== ''
    ? listenIn.host.trim()
    : DEFAULTS.listen.host
  if (!isLoopback(listenHost)) {
    fail(errors, 'listen.host', `只允许监听回环地址（127.0.0.1 / ::1 / localhost），收到：${listenHost}。`
      + '把带认证的本地代理暴露到局域网，等于把你的上游账号送人。')
  }
  const listenPort = listenIn.port === undefined ? DEFAULTS.listen.port : Number(listenIn.port)
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    fail(errors, 'listen.port', `必须是 1-65535 的整数，收到：${String(listenIn.port)}`)
  }

  // ── 上游 ────────────────────────────────────────────────────────────────
  const upstreamIn = isPlainObject(input.upstream) ? input.upstream : {}
  const upstreamType = upstreamIn.type === undefined ? DEFAULTS.upstream.type : String(upstreamIn.type)
  if (upstreamType !== 'http' && upstreamType !== 'https') {
    fail(errors, 'upstream.type', `只支持 http / https，收到：${upstreamType}（SOCKS5 尚未实现）`)
  }
  const hostResult = normalizeUpstreamHost(upstreamIn.host, 'upstream.host')
  let upstreamHost = ''
  if (hostResult.ok) upstreamHost = hostResult.value
  else errors.push(hostResult.error)

  const upstreamPort = upstreamIn.port === undefined ? NaN : Number(upstreamIn.port)
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    fail(errors, 'upstream.port', `必须显式写 1-65535 的整数端口，收到：${String(upstreamIn.port)}`)
  }

  // ── 凭据 ────────────────────────────────────────────────────────────────
  const credentialSource = input.credentialSource === undefined
    ? DEFAULTS.credentialSource
    : String(input.credentialSource)
  if (credentialSource !== 'config' && credentialSource !== 'file') {
    fail(errors, 'credentialSource', `只支持 config / file，收到：${credentialSource}`)
  }

  let username
  let password
  let credentialFile
  if (credentialSource === 'config') {
    const hasUser = typeof upstreamIn.username === 'string' && upstreamIn.username !== ''
    const hasPass = typeof upstreamIn.password === 'string' && upstreamIn.password !== ''
    if (hasUser !== hasPass) {
      fail(errors, 'upstream.username', 'username 与 password 必须同时提供，或同时留空（留空 = 上游无需认证）')
    }
    if (hasUser && hasPass) {
      // 密码逐字使用：不 trim、不改写、不归一化。
      if (upstreamIn.username.includes(':')) {
        fail(errors, 'upstream.username', 'username 不能包含冒号（HTTP Basic 认证的限制）')
      }
      username = upstreamIn.username
      password = upstreamIn.password
    }
    if (typeof input.credentialFile === 'string' && input.credentialFile !== '') {
      warnings.push('credentialSource=config 时 credentialFile 被忽略')
    }
  } else {
    credentialFile = typeof input.credentialFile === 'string' ? input.credentialFile.trim() : ''
    if (credentialFile === '') {
      fail(errors, 'credentialFile', 'credentialSource=file 时必须提供凭据文件绝对路径')
    } else if (!/^[A-Za-z]:[\\/]|^\//.test(credentialFile)) {
      fail(errors, 'credentialFile', '必须是绝对路径（Windows 形如 D:\\keys\\proxy.json）')
    }
    if ('username' in upstreamIn || 'password' in upstreamIn) {
      warnings.push('credentialSource=file 时 upstream.username / upstream.password 被忽略；'
        + '若这两项正以明文存放在 profile patch 里，建议把它们删掉')
    }
  }

  // ── CONNECT 端口白名单（不设白名单 = 开放 TCP 转发器）────────────────────
  let allowConnectPorts = DEFAULTS.allowConnectPorts
  if (input.allowConnectPorts !== undefined) {
    if (!Array.isArray(input.allowConnectPorts) || input.allowConnectPorts.length === 0) {
      fail(errors, 'allowConnectPorts', '必须是非空整数数组（例如 [443]）；留空会退化成任意 TCP 转发')
    } else {
      const ports = input.allowConnectPorts.map(Number)
      const invalid = ports.filter((port) => !Number.isInteger(port) || port < 1 || port > 65535)
      if (invalid.length > 0) {
        fail(errors, 'allowConnectPorts', `含非法端口：${invalid.join(', ')}`)
      } else {
        allowConnectPorts = [...new Set(ports)].sort((a, b) => a - b)
      }
    }
  }

  // ── 出口 IP 钉定 ────────────────────────────────────────────────────────
  let expectedEgressIps = DEFAULTS.expectedEgressIps
  if (input.expectedEgressIps !== undefined) {
    if (!Array.isArray(input.expectedEgressIps)) {
      fail(errors, 'expectedEgressIps', '必须是字符串数组')
    } else {
      const list = input.expectedEgressIps
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim())
      const invalid = list.filter((item) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(item) && !item.includes(':'))
      if (invalid.length > 0) {
        fail(errors, 'expectedEgressIps', `含非法 IP：${invalid.join(', ')}（暂只支持 IPv4 与 IPv6 字面量）`)
      } else {
        expectedEgressIps = list
      }
    }
  }
  const egressMismatchAction = input.egressMismatchAction === undefined
    ? DEFAULTS.egressMismatchAction
    : String(input.egressMismatchAction)
  if (egressMismatchAction !== 'warn' && egressMismatchAction !== 'block') {
    fail(errors, 'egressMismatchAction', `只支持 warn / block，收到：${egressMismatchAction}`)
  }
  if (expectedEgressIps.length === 0 && egressMismatchAction === 'block') {
    warnings.push('egressMismatchAction=block 但 expectedEgressIps 为空：没有任何可比对的出口，block 不会触发')
  }

  // ── 自检 ────────────────────────────────────────────────────────────────
  const selfCheckIn = isPlainObject(input.selfCheck) ? input.selfCheck : {}
  const selfCheck = {
    enabled: selfCheckIn.enabled === undefined ? DEFAULTS.selfCheck.enabled : selfCheckIn.enabled === true,
    url: typeof selfCheckIn.url === 'string' && selfCheckIn.url !== '' ? selfCheckIn.url : DEFAULTS.selfCheck.url,
    timeoutMs: Number.isFinite(Number(selfCheckIn.timeoutMs)) && Number(selfCheckIn.timeoutMs) > 0
      ? Number(selfCheckIn.timeoutMs)
      : DEFAULTS.selfCheck.timeoutMs,
  }
  if (selfCheck.enabled) {
    try {
      const parsed = new URL(selfCheck.url)
      if (parsed.protocol !== 'https:') {
        warnings.push(`自检 URL 不是 https（${parsed.protocol}）：出口 IP 会以明文经过上游，建议换 https 回显服务`)
      }
    } catch {
      fail(errors, 'selfCheck.url', '不是合法 URL')
    }
  }

  const handshakeTimeoutMs = Number(input.handshakeTimeoutMs) > 0
    ? Number(input.handshakeTimeoutMs)
    : DEFAULTS.handshakeTimeoutMs
  const maxHeaderBytes = Number(input.maxHeaderBytes) > 0
    ? Math.min(Number(input.maxHeaderBytes), 65536)
    : DEFAULTS.maxHeaderBytes

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    warnings,
    value: {
      listen: { host: listenHost === 'localhost' ? '127.0.0.1' : listenHost, port: listenPort },
      upstream: {
        type: upstreamType,
        host: upstreamHost,
        port: upstreamPort,
        ...(username === undefined ? {} : { username, password }),
      },
      credentialSource,
      ...(credentialFile === undefined ? {} : { credentialFile }),
      allowConnectPorts,
      expectedEgressIps,
      egressMismatchAction,
      handshakeTimeoutMs,
      maxHeaderBytes,
      selfCheck,
    },
  }
}

/**
 * 给状态展示用的**脱敏**视图：不含凭据、不含完整路径。
 * @param {object} value normalizeConfig 的产出的配置（或 null）
 * @returns {object}
 */
export function describeConfig(value) {
  if (value === null || value === undefined) return { ok: false }
  return {
    ok: true,
    listen: `${value.listen.host}:${value.listen.port}`,
    upstream: {
      type: value.upstream.type,
      host: value.upstream.host,
      port: value.upstream.port,
      // 这里**不再**报 credentialConfigured：它只表示"配置里有没有写账号密码"，
      // credentialSource=file 时永远是 false，会被误读成"凭据没加载"。
      // 权威的凭据状态在 status.credential 里（configured / source / fingerprint）。
    },
    credentialSource: value.credentialSource,
    allowConnectPorts: value.allowConnectPorts,
    expectedEgressIps: value.expectedEgressIps,
    egressMismatchAction: value.egressMismatchAction,
    selfCheck: value.selfCheck,
  }
}
