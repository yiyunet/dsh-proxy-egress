#!/usr/bin/env node
/**
 * 独立跑一次"故障注入检查"：证明本插件在上游坏掉时不会直连目标。
 *
 * 这是 M0 的验收项之一，不需要 DSH、不需要真代理、不联网。
 * 用法：node scripts/faultcheck.mjs
 */

import { normalizeConfig } from '../plugin-src/host/config.mjs'
import { runFaultCheck } from '../plugin-src/host/verify.mjs'

const parsed = normalizeConfig({
  listen: { host: '127.0.0.1', port: 8899 },
  upstream: { type: 'http', host: '127.0.0.1', port: 3128, username: 'probe', password: 'probe' },
  credentialSource: 'config',
  allowConnectPorts: [443],
})

if (!parsed.ok) {
  console.error('配置校验未通过：', parsed.errors)
  process.exit(1)
}

const result = await runFaultCheck(
  parsed.value,
  { username: 'probe', password: 'probe', source: 'config', fingerprint: '00000000' },
  {},
)

console.log(JSON.stringify(result, null, 2))
console.log('')
console.log(result.ok
  ? `通过：诱饵端口收到 ${result.baitConnections} 次连接（期望 0），客户端拿到分类失败 ${result.clientOutcome}`
  : `未通过：${result.result}`)
process.exitCode = result.ok ? 0 : 1
