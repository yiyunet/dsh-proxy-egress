/**
 * 配置层单测：每一条都对应需求文档里的 V1–V6。
 * 运行：node --test test/config.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../plugin-src/host/config.mjs'

const base = {
  upstream: { type: 'http', host: '203.0.113.9', port: 8080 },
}

test('V6 默认值：最小配置即通过，且不监听非回环', () => {
  const result = normalizeConfig(base)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.listen, { host: '127.0.0.1', port: 8899 })
  assert.equal(result.value.upstream.username, undefined)
  assert.deepEqual(result.value.allowConnectPorts, [443])
})

test('只允许回环：0.0.0.0 必须被拒绝', () => {
  const result = normalizeConfig({ ...base, listen: { host: '0.0.0.0', port: 8899 } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.field === 'listen.host'))
})

test('V1 主机名里带端口必须被拒绝', () => {
  const result = normalizeConfig({ upstream: { type: 'http', host: '203.0.113.9:8080', port: 8080 } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.field === 'upstream.host'))
})

test('上游端口必须显式给出', () => {
  const result = normalizeConfig({ upstream: { type: 'http', host: '203.0.113.9' } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.field === 'upstream.port'))
})

test('V2 凭据必须成对出现', () => {
  const onlyUser = normalizeConfig({ ...base, upstream: { ...base.upstream, username: 'u1' } })
  assert.equal(onlyUser.ok, false)
  assert.ok(onlyUser.errors.some((item) => item.field === 'upstream.username'))

  const both = normalizeConfig({ ...base, upstream: { ...base.upstream, username: 'u1', password: 'p1' } })
  assert.equal(both.ok, true)
  assert.equal(both.value.upstream.password, 'p1')
})

test('密码逐字保留：不 trim', () => {
  const result = normalizeConfig({ ...base, upstream: { ...base.upstream, username: 'u1', password: ' p 1 ' } })
  assert.equal(result.ok, true)
  assert.equal(result.value.upstream.password, ' p 1 ')
})

test('username 不能含冒号', () => {
  const result = normalizeConfig({ ...base, upstream: { ...base.upstream, username: 'u:1', password: 'p1' } })
  assert.equal(result.ok, false)
})

test('直连降级开关：写了就报错，不静默忽略', () => {
  const result = normalizeConfig({ ...base, allowDirectFallback: true })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.field === 'allowDirectFallback'))
})

test('CONNECT 端口白名单不能为空（否则退化成任意 TCP 转发）', () => {
  const result = normalizeConfig({ ...base, allowConnectPorts: [] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.field === 'allowConnectPorts'))
})

test('credentialSource=file 必须给绝对路径', () => {
  const missing = normalizeConfig({ ...base, credentialSource: 'file' })
  assert.equal(missing.ok, false)

  const relative = normalizeConfig({ ...base, credentialSource: 'file', credentialFile: 'proxy.json' })
  assert.equal(relative.ok, false)

  const absolute = normalizeConfig({ ...base, credentialSource: 'file', credentialFile: 'D:\\keys\\proxy.json' })
  assert.equal(absolute.ok, true)
  assert.equal(absolute.value.credentialFile, 'D:\\keys\\proxy.json')
})

test('expectedEgressIps 必须是合法 IP', () => {
  const bad = normalizeConfig({ ...base, expectedEgressIps: ['not-an-ip'] })
  assert.equal(bad.ok, false)

  const good = normalizeConfig({ ...base, expectedEgressIps: ['203.0.113.9'] })
  assert.equal(good.ok, true)
  assert.deepEqual(good.value.expectedEgressIps, ['203.0.113.9'])
})

test('egressMismatchAction 只认 warn / block', () => {
  assert.equal(normalizeConfig({ ...base, egressMismatchAction: 'block' }).ok, true)
  assert.equal(normalizeConfig({ ...base, egressMismatchAction: 'panic' }).ok, false)
})

test('upstream.type 只认 http / https', () => {
  assert.equal(normalizeConfig({ ...base, upstream: { ...base.upstream, type: 'https' } }).ok, true)
  assert.equal(normalizeConfig({ ...base, upstream: { ...base.upstream, type: 'socks5' } }).ok, false)
})

test('自检 URL 必须是合法 URL', () => {
  const result = normalizeConfig({ ...base, selfCheck: { url: '不是 URL' } })
  assert.equal(result.ok, false)
})
