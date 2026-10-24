/**
 * 解析层单测：这些是"看起来是字符串细节、实际是安全边界"的地方。
 * 运行：node --test test/parse.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBasicAuth,
  filterHeaders,
  normalizeUpstreamHost,
  parseConnectStatus,
  parseHostPort,
} from '../plugin-src/host/parse.mjs'

test('上游主机名：拒绝把端口写进主机名', () => {
  const result = normalizeUpstreamHost('203.0.113.9:8080')
  assert.equal(result.ok, false)
  assert.match(result.error.message, /不要带端口/)
})

test('上游主机名：拒绝协议前缀', () => {
  const result = normalizeUpstreamHost('http://203.0.113.9')
  assert.equal(result.ok, false)
  assert.match(result.error.message, /协议前缀/)
})

test('上游主机名：IPv4 直接通过', () => {
  assert.deepEqual(normalizeUpstreamHost('203.0.113.9'), { ok: true, value: '203.0.113.9' })
})

test('上游主机名：IPv6 必须带方括号，且去掉方括号后返回', () => {
  assert.deepEqual(normalizeUpstreamHost('[2001:db8::1]'), { ok: true, value: '2001:db8::1' })
  const bare = normalizeUpstreamHost('2001:db8::1')
  assert.equal(bare.ok, false)
  assert.match(bare.error.message, /加方括号/)
})

test('上游主机名：IDN 归一为 punycode 并小写', () => {
  const result = normalizeUpstreamHost('例子.测试')
  assert.equal(result.ok, true)
  assert.match(result.value, /^xn--/)
})

test('CONNECT 目标：IPv4 / IPv6 / 域名 三分法', () => {
  assert.deepEqual(parseHostPort('1.2.3.4:443'), { ok: true, value: { host: '1.2.3.4', port: 443 } })
  assert.deepEqual(parseHostPort('[2001:db8::1]:8443'), { ok: true, value: { host: '2001:db8::1', port: 8443 } })
  assert.deepEqual(parseHostPort('api.example.com:443'), { ok: true, value: { host: 'api.example.com', port: 443 } })
})

test('CONNECT 目标：缺端口要拒绝', () => {
  assert.equal(parseHostPort('api.example.com').ok, false)
  assert.equal(parseHostPort('[2001:db8::1]').ok, false)
})

test('CONNECT 目标：裸 IPv6 不能当成"主机:端口"', () => {
  const result = parseHostPort('2001:db8::1:443')
  assert.equal(result.ok, false)
})

test('CONNECT 目标：端口越界要拒绝', () => {
  assert.equal(parseHostPort('api.example.com:0').ok, false)
  assert.equal(parseHostPort('api.example.com:70000').ok, false)
  assert.equal(parseHostPort('api.example.com:443x').ok, false)
})

test('CONNECT 上游响应：必须解析状态行', () => {
  assert.equal(parseConnectStatus('HTTP/1.1 200 Connection Established'), 200)
  assert.equal(parseConnectStatus('HTTP/1.0 407 Proxy Authentication Required'), 407)
  assert.equal(parseConnectStatus('HTTP/1.1 502'), 502)
  assert.equal(parseConnectStatus('garbage line'), null)
  assert.equal(parseConnectStatus(''), null)
})

test('Basic 认证头：按 RFC 7617 编码', () => {
  assert.equal(buildBasicAuth('u1', 'p1'), 'Basic dTE6cDE=')
})

test('Basic 认证头：用户名不能含冒号', () => {
  assert.throws(() => buildBasicAuth('u:1', 'p1'), /冒号/)
})

test('Basic 认证头：密码不做 trim', () => {
  const spaced = buildBasicAuth('u1', ' p ')
  assert.equal(spaced, `Basic ${Buffer.from('u1: p ').toString('base64')}`)
})

test('逐跳头剥离：连接级头与代理认证头不外泄', () => {
  const filtered = filterHeaders({
    host: 'api.example.com',
    connection: 'keep-alive',
    'proxy-authorization': 'Basic xxx',
    'transfer-encoding': 'chunked',
    'x-trace': 'ok',
  }, { dropAuth: true })
  assert.deepEqual(filtered, { host: 'api.example.com', 'x-trace': 'ok' })
})
