#!/usr/bin/env node
/**
 * 离线冒烟：不联网、不需要真代理、不需要 DSH。
 *
 * 用两个本地假服务把整条链路搭出来：
 *   客户端 → 本插件监听 → 假上游代理（校验 Proxy-Authorization）→ 假目标（TCP 回声）
 *
 * 覆盖六件事：
 *   1. 正常隧道：认证头由本插件注入，消费方不需要知道密码
 *   2. 上游 407 → 本插件回 502 + UPSTREAM_AUTH_FAILED，且**假目标零连接**
 *   3. 上游不可达 → 502 + UPSTREAM_UNREACHABLE，且**假目标零连接**
 *   4. 端口白名单：非白名单目标 → 403 + CONNECT_PORT_NOT_ALLOWED
 *   5. 普通 HTTP：走绝对形式请求，**目标业务状态码原样透传**（429 不被改成 502）
 *   6. 停止后端口释放：再连应当是 ECONNREFUSED
 *
 * 用法：node scripts/smoke.mjs
 */

import http from 'node:http'
import net from 'node:net'

import { normalizeConfig } from '../plugin-src/host/config.mjs'
import { createEgressProxy } from '../plugin-src/host/proxy.mjs'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

function basic(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
}

// ── 假目标：任何写入都回 "PONG" ──────────────────────────────────────────────
let targetConnections = 0
const target = net.createServer((socket) => {
  targetConnections++
  socket.on('data', () => socket.write('PONG'))
  socket.on('error', () => {})
})

// ── 假上游代理 ──────────────────────────────────────────────────────────────
const upstreamSeen = { connects: [], requests: [] }
function createFakeUpstream(options) {
  const { expectedAuth, rejectWith407 = false } = options
  return net.createServer((socket) => {
    let buffered = Buffer.alloc(0)
    let handled = false
    const onData = (chunk) => {
      if (handled) return
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      handled = true
      const head = buffered.subarray(0, end).toString('latin1')
      const rest = buffered.subarray(end + 4)
      socket.removeListener('data', onData)

      const lines = head.split('\r\n')
      const [method, requestTarget] = lines[0].split(' ')
      const headers = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
      }
      const auth = headers['proxy-authorization'] ?? null

      if (method === 'CONNECT') {
        upstreamSeen.connects.push({ target: requestTarget, auth })
        if (rejectWith407 || (expectedAuth !== null && auth !== expectedAuth)) {
          socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          return
        }
        const sep = requestTarget.lastIndexOf(':')
        const host = requestTarget.slice(0, sep)
        const port = Number(requestTarget.slice(sep + 1))
        const upstreamSocket = net.connect(port, host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (rest.length > 0) upstreamSocket.write(rest)
          socket.pipe(upstreamSocket)
          upstreamSocket.pipe(socket)
        })
        upstreamSocket.on('error', () => socket.destroy())
        socket.on('error', () => upstreamSocket.destroy())
        return
      }

      upstreamSeen.requests.push({ method, target: requestTarget, auth })
      if (expectedAuth !== null && auth !== expectedAuth) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
        return
      }
      // 故意回 429：验证业务状态码透传，而不是被代理改成 502。
      socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnope!')
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
}

// ── 测试客户端：发 CONNECT，拿状态与 reason 头 ────────────────────────────────
function tunnelAttempt(port, targetHost, targetPort, payload) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    let buffered = ''
    let replied = false
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ status: -1, reason: 'TIMEOUT', body: '' })
    }, 5000)
    timer.unref?.()

    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1')
      if (!replied) {
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        replied = true
        const head = buffered.slice(0, end)
        const status = Number(head.split(' ')[1])
        const reason = /x-egress-reason:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? null
        if (status === 200) {
          socket.write(payload)
        } else {
          clearTimeout(timer)
          socket.destroy()
          resolve({ status, reason, body: '' })
        }
        return
      }
      if (buffered.includes('PONG')) {
        clearTimeout(timer)
        socket.destroy()
        resolve({ status: 200, reason: null, body: 'PONG' })
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: 0, reason: error?.code ?? 'SOCKET_ERROR', body: '' })
    })
  })
}

// ── 普通 HTTP 转发 ──────────────────────────────────────────────────────────
function plainRequest(proxyPort, absoluteUrl) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: absoluteUrl,
      headers: { host: new URL(absoluteUrl).host },
      agent: false,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, reason: res.headers['x-egress-reason'] ?? null, body }))
    })
    req.on('error', (error) => resolve({ status: 0, reason: error?.code ?? 'REQUEST_ERROR', body: '' }))
    req.end()
  })
}

