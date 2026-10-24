/**
 * 设置面板用的 RPC 端点（宿主侧）。
 *
 * 抽成独立模块的理由很实际：`index.mjs` 顶部 import 了 `@deepseek-ai/dsh-tools`
 * （由宿主运行时提供，Node 里解析不到），所以测试无法引用 index.mjs。
 * 把这段契约代码独立出来，它就能在纯 Node 下被真实驱动一次。
 *
 * ── 信封形状是硬性的（客户端 connection/rpc 的解析器是唯一裁判）──────────
 *   请求 {type:'client-request', rpcId, method:'<endpoint>', payload:{method, payload}}
 *   应答 {type:'server-response', rpcId, result:{ok:true, value:<载荷>}}
 *
 * ── 与 `dsh-mcp-client-manager` 的一个刻意差别 ───────────────────────────
 *   本插件**总是**用 result.ok=true 回包，把业务上的 ok/false 留在载荷里。
 *   因为自检/故障注入「未通过」是正常业务结果，走错误通道会让面板把它渲染成
 *   "请求出错"，而不是"检查未通过"——两种含义完全不同。
 *
 * @module dsh-proxy-egress/rpc
 */

/** RPC 端点名（不含 /api/ 前缀）。客户端必须用同一个值。 */
export const RPC_ENDPOINT = 'proxy-egress'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, (payload?: any) => Promise<object>>} api
 * @param {{warn?: Function, error?: Function, info?: Function}} [logger]
 * @returns {(() => void) | undefined}
 */
export function registerPanelRpc(ctx, api, logger) {
  const register = ctx?.connection?.fetch?.register
  if (typeof register !== 'function') {
    logger?.warn?.('[proxy-egress] connection.fetch.register 不可用 —— 设置面板不可用（代理本体不受影响）')
    return undefined
  }

  const reply = (rpcId, value) => Response.json({
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  })
  const fail = (rpcId, code, message, details) => Response.json({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: details ?? {} } },
  })

  return register({
    path: `/api/${RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== RPC_ENDPOINT || call === null || typeof call !== 'object'
        || typeof call.method !== 'string') {
        return fail(rpcId, 'BAD_REQUEST', '请求信封不合法')
      }

      const handler = api[call.method]
      if (typeof handler !== 'function') {
        return fail(rpcId, 'UNKNOWN_METHOD', `未知方法：${call.method}`, { available: Object.keys(api) })
      }

      try {
        return reply(rpcId, await handler(call.payload ?? {}))
      } catch (error) {
        // 失败信息同样脱敏：这里只拼我们自己的错误消息，绝不把 payload 带进响应。
        logger?.warn?.(`[proxy-egress] RPC ${call.method} 失败：${error?.message ?? error}`)
        return fail(rpcId, 'HANDLER_FAILED', String(error?.message ?? error))
      }
    },
  })
}
