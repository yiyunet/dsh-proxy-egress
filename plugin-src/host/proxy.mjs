/**
 * 代理引擎：本地监听 + 上游转发 + 失败即断联。
 *
 * ── 它保证什么（L1，代码级、可测）────────────────────────────────────────────
 *   进入本监听的每一条数据连接，只能通过**所配置的上游代理**转发；
 *   上游不可达 / 认证失败 / 拒绝 / 超时，一律关闭客户端连接并给出分类原因，
 *   **不创建到目标的直连连接，不做任何降级重试**。
 *
 * ── 它不保证什么（L2/L3）───────────────────────────────────────────────────
 *   消费方是否真的把请求交给本监听。消费方可以绕过代理直连，本插件管不了；
 *   要可证明的强制出口，必须叠加系统网络隔离（防火墙白名单 / 独立网络环境），
 *   那部分单独验收。
 *
 * ── 几个必须照做的实现细节（每一处都是踩过的坑）──────────────────────────────
 *   1. CONNECT 成功判定 = 完整解析状态行且落到 2xx；见 \r\n\r\n 就当成功是错的。
 *   2. 已经发出 200 之后，任何错误**只能关闭隧道并记录**；再写 HTTP 响应会污染 TLS 流。
 *   3. `closeAllConnections()` 不销毁 upgrade / connect 出来的 socket —— 必须自己登记并销毁。
 *   4. CONNECT 端口必须走白名单，否则本插件就是一个开放 TCP 转发器。
 *   5. 上游响应头有上限、握手有超时：否则一个不说话的代理能把内存拖死。
 *
 * @module dsh-proxy-egress/proxy
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

import { buildBasicAuth, filterHeaders, findHeaderEnd, parseConnectStatus, parseHostPort } from './parse.mjs'

/** 对外可观测的状态。 */
export const PROXY_STATE = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  LISTENING: 'listening',
  STOPPING: 'stopping',
  ERROR: 'error',
}

const STATUS_FOR_REASON = {
  BAD_TARGET: 400,
  CONNECT_PORT_NOT_ALLOWED: 403,
  PROXY_BLOCKED: 503,
  UPSTREAM_UNREACHABLE: 502,
  UPSTREAM_AUTH_FAILED: 502,
  UPSTREAM_REJECTED: 502,
  UPSTREAM_MALFORMED_RESPONSE: 502,
  HANDSHAKE_HEADER_TOO_LARGE: 502,
  TUNNEL_HANDSHAKE_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
}

const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

function formatHost(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host
}

function createRegistry() {
  const items = new Map()
  let seq = 0
  return {
    add(record) {
      const id = `c${++seq}`
      items.set(id, {
        id,
        phase: record.phase,
        target: record.target,
        client: record.client ?? null,
        upstream: record.upstream ?? null,
        createdAt: Date.now(),
      })
      return id
    },
    setPhase(id, phase) {
      const item = items.get(id)
      if (item !== undefined) item.phase = phase
    },
    setUpstream(id, socket) {
      const item = items.get(id)
      if (item !== undefined) item.upstream = socket
    },
    remove(id) {
      items.delete(id)
    },
    size() {
      return items.size
    },
    phases() {
      /** @type {Record<string, number>} */
      const out = {}
      for (const item of items.values()) out[item.phase] = (out[item.phase] ?? 0) + 1
      return out
    },
    destroyAll() {
      for (const item of items.values()) {
        for (const socket of [item.client, item.upstream]) {
          if (socket !== null && typeof socket.destroy === 'function') {
            try {
              socket.destroy()
            } catch {
              /* 已经关掉了 */
            }
          }
        }
      }
      items.clear()
    },
  }
}