async function main() {
  const targetPort = await listen(target)
  const okUpstream = createFakeUpstream({ expectedAuth: basic('u1', 'p1') })
  const okUpstreamPort = await listen(okUpstream)
  const authFailUpstream = createFakeUpstream({ expectedAuth: basic('u1', 'p1'), rejectWith407: true })
  const authFailPort = await listen(authFailUpstream)

  // 一个确定没人监听的端口：先占位再关掉
  const deadServer = net.createServer()
  const deadPort = await listen(deadServer)
  await close(deadServer)

  // 本插件的 listening 端口由系统分配后取用：避免与真实实例（默认 8899）撞车。
  async function freePort() {
    const probe = net.createServer()
    const port = await listen(probe)
    await close(probe)
    return port
  }
  const goodPort = await freePort()
  const authProxyPort = await freePort()
  const deadProxyPort = await freePort()

  const baseConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { type: 'http', host: '127.0.0.1', port: okUpstreamPort, username: 'u1', password: 'p1' },
    credentialSource: 'config',
    allowConnectPorts: [targetPort],
    expectedEgressIps: [],
    egressMismatchAction: 'warn',
  }

  // ── ① 正常隧道 ────────────────────────────────────────────────────────────
  const good = createEgressProxy({
    config: normalizeConfig({ ...baseConfig, listen: { host: '127.0.0.1', port: goodPort } }).value,
    credentials: { username: 'u1', password: 'p1', source: 'config', fingerprint: 'deadbeef' },
    logger: {},
  })
  let started = false
  try {
    await good.start()
    started = good.state === 'listening'
  } catch (error) {
    check(`监听 ${goodPort}`, false, `${error?.code ?? ''} ${error?.message ?? String(error)}`)
  }
  if (started) {
    check(`监听 ${goodPort}`, true)
    const before = targetConnections
    const outcome = await tunnelAttempt(goodPort, '127.0.0.1', targetPort, 'PING')
    check('① 正常隧道建立并转发', outcome.status === 200 && outcome.body === 'PONG', JSON.stringify(outcome))
    const seen = upstreamSeen.connects.at(-1)
    check('① 认证头由本插件注入', seen !== undefined && seen.auth === basic('u1', 'p1'), `上游收到：${seen?.auth ?? 'null'}`)
    check('① 目标确实被连到', targetConnections > before, `目标连接数 ${targetConnections}`)

    // ── ④ 端口白名单 ────────────────────────────────────────────────────────
    const forbidden = await tunnelAttempt(goodPort, '127.0.0.1', 1, '')
    check('④ 非白名单端口被拒', forbidden.status === 403 && forbidden.reason === 'CONNECT_PORT_NOT_ALLOWED', JSON.stringify(forbidden))

    // ── ⑤ 普通 HTTP：业务状态码透传 ──────────────────────────────────────────
    const plain = await plainRequest(goodPort, `http://127.0.0.1:${targetPort}/probe`)
    check('⑤ 普通 HTTP 走绝对形式 + 状态码透传', plain.status === 429 && plain.body === 'nope!', JSON.stringify(plain))
    const plainSeen = upstreamSeen.requests.at(-1)
    check('⑤ 上游收到的是绝对形式 URL', plainSeen !== undefined && plainSeen.target.startsWith('http://'), `上游收到：${plainSeen?.target ?? '无'}`)

    await good.stop()
    const afterStop = await tunnelAttempt(goodPort, '127.0.0.1', targetPort, 'PING')
    check('⑥ 停止后端口已释放', afterStop.status === 0 && afterStop.reason === 'ECONNREFUSED', JSON.stringify(afterStop))
  }

  // ── ② 上游 407 ────────────────────────────────────────────────────────────
  const authFail = createEgressProxy({
    config: normalizeConfig({ ...baseConfig, listen: { host: '127.0.0.1', port: authProxyPort },
      upstream: { type: 'http', host: '127.0.0.1', port: authFailPort, username: 'u1', password: 'p1' } }).value,
    credentials: { username: 'u1', password: 'p1', source: 'config', fingerprint: 'deadbeef' },
    logger: {},
  })
  await authFail.start()
  const bait1 = targetConnections
  const authOutcome = await tunnelAttempt(authProxyPort, '127.0.0.1', targetPort, 'PING')
  await authFail.stop()
  check('② 上游 407 被分类为 UPSTREAM_AUTH_FAILED',
    authOutcome.status === 502 && authOutcome.reason === 'UPSTREAM_AUTH_FAILED', JSON.stringify(authOutcome))
  check('② 认证失败时目标零连接', targetConnections === bait1, `目标连接数 ${targetConnections}（此前 ${bait1}）`)

  // ── ③ 上游不可达 ──────────────────────────────────────────────────────────
  const deadUpstream = createEgressProxy({
    config: normalizeConfig({ ...baseConfig, listen: { host: '127.0.0.1', port: deadProxyPort },
      upstream: { type: 'http', host: '127.0.0.1', port: deadPort, username: 'u1', password: 'p1' } }).value,
    credentials: { username: 'u1', password: 'p1', source: 'config', fingerprint: 'deadbeef' },
    logger: {},
  })
  await deadUpstream.start()
  const bait2 = targetConnections
  const deadOutcome = await tunnelAttempt(deadProxyPort, '127.0.0.1', targetPort, 'PING')
  await deadUpstream.stop()
  check('③ 上游不可达被分类为 UPSTREAM_UNREACHABLE',
    deadOutcome.status === 502 && deadOutcome.reason === 'UPSTREAM_UNREACHABLE', JSON.stringify(deadOutcome))
  check('③ 上游不可达时目标零连接（无直连降级）', targetConnections === bait2, `目标连接数 ${targetConnections}（此前 ${bait2}）`)

  await close(target)
  await close(okUpstream)
  await close(authFailUpstream)

  const failed = results.filter((item) => !item.pass)
  console.log('')
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    console.log('未通过：')
    for (const item of failed) console.log(`  - ${item.name}：${item.detail ?? ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('冒烟脚本自身出错：', error)
  process.exitCode = 1
})
