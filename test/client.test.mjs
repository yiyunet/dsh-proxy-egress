/**
 * 客户端半侧测试：在沙箱里把 `plugin-src/client/client.js` 真跑一遍。
 *
 * 为什么值得单独测：`/plugins` 是拼接 bundle，客户端文件里一个语法错会让
 * **整个 Web UI 的插件加载全灭**，症状还会报在别的插件上。而这份代码不能靠
 * 宿主 HMR 验证（它只在浏览器里执行），所以只能用沙箱把契约钉住。
 *
 * 覆盖四件事：
 *   1. 顶层能执行完（语法与顶层副作用）
 *   2. 用正确的 id 注册到 __ModuleLoader__，且只注册一次
 *   3. factory 能物化出插件面（inject + apply），apply 把面板挂到 settings.section
 *   4. 面板在「还没有状态」这一帧能渲染出来而不抛错（最容易踩的空值路径）
 *
 * 运行：node --test test/client.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import { RPC_ENDPOINT } from '../plugin-src/host/rpc.mjs'

const CLIENT_PATH = new URL('../plugin-src/client/client.js', import.meta.url)
/** 装载器 id：必须是包名（用来匹配 Loader 行）。 */
const PACKAGE_ID = '@yiyunet/dsh-proxy-egress'
/** 设置槽位 id：短名（设置页里的 section key）。两者不可混用。 */
const SECTION_ID = 'dsh-proxy-egress'

/** 最小 React 桩：够 Panel 渲染一帧，不引入真实 React。 */
function createReactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(),
  })
  return {
    createElement,
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    // 刻意不执行副作用：这一帧只验证「无状态时能渲染」。
    useEffect: () => {},
    Fragment: 'Fragment',
  }
}

/** 把渲染树摊平成文本片段（组件节点就地展开调用）。 */
function renderText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) renderText(child, out)
    return out
  }
  if (typeof node?.type === 'function') {
    renderText(node.type(node.props ?? {}), out)
    return out
  }
  for (const child of node?.children ?? []) renderText(child, out)
  return out
}

/** 在沙箱里执行客户端文件，返回它登记到 module-loader 的条目。 */
async function loadClient() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const registrations = []
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    Response,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  }
  sandbox.window = { __ModuleLoader__: { mode: 'queue', load: (entry) => registrations.push(entry) } }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return { registrations, source }
}

test('客户端：顶层执行不抛错，且只注册一次', async () => {
  const { registrations } = await loadClient()
  assert.equal(registrations.length, 1, '应当只登记一次')
  assert.equal(registrations[0].id, PACKAGE_ID)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('客户端：factory 只 require 平台冻结表里的模块', async () => {
  const { registrations } = await loadClient()
  const required = []
  registrations[0].factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return createReactStub()
    throw new Error(`非法依赖：${specifier}`)
  })
  assert.deepEqual([...new Set(required)], ['react'], '客户端只允许依赖 react（其余由平台冻结表提供）')
})

test('客户端：插件面导出 inject 与 apply', async () => {
  const { registrations } = await loadClient()
  const face = registrations[0].factory(() => createReactStub())
  assert.equal(typeof face.apply, 'function')
  assert.ok(Array.isArray(face.inject))
  assert.ok(face.inject.includes('slots'))
  assert.ok(face.inject.includes('connection'))
})

test('客户端：apply 把面板挂到 settings.section，且 RPC 端点名与宿主一致', async () => {
  const { registrations } = await loadClient()
  const face = registrations[0].factory(() => createReactStub())

  const registered = []
  const fakeCtx = {
    slots: {
      inject: (slotName, factory) => {
        assert.equal(slotName, 'settings.section')
        factory()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    connection: {
      rpc: {
        // 断言客户端确实带上了 /api 前缀与端点名
        call: (prefix, endpoint, payload) => {
          assert.equal(prefix, '/api')
          assert.equal(endpoint, RPC_ENDPOINT)
          assert.equal(typeof payload.method, 'string')
          return Promise.resolve({ ok: true, value: {} })
        },
      },
    },
  }

  face.apply(fakeCtx)

  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.section')
  // ⚠️ 槽位 id 用的是**短名**，不是包名。
  // 两个 id 是两件不同的事，混用会静默失败（侧栏里什么都没有，日志里也没有错）：
  //   · __ModuleLoader__.load({ id }) 必须是**包名** —— 装载器要拿它匹配 Loader 行
  //   · ctx.slots.register({ id })    用**短名** —— 同 dsh-mcp-client-manager 的
  //     'dsh-mcp-client-manager'（其包名是 @yiyunet/dsh-mcp-client-manager）
  assert.equal(options.id, SECTION_ID)
  assert.notEqual(SECTION_ID, PACKAGE_ID, '槽位 id 与包名不应相同，二者用途不同')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '出口代理')
  assert.equal(typeof component, 'function')

  const injected = options.inject()
  assert.equal(typeof injected.rpc, 'function')
  await injected.rpc('state', {}) // 走一次，验证 call 的参数契约
})

test('客户端：无状态时能渲染一帧（空值路径不抛错）', async () => {
  const { registrations } = await loadClient()
  const face = registrations[0].factory(() => createReactStub())

  let component
  face.apply({
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, panel) => { component = panel; return () => {} },
    },
    connection: { rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } },
  })

  const tree = component({ rpc: () => Promise.resolve({ ok: true, value: {} }) })
  const text = renderText(tree).join(' | ')

  for (const expected of ['出口代理', '验证', '上游与监听', '凭据', '能力边界', '读取中']) {
    assert.ok(text.includes(expected), `面板文本里应当出现「${expected}」，实际：${text.slice(0, 300)}`)
  }
})

test('客户端：源码里不得出现对非 react 模块的 require', async () => {
  const { source } = await loadClient()
  const bad = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('react'))
  assert.deepEqual(bad, [], `客户端引入了平台表之外的模块：${bad.join(', ')}`)
})