/**
 * 创建一个代理实例。**没有副作用**：调用它不监听、不联网，直到 `start()`。
 *
 * @param {object} options
 * @param {object} options.config normalizeConfig 的产出
 * @param {null | {username: string, password: string, source: string, fingerprint: string}} options.credentials
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 */
export function createEgressProxy(options) {
  const { config, credentials } = options
  const logger = options.logger ?? {}
  const authHeader = credentials === null ? null : buildBasicAuth(credentials.username, credentials.password)

  const registry = createRegistry()
  /** @type {import('node:http').Server | null} */
  let server = null
  let state = PROXY_STATE.STOPPED
  let listenInfo = null
  let lastError = null
  let blockedReason = null
  /** @type {null | {at: number, reason: string, detail: string}} */
  let lastFailure = null
  /** @type {null | {at: number, ip: string, matched: boolean|null}} */
  let lastEgressObservation = null
  const stats = {
    connectAttempts: 0,
    connectEstablished: 0,
    connectFailed: 0,
    plainRequests: 0,
    plainFailed: 0,
    rejectedPort: 0,
    rejectedBlocked: 0,
    rejectedBadTarget: 0,
  }

  let queue = Promise.resolve()
  /** 串行化 start / stop / restart：并发启停会让端口和 socket 表互相打架。 */
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  function recordFailure(reason, detail) {
    lastFailure = { at: Date.now(), reason, detail: String(detail ?? '').slice(0, 300) }
    logger.warn?.(`[proxy-egress] ${reason}: ${lastFailure.detail}`)
  }

  // ── 上游拨号：唯一允许的出站方向 ─────────────────────────────────────────
  function dialUpstream() {
    return new Promise((resolve, reject) => {
      const { type, host, port } = config.upstream
      const deadline = config.handshakeTimeoutMs
      /** @type {import('node:net').Socket} */
      let socket
      let timer = null
      let settled = false

      const settle = (fn, value) => {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        fn(value)
      }

      try {
        if (type === 'https') {
          socket = tls.connect({
            host,
            port,
            ...(net.isIP(host) === 0 ? { servername: host } : {}),
            rejectUnauthorized: true,
          })
          socket.once('secureConnect', () => settle(resolve, socket))
        } else {
          socket = net.connect({ host, port })
          socket.once('connect', () => settle(resolve, socket))
        }
      } catch (error) {
        reject(error)
        return
      }

      // 常驻错误处理：连接成功之后照样需要一个，否则未捕获的 'error' 会掀掉宿主进程。
      socket.on('error', (error) => {
        if (!settled) {
          settle(reject, error)
          return
        }
        recordFailure('UPSTREAM_UNREACHABLE', `上游连接中断：${error?.message ?? String(error)}`)
        try {
          socket.destroy()
        } catch {
          /* 已销毁 */
        }
      })

      timer = setTimeout(() => {
        const error = new Error(`连接上游超时（${deadline}ms）`)
        error.code = 'ETIMEDOUT'
        settle(reject, error)
        try {
          socket.destroy()
        } catch {
          /* 已销毁 */
        }
      }, deadline)
      timer.unref?.()
    })
  }

  /**
   * 给客户端回一条代理错误响应（**只能在发出 200 之前调用**）。
   * @param {import('node:net').Socket} socket
   * @param {string} reason 分类码
   * @param {string} [detail] 人话说明
   * @param {number} [upstreamStatus] 上游返回的状态码（有就在响应头里带出去，便于区分 403/407）
   */
  function rejectConnect(socket, reason, detail, upstreamStatus) {
    const status = STATUS_FOR_REASON[reason] ?? 502
    const body = `${reason}: ${detail ?? ''}\n`
    const payload = [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
      `X-Egress-Reason: ${reason}`,
      ...(typeof upstreamStatus === 'number' ? [`X-Egress-Upstream-Status: ${upstreamStatus}`] : []),
      'Cache-Control: no-store',
      'Connection: close',
      '',
      body,
    ].join('\r\n')
    try {
      socket.write(payload)
      socket.end()
    } catch {
      /* 客户端已经走了 */
    }
    const guard = setTimeout(() => {
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
    }, 2000)
    guard.unref?.()
  }

  // ── CONNECT 隧道 ─────────────────────────────────────────────────────────
  function handleConnect(req, clientSocket, head) {
    stats.connectAttempts++
    clientSocket.setNoDelay?.(true)

    const targetResult = parseHostPort(req.url)
    if (!targetResult.ok) {
      stats.rejectedBadTarget++
      rejectConnect(clientSocket, 'BAD_TARGET', targetResult.error.message)
      return
    }
    const target = targetResult.value

    if (!config.allowConnectPorts.includes(target.port)) {
      stats.rejectedPort++
      rejectConnect(clientSocket, 'CONNECT_PORT_NOT_ALLOWED',
        `目标端口 ${target.port} 不在白名单 [${config.allowConnectPorts.join(', ')}]`)
      return
    }
    if (blockedReason !== null) {
      stats.rejectedBlocked++
      rejectConnect(clientSocket, 'PROXY_BLOCKED', blockedReason)
      return
    }

    const targetText = `${formatHost(target.host)}:${target.port}`
    const id = registry.add({ phase: 'upstream-dialing', client: clientSocket, target: targetText })
    clientSocket.on('error', () => { /* 客户端断开属正常事件 */ })

    dialUpstream().then((upstream) => {
      // 拨号期间已被 stop：立刻收掉，不要把 socket 泄漏出去。
      if (server === null) {
        try {
          upstream.destroy()
        } catch {
          /* 已销毁 */
        }
        registry.remove(id)
        rejectConnect(clientSocket, 'PROXY_BLOCKED', '代理正在停止')
        return
      }

      registry.setPhase(id, 'tunnel-handshake')
      registry.setUpstream(id, upstream)

      let settled = false
      let buffer = Buffer.alloc(0)

      const abandon = (reason, detail, upstreamStatus) => {
        if (settled) return
        settled = true
        registry.remove(id)
        stats.connectFailed++
        recordFailure(reason, detail)
        try {
          upstream.destroy()
        } catch {
          /* 已销毁 */
        }
        rejectConnect(clientSocket, reason, detail, upstreamStatus)
      }

      const timer = setTimeout(() => {
        abandon('TUNNEL_HANDSHAKE_TIMEOUT',
          `上游 ${config.handshakeTimeoutMs}ms 内没有返回 CONNECT 响应`)
      }, config.handshakeTimeoutMs)
      timer.unref?.()

      // 上游在握手阶段就断开：立刻按失败收掉，不要干等到握手超时。
      upstream.once('close', () => {
        if (!settled) abandon('UPSTREAM_UNREACHABLE', '上游在返回 CONNECT 响应前关闭了连接')
      })

      const onData = (chunk) => {
        if (settled) return
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

        if (buffer.length > config.maxHeaderBytes) {
          clearTimeout(timer)
          upstream.removeListener('data', onData)
          abandon('HANDSHAKE_HEADER_TOO_LARGE',
            `CONNECT 响应头超过 ${config.maxHeaderBytes} 字节上限`)
          return
        }

        const end = findHeaderEnd(buffer)
        if (end === -1) return

        clearTimeout(timer)
        upstream.removeListener('data', onData)

        const headText = buffer.subarray(0, end).toString('latin1')
        const rest = buffer.subarray(end + 4)
        const status = parseConnectStatus(headText)

        if (status === null) {
          abandon('UPSTREAM_MALFORMED_RESPONSE', '上游 CONNECT 响应状态行无法解析，按失败处理')
          return
        }
        // 401 与 407 都算认证失败：标准是 407，但实测有上游对错误凭据回 401
        // （2026-10-12 实测：占位符凭据下上游返回 401）。
        if (status === 407 || status === 401) {
          abandon('UPSTREAM_AUTH_FAILED',
            `上游拒绝认证（HTTP ${status}）：账号或密码不对，或凭据文件改了但没 restart`, status)
          return
        }
        if (status < 200 || status > 299) {
          // 403 可能是凭据问题，也可能是代理侧的目标策略限制 —— 所以单列一类，并把状态码带出去。
          abandon('UPSTREAM_REJECTED', `上游拒绝 CONNECT：HTTP ${status}`, status)
          return
        }

        // ── 从这里开始，客户端已经会被写成 200：此后永不再写任何 HTTP 字节 ──
        settled = true
        registry.setPhase(id, 'tunneling')
        stats.connectEstablished++
        logger.info?.(`[proxy-egress] 隧道建立 ${targetText}`)

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head !== undefined && head.length > 0) upstream.write(head)
        if (rest.length > 0) clientSocket.write(rest)

        clientSocket.pipe(upstream)
        upstream.pipe(clientSocket)

        const cleanup = () => {
          registry.remove(id)
          try {
            clientSocket.destroy()
          } catch {
            /* 已销毁 */
          }
          try {
            upstream.destroy()
          } catch {
            /* 已销毁 */
          }
        }
        upstream.once('close', cleanup)
        clientSocket.once('close', cleanup)
      }

      upstream.on('data', onData)

      const auth = authHeader === null ? '' : `Proxy-Authorization: ${authHeader}\r\n`
      upstream.write(
        `CONNECT ${targetText} HTTP/1.1\r\n`
        + `Host: ${targetText}\r\n`
        + auth
        + 'Proxy-Connection: Keep-Alive\r\n\r\n',
      )
    }, (error) => {
      registry.remove(id)
      stats.connectFailed++
      recordFailure('UPSTREAM_UNREACHABLE', error?.message ?? '无法连接上游代理')
      rejectConnect(clientSocket, 'UPSTREAM_UNREACHABLE',
        `连不上上游代理 ${formatHost(config.upstream.host)}:${config.upstream.port}（${error?.code ?? ''}）`)
    }).catch((error) => {
      // 兜底：绝不让未处理拒绝掀掉宿主进程。此时可能已经发过 200，所以只关闭、不写 HTTP。
      registry.remove(id)
      recordFailure('INTERNAL_ERROR', error?.message ?? String(error))
      try {
        clientSocket.destroy()
      } catch {
        /* 已销毁 */
      }
    })
  }

  // ── 普通 HTTP 转发（绝对形式请求）─────────────────────────────────────────
  function handleRequest(req, res) {
    stats.plainRequests++

    if (blockedReason !== null) {
      stats.rejectedBlocked++
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Egress-Reason': 'PROXY_BLOCKED' })
      res.end(`PROXY_BLOCKED: ${blockedReason}\n`)
      return
    }
    const url = typeof req.url === 'string' ? req.url : ''
    if (!/^https?:\/\//i.test(url)) {
      stats.rejectedBadTarget++
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Egress-Reason': 'BAD_TARGET' })
      res.end('BAD_TARGET: 本插件是转发代理，请求行必须是绝对形式（http://host/path）\n')
      return
    }

    const headers = filterHeaders(req.headers, { dropAuth: true })
    if (authHeader !== null) headers['proxy-authorization'] = authHeader
    headers['proxy-connection'] = 'Keep-Alive'

    const isTls = config.upstream.type === 'https'
    const transport = isTls ? https : http
    const id = registry.add({ phase: 'plain-request', client: req.socket, target: url.slice(0, 200) })

    /** @type {import('node:http').ClientRequest} */
    let upReq
    try {
      upReq = transport.request({
        host: config.upstream.host,
        port: config.upstream.port,
        method: req.method,
        path: url,
        headers,
        ...(isTls && net.isIP(config.upstream.host) === 0 ? { servername: config.upstream.host } : {}),
      })
    } catch (error) {
      registry.remove(id)
      stats.plainFailed++
      recordFailure('UPSTREAM_UNREACHABLE', `构造上游请求失败：${error?.message ?? String(error)}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Egress-Reason': 'UPSTREAM_UNREACHABLE' })
        res.end('UPSTREAM_UNREACHABLE\n')
      } else {
        res.destroy()
      }
      return
    }

    upReq.setTimeout(config.handshakeTimeoutMs, () => {
      upReq.destroy(new Error(`上游 ${config.handshakeTimeoutMs}ms 无响应`))
    })

    upReq.on('response', (upRes) => {
      upReq.setTimeout(0) // 响应开始后不再按空闲超时掐长连接
      registry.setPhase(id, 'plain-streaming')
      // 目标业务状态码原样透传：401 / 429 / 500 都是正常业务响应，不是代理故障。
      res.writeHead(upRes.statusCode ?? 502, filterHeaders(upRes.headers))
      upRes.pipe(res)
      upRes.on('close', () => registry.remove(id))
    })

    upReq.on('error', (error) => {
      registry.remove(id)
      stats.plainFailed++
      recordFailure('UPSTREAM_UNREACHABLE', `上游请求失败：${error?.message ?? String(error)}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Egress-Reason': 'UPSTREAM_UNREACHABLE' })
        res.end('UPSTREAM_UNREACHABLE\n')
      } else {
        // 已经开始回包：只能断掉，不能重发状态行。
        res.destroy()
      }
    })

    res.on('close', () => {
      registry.remove(id)
      if (!res.writableEnded) {
        try {
          upReq.destroy()
        } catch {
          /* 已销毁 */
        }
      }
    })

    req.on('error', () => {
      /* 客户端中途断开 */
    })
    req.pipe(upReq)
  }

  function buildServer() {
    const next = http.createServer()
    next.on('request', handleRequest)
    next.on('connect', handleConnect)
    next.on('upgrade', (_req, socket) => {
      try {
        socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n')
      } catch {
        /* 已断开 */
      }
    })
    next.on('clientError', (_error, socket) => {
      try {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } catch {
        /* 已断开 */
      }
    })
    next.on('error', (error) => {
      lastError = `监听错误：${error?.code ?? ''} ${error?.message ?? String(error)}`.trim()
      logger.error?.(`[proxy-egress] ${lastError}`)
    })
    return next
  }

  // ── 对外方法 ─────────────────────────────────────────────────────────────
  function snapshot() {
    return {
      state,
      listen: listenInfo,
      listenConfigured: `${config.listen.host}:${config.listen.port}`,
      upstream: {
        type: config.upstream.type,
        host: config.upstream.host,
        port: config.upstream.port,
        credentialConfigured: credentials !== null,
        credentialSource: credentials === null ? null : credentials.source,
        credentialFingerprint: credentials === null ? null : credentials.fingerprint,
      },
      allowConnectPorts: config.allowConnectPorts,
      expectedEgressIps: config.expectedEgressIps,
      egressMismatchAction: config.egressMismatchAction,
      blocked: blockedReason === null ? null : { reason: blockedReason },
      connections: { total: registry.size(), phases: registry.phases() },
      stats,
      lastFailure,
      lastEgressObservation,
      lastError,
    }
  }

  /** 真正干活的那一层：**不经过串行队列**，只允许被 start/stop/restart 在队列内调用。 */
  async function startInternal() {
    {
      if (state === PROXY_STATE.LISTENING) return snapshot()
      state = PROXY_STATE.STARTING
      lastError = null
      blockedReason = null
      server = buildServer()
      const current = server
      try {
        await new Promise((resolve, reject) => {
          const onListening = () => {
            current.removeListener('error', onError)
            resolve(undefined)
          }
          const onError = (error) => {
            current.removeListener('listening', onListening)
            reject(error)
          }
          current.once('listening', onListening)
          current.once('error', onError)
          current.listen(config.listen.port, config.listen.host)
        })
        const address = current.address()
        listenInfo = address !== null && typeof address === 'object'
          ? `${address.address}:${address.port}`
          : String(address)
        state = PROXY_STATE.LISTENING
        logger.info?.(`[proxy-egress] 监听 ${listenInfo} → 上游 ${config.upstream.type}://${formatHost(config.upstream.host)}:${config.upstream.port}`)
        return snapshot()
      } catch (error) {
        state = PROXY_STATE.ERROR
        server = null
        // 端口占用就是占用：不自增端口、不换端口，换端口会让消费方悄悄连到别的服务。
        lastError = `启动失败：${error?.code ?? ''} ${error?.message ?? String(error)}`.trim()
        logger.error?.(`[proxy-egress] ${lastError}`)
        throw error
      }
    }
  }

  /** 同 startInternal：只在串行队列内被调用。 */
  async function stopInternal() {
    {
      const current = server
      server = null
      if (state === PROXY_STATE.STOPPED && current === null) return snapshot()
      state = PROXY_STATE.STOPPING
      // 先按登记表销毁：closeAllConnections 不覆盖 connect / upgrade 出来的 socket。
      registry.destroyAll()
      if (current !== null) {
        await new Promise((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            resolve(undefined)
          }
          current.close(() => finish())
          try {
            current.closeAllConnections?.()
          } catch {
            /* 老版本没有该方法 */
          }
          const guard = setTimeout(finish, 3000)
          guard.unref?.()
        })
      }
      listenInfo = null
      blockedReason = null
      state = PROXY_STATE.STOPPED
      return snapshot()
    }
  }

  // 对外三个动作一律进出串行队列，避免"停一半又启"这种交叉。
  const start = () => serialize(startInternal)
  const stop = () => serialize(stopInternal)
  const restart = () => serialize(async () => {
    await stopInternal()
    return startInternal()
  })

  /**
   * 记一次出口观测，并在不匹配时按策略处置。
   * @param {string} observedIp
   * @returns {{matched: boolean|null, action: 'none'|'warn'|'blocked'}}
   */
  function applyEgressObservation(observedIp) {
    lastEgressObservation = { at: Date.now(), ip: observedIp, matched: null }
    if (config.expectedEgressIps.length === 0) {
      return { matched: null, action: 'none' }
    }
    const matched = config.expectedEgressIps.includes(observedIp)
    lastEgressObservation.matched = matched
    if (matched) return { matched, action: 'none' }
    const detail = `观测出口 ${observedIp} 不在期望列表 [${config.expectedEgressIps.join(', ')}]`
    recordFailure('EGRESS_IP_MISMATCH', detail)
    if (config.egressMismatchAction === 'block') {
      blockedReason = `EGRESS_IP_MISMATCH：${detail}（已阻断新连接；已建立的隧道不会被中断）`
      return { matched, action: 'blocked' }
    }
    return { matched, action: 'warn' }
  }

  function setBlocked(reason) {
    blockedReason = reason
    logger.warn?.(`[proxy-egress] 进入阻断态：${reason}`)
  }

  function clearBlocked() {
    blockedReason = null
  }

  return {
    start,
    stop,
    restart,
    snapshot,
    applyEgressObservation,
    setBlocked,
    clearBlocked,
    get config() {
      return config
    },
    get state() {
      return state
    },
  }
}
