/**
 * 验收层：三类检查，各自回答不同的问题，**互不代替**。
 *
 *   代理链路检查 ── 现在这条链路的出口 IP 是多少？和期望一致吗？
 *   故障注入检查 ── 上游坏掉时，本插件会不会偷偷直连？（本插件自身行为的回归护栏）
 *   消费方接入检查 ── 消费方是不是真的把请求交给了本地监听？（本插件管不了，只能取证）
 *
 * 一次检查只能证明"某版本、某配置、某次调用"的行为，不能替代持续生效的网络约束。
 *
 * @module dsh-proxy-egress/verify
 */

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

import { createEgressProxy } from './proxy.mjs'

const MAX_BODY_BYTES = 64 * 1024

/** 每个失败码配一句「下一步该查什么」，避免把人引向错误方向。 */
const SELF_CHECK_HINT = {
  LISTENER_DOWN: '本地监听没起来：看 proxy_egress_status 的 state 与 lastError（常见是端口被占或凭据没读到）。',
  UPSTREAM_UNREACHABLE: '连不上上游：查 upstream.host / port，以及这台上游是否需要先加白名单。',
  UPSTREAM_AUTH_FAILED: '上游拒绝认证（401/407）：凭据文件里的账号密码不对，或改了文件没 restart。'
    + '这是最常见的一类——链路本身已经通了。',
  UPSTREAM_REJECTED: '上游拒绝了这次 CONNECT。若 upstreamStatus 是 403，可能是凭据问题，'
    + '也可能是代理侧的目标策略限制；其它 4xx 基本是策略问题。',
  UPSTREAM_MALFORMED_RESPONSE: '上游回的东西不是合法 HTTP 响应：可能端口指到了非代理服务。',
  TUNNEL_HANDSHAKE_TIMEOUT: '上游接了连接但不说话：可能被中间设备吞包，或该端口不是代理端口。',
  HANDSHAKE_HEADER_TOO_LARGE: '上游响应头异常大：同上，先确认端口对。',
  CONNECT_PORT_NOT_ALLOWED: '目标端口不在 allowConnectPorts：默认只放行 443。',
  PROXY_BLOCKED: '插件处于阻断态（出口 IP 不匹配等）：先看 proxy_egress_status 的 blocked.reason。',
  SELF_CONNECT_TIMEOUT: '连本地监听超时：插件可能卡在启动或正在 restart。',
  SELF_CONNECT_FAILED: '连本地监听失败：确认端口是 8899 且没有被别的程序占用。',
}

function withTimeout(promise, ms, code) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${code}：${ms}ms 超时`)
      error.code = code
      reject(error)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/**
 * 经本地监听发一个 CONNECT，拿回隧道 socket（或分类失败原因）。
 * @param {{host: string, port: number}} listen
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {number} timeoutMs
 */
function openTunnelThroughSelf(listen, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const req = http.request({
      host: listen.host,
      port: listen.port,
      method: 'CONNECT',
      path: net.isIP(targetHost) === 6 ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`,
      timeout: timeoutMs,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        const reason = res.headers['x-egress-reason']
        const rawStatus = res.headers['x-egress-upstream-status']
        const upstreamStatus = typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : null
        socket.destroy()
        finish({
          ok: false,
          reason: typeof reason === 'string' ? reason : `HTTP_${res.statusCode}`,
          upstreamStatus,
        })
        return
      }
      finish({ ok: true, socket })
    })
    req.on('timeout', () => {
      req.destroy()
      finish({ ok: false, reason: 'SELF_CONNECT_TIMEOUT' })
    })
    req.on('error', (error) => {
      const code = error?.code
      finish({ ok: false, reason: code === 'ECONNREFUSED' ? 'LISTENER_DOWN' : (code ?? 'SELF_CONNECT_FAILED') })
    })
    req.end()
  })
}

/**
 * 在一个已建立的隧道里做一次最小 HTTPS GET，返回响应体文本。
 * @param {import('node:net').Socket} socket
 * @param {string} host
 * @param {string} path
 * @param {number} timeoutMs
 */
async function httpsGetOverTunnel(socket, host, path, timeoutMs) {
  const secured = tls.connect({ socket, servername: host })
  await withTimeout(new Promise((resolve, reject) => {
    secured.once('secureConnect', () => resolve(undefined))
    secured.once('error', reject)
  }), timeoutMs, 'TLS_HANDSHAKE_TIMEOUT')

  secured.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: dsh-proxy-egress/selfcheck\r\nAccept: */*\r\nConnection: close\r\n\r\n`)

  return withTimeout(new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    secured.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        secured.destroy()
        reject(new Error('响应体过大'))
        return
      }
      chunks.push(chunk)
    })
    secured.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    secured.once('error', reject)
  }), timeoutMs, 'CHECK_SERVICE_TIMEOUT').finally(() => {
    try {
      secured.destroy()
    } catch {
      /* 已销毁 */
    }
  })
}

