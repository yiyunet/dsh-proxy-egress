/**
 * 面板 RPC 契约测试：把宿主侧端点当成一个真 HTTP 处理器来驱动。
 *
 * 测的是「面板拿到的到底是什么」——包括那些最容易写错、又最难在界面上看出来的分支：
 * 错误信封、未知方法、处理器抛错。
 *
 * 一条刻意设计在这里被钉住：**业务上的 ok:false 不走错误通道**。
 * 自检"未通过"是正常结果，如果它被包成 error，面板会显示"请求出错"，
 * 把"检查没通过"误读成"插件坏了"。
 *
 * 运行：node --test test/rpc.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { registerPanelRpc, RPC_ENDPOINT } from '../plugin-src/host/rpc.mjs'

const ENDPOINT_URL = `http://127.0.0.1/api/${RPC_ENDPOINT}`

/** 造一个只够用的 ctx，并捕获 register 的入参。 */
function captureRegistration(api, logger = {}) {
  let captured = null
  const ctx = {
    connection: {
      fetch: {
        register(options) {
          captured = options
          return () => {}
        },
      },
    },
  }
  const dispose = registerPanelRpc(ctx, api, logger)
  return { captured, dispose }
}

function envelope(method, payload, rpcId = 'r1') {
  return {
    type: 'client-request',
    rpcId,
    method: RPC_ENDPOINT,
    payload: { method, payload },
  }
}

async function post(body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  return new Request(ENDPOINT_URL, { method, headers, body })
}

test('注册契约：路径、方法与请求体模式', () => {
  const { captured, dispose } = captureRegistration({ state: async () => ({ ok: true }) })
  assert.equal(typeof dispose, 'function')
  assert.equal(captured.path, `/api/${RPC_ENDPOINT}`)
  assert.deepEqual(captured.methods, ['POST'])
  assert.equal(captured.requestBody, 'buffered')
  assert.equal(typeof captured.fetch, 'function')
})

test('没有 connection 服务时安全降级：返回 undefined 并告警', () => {
  const warned = []
  const dispose = registerPanelRpc({}, { state: async () => ({}) }, { warn: (message) => warned.push(message) })
  assert.equal(dispose, undefined)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /设置面板不可用/)
})

test('非 POST 被拒（405）', async () => {
  const { captured } = captureRegistration({ state: async () => ({ ok: true }) })
  // GET 不能带 body，否则 Request 构造阶段就抛错，测不到处理器。
  const response = await captured.fetch(new Request(ENDPOINT_URL, { method: 'GET' }))
  assert.equal(response.status, 405)
})

test('content-type 不对被拒（415）', async () => {
  const { captured } = captureRegistration({ state: async () => ({ ok: true }) })
  const response = await captured.fetch(await post('{}', { 'content-type': 'text/plain' }))
  assert.equal(response.status, 415)
})

test('content-type 带 charset 仍被接受', async () => {
  const { captured } = captureRegistration({ state: async () => ({ hello: 'world' }) })
  const response = await captured.fetch(await post(
    JSON.stringify(envelope('state', {})),
    { 'content-type': 'application/json; charset=utf-8' },
  ))
  const body = await response.json()
  assert.equal(body.result.ok, true)
  assert.deepEqual(body.result.value, { hello: 'world' })
})

test('非法 JSON 被拒（400）', async () => {
  const { captured } = captureRegistration({ state: async () => ({ ok: true }) })
  const response = await captured.fetch(await post('{not json'))
  assert.equal(response.status, 400)
})

test('信封不合法 → BAD_REQUEST，且 rpcId 原样带回', async () => {
  const { captured } = captureRegistration({ state: async () => ({ ok: true }) })
  const bad = { type: 'client-request', rpcId: 'abc', method: 'someone-else', payload: { method: 'state' } }
  const body = await (await captured.fetch(await post(JSON.stringify(bad)))).json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'abc')
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'BAD_REQUEST')
})

test('未知方法 → UNKNOWN_METHOD，并列出可用方法', async () => {
  const { captured } = captureRegistration({ state: async () => ({ ok: true }), restart: async () => ({ ok: true }) })
  const body = await (await captured.fetch(await post(JSON.stringify(envelope('nope', {}))))).json()
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'UNKNOWN_METHOD')
  assert.deepEqual(body.result.error.details.available.sort(), ['restart', 'state'])
})

test('正常调用：result.ok=true，value 就是处理器返回值', async () => {
  const { captured } = captureRegistration({
    selfcheck: async (payload) => ({ ok: false, result: 'UPSTREAM_AUTH_FAILED', echoed: payload }),
  })
  const body = await (await captured.fetch(await post(JSON.stringify(envelope('selfcheck', { a: 1 }))))).json()
  assert.equal(body.result.ok, true, '业务失败不得走错误通道')
  assert.equal(body.result.value.result, 'UPSTREAM_AUTH_FAILED')
  assert.deepEqual(body.result.value.echoed, { a: 1 })
})

test('处理器抛错 → HANDLER_FAILED，且不把 payload 拼进消息', async () => {
  const secret = 'super-secret-value'
  const { captured } = captureRegistration({
    saveCredential: async () => { throw new Error('写入失败') },
  })
  const body = await (await captured.fetch(await post(
    JSON.stringify(envelope('saveCredential', { username: 'u', password: secret })),
  ))).json()
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'HANDLER_FAILED')
  assert.ok(!JSON.stringify(body).includes(secret), '响应里绝不能出现 payload 中的密码')
})

test('缺省的 payload 会补成空对象再交给处理器', async () => {
  let received
  const { captured } = captureRegistration({ state: async (payload) => { received = payload; return { ok: true } } })
  await captured.fetch(await post(JSON.stringify({ type: 'client-request', rpcId: 'r', method: RPC_ENDPOINT, payload: { method: 'state' } })))
  assert.deepEqual(received, {})
})