function extractIp(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of ['ip', 'origin', 'query']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
    }
  } catch {
    /* 不是 JSON，走正则 */
  }
  const body = typeof text === 'string' ? text : ''
  const v4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(body)
  if (v4 !== null) return v4[1]
  return null
}

/**
 * 代理链路检查：经本地监听 → 上游 → 回显服务，看**观测到的出口 IP**。
 *
 * 注意：它只能证明"访问这个回显服务时"的出口。上游若按目标分流，
 * 不能据此推论模型 API 走同一出口。
 *
 * @param {{snapshot: Function, applyEgressObservation: Function}} proxy
 * @param {object} config
 * @returns {Promise<object>}
 */
export async function runSelfCheck(proxy, config) {
  const startedAt = Date.now()
  const snap = proxy.snapshot()
  if (snap.state !== 'listening') {
    return { check: 'proxy-link', ok: false, result: 'LISTENER_DOWN', detail: `代理状态是 ${snap.state}`, durationMs: Date.now() - startedAt }
  }

  let url
  try {
    url = new URL(config.selfCheck.url)
  } catch {
    return { check: 'proxy-link', ok: false, result: 'CHECK_SERVICE_UNAVAILABLE', detail: 'selfCheck.url 不是合法 URL', durationMs: Date.now() - startedAt }
  }
  if (url.protocol !== 'https:') {
    return {
      check: 'proxy-link',
      ok: false,
      result: 'CHECK_SERVICE_UNAVAILABLE',
      detail: `只支持 https 回显（收到 ${url.protocol}）：明文回显会把出口 IP 送给上游`,
      durationMs: Date.now() - startedAt,
    }
  }

  const targetPort = url.port === '' ? 443 : Number(url.port)
  const tunnel = await openTunnelThroughSelf(config.listen, url.hostname, targetPort, config.selfCheck.timeoutMs)
  if (!tunnel.ok) {
    // 分类必须忠实：**原样透传**上游给出的原因码，绝不兜底成"不可达"。
    // （2026-10-12 实测：把 UPSTREAM_REJECTED 兜底成 UPSTREAM_UNREACHABLE，
    //   结果 result 与 detail 自相矛盾，会把人引向"查网络"这条错误路径。）
    const reason = tunnel.reason === 'ECONNREFUSED' ? 'LISTENER_DOWN' : tunnel.reason
    return {
      check: 'proxy-link',
      ok: false,
      result: reason,
      upstreamStatus: tunnel.upstreamStatus ?? null,
      detail: `隧道未建立：${reason}${tunnel.upstreamStatus === null ? '' : `（上游状态码 ${tunnel.upstreamStatus}）`}`,
      hint: SELF_CHECK_HINT[reason] ?? '看 detail 与 classify 码定位；本插件的每条失败都有明确分类。',
      durationMs: Date.now() - startedAt,
    }
  }

  try {
    const text = await httpsGetOverTunnel(tunnel.socket, url.hostname, `${url.pathname}${url.search}`, config.selfCheck.timeoutMs)
    const observed = extractIp(text)
    if (observed === null) {
      return {
        check: 'proxy-link',
        ok: false,
        result: 'CHECK_SERVICE_UNAVAILABLE',
        detail: '回显服务返回的内容里没解析出 IP（服务换了格式？）',
        durationMs: Date.now() - startedAt,
      }
    }
    const verdict = proxy.applyEgressObservation(observed)
    return {
      check: 'proxy-link',
      ok: verdict.matched === false ? false : true,
      result: verdict.matched === false ? 'EGRESS_IP_MISMATCH' : 'OK',
      observedEgressIp: observed,
      expectedEgressIps: config.expectedEgressIps,
      matched: verdict.matched,
      action: verdict.action,
      detail: verdict.matched === false
        ? `观测出口 ${observed} 不在期望列表里（策略：${config.egressMismatchAction}）`
        : (verdict.matched === null
          ? '未配置 expectedEgressIps：只报告观测值，不做比对'
          : `观测出口 ${observed} 与期望一致`),
      caveat: '本结果只代表访问该回显服务时的出口；上游若按目标分流，不能推论模型 API 同出口',
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      check: 'proxy-link',
      ok: false,
      result: 'CHECK_SERVICE_UNAVAILABLE',
      detail: `隧道已建立但回显请求失败：${error?.message ?? String(error)}`,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    try {
      tunnel.socket.destroy()
    } catch {
      /* 已销毁 */
    }
  }
}

/**
 * 故障注入检查：证明**本插件自身**在上游坏掉时不会直连目标。
 *
 * 手法：
 *   1. 开一个"诱饵" TCP 监听（bait），任何连到它的连接都会被计数；
 *   2. 开一个"坏上游" TCP 监听（accept 后立刻断开），保证它不是"连不上"而是"连上了但坏了"；
 *   3. 起一个**独立**代理实例（独立监听端口、独立配置对象，**不碰生产配置**）
 *      指向坏上游，且 CONNECT 白名单只放行 bait 端口；
 *   4. 经它发一次 CONNECT 到 bait。
 *
 * 判定：
 *   bait 收到 ≥1 次连接 ⇒ 存在直连目标的行为（BUG），本次检查失败；
 *   bait 收到 0 次连接 + 客户端拿到分类失败 ⇒ 通过。
 *
 * 边界：这只证明"本插件不直连"，**不能**证明"消费方不绕过代理"。
 *
 * @param {object} config 生产配置（只读，用来取凭据与上游形态）
 * @param {null | object} credentials
 * @param {{info?: Function, warn?: Function, error?: Function}} [logger]
 * @returns {Promise<object>}
 */
export async function runFaultCheck(config, credentials, logger) {
  const startedAt = Date.now()
  /** @type {string[]} */
  const notes = []
  let baitConnections = 0

  const bait = net.createServer((socket) => {
    baitConnections++
    socket.destroy()
  })
  const brokenUpstream = net.createServer((socket) => {
    socket.destroy()
  })

  // 本函数**不**改动生产实例：所有实验都在下面的独立实例上做。

  try {
    await new Promise((resolve, reject) => {
      bait.once('error', reject)
      bait.listen(0, '127.0.0.1', () => resolve(undefined))
    })
    await new Promise((resolve, reject) => {
      brokenUpstream.once('error', reject)
      brokenUpstream.listen(0, '127.0.0.1', () => resolve(undefined))
    })
    const baitPort = /** @type {import('node:net').AddressInfo} */ (bait.address()).port
    const brokenPort = /** @type {import('node:net').AddressInfo} */ (brokenUpstream.address()).port

    // 独立实例：配置是新建对象，生产实例的端口、白名单、上游一概不动。
    const isolated = createEgressProxy({
      config: {
        ...config,
        listen: { host: '127.0.0.1', port: 0 },
        upstream: { ...config.upstream, type: 'http', host: '127.0.0.1', port: brokenPort },
        allowConnectPorts: [baitPort],
        expectedEgressIps: [],
        selfCheck: { ...config.selfCheck, enabled: false },
      },
      credentials,
      logger: { warn() {}, error() {}, info() {} },
    })

    await isolated.start()
    const isolatedSnap = isolated.snapshot()
    const address = isolatedSnap.listen === null ? null : isolatedSnap.listen
    if (address === null) throw new Error('独立实例未能监听')
    const sep = address.lastIndexOf(':')
    const listenHost = address.slice(0, sep)
    const listenPort = Number(address.slice(sep + 1))

    const attempt = await openTunnelThroughSelf({ host: listenHost, port: listenPort }, '127.0.0.1', baitPort, 5000)
    await new Promise((resolve) => setTimeout(resolve, 150)) // 给潜在的错误直连一点时间暴露
    await isolated.stop()

    const bypassed = baitConnections > 0
    if (attempt.ok) notes.push('意外：坏上游下隧道居然建立成功——请检查坏上游桩是否真的会断开')
    else notes.push(`客户端拿到分类失败：${attempt.reason}`)

    return {
      check: 'fault-injection',
      ok: !bypassed,
      result: bypassed ? 'DIRECT_BYPASS_DETECTED' : 'NO_DIRECT_CONNECTION_OBSERVED',
      baitConnections,
      clientOutcome: attempt.ok ? 'TUNNEL_ESTABLISHED' : attempt.reason,
      notes,
      caveat: '本检查证明"本插件不直连目标"，不证明"消费方不绕过代理"；'
        + '强制出口需叠加系统网络隔离，并单独验收',
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      check: 'fault-injection',
      ok: false,
      result: 'FAULT_CHECK_ERROR',
      detail: error?.message ?? String(error),
      baitConnections,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    await new Promise((resolve) => bait.close(() => resolve(undefined)))
    await new Promise((resolve) => brokenUpstream.close(() => resolve(undefined)))
  }
}
