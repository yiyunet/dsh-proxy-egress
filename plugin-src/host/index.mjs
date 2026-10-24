/**
 * dsh-proxy-egress —— 插件入口（宿主半侧，唯一真源）。
 *
 * 【它解决什么问题】
 *   有一类消费方（模型供应商插件等）只肯接受**不含账号密码**的 HTTP(S) 代理地址；
 *   而手上的上游代理恰恰是「账号:密码@IP:端口」。
 *   这个插件在本机回环上开一个**无需认证**的转发代理：
 *     消费方 → http://127.0.0.1:8899 → （注入 Proxy-Authorization）→ 带认证的上游 → 目标
 *
 * 【它保证什么（L1，代码级）】
 *   进入本地监听的每一条连接只能经上游转发；上游不可达/认证失败/拒绝/超时一律断联，
 *   **不直连目标、不降级重试、无任何开关可以打开直连**。
 *
 * 【它不保证什么】
 *   消费方是否真的把请求交给本监听（L2）。消费方可以绕过代理直连，本插件管不了；
 *   要可证明的强制出口，必须叠加系统网络隔离，那部分单独验收。
 *
 * 【为什么工具里没有"设置密码"】
 *   `defineTool` 注册的是**模型可调用工具**：参数会进入对话记录、工具调用日志与宿主审计。
 *   让密码走这条路等于主动泄漏。因此：
 *     - 凭据只能来自装载行 config 或独立凭据文件；
 *     - 工具只查状态、只跑验证、只重启，且回传里只有指纹（sha256 前 8 位）。
 *
 * 【为什么工具不是终端命令】
 *   `ctx.tools.register` 给的是模型工具，不是 shell 命令。若需要 `egress status` 这类
 *   终端入口，必须另外实现 CLI——两者不是一回事。
 *
 * @module @yiyunet/dsh-proxy-egress
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { describeConfig, normalizeConfig } from './config.mjs'
import { CredentialError, credentialFileBody, parseCredentialInput, resolveCredentials } from './credentials.mjs'
import {
  clearOverrides, fieldOrigins, normalizeOverrideInput, readOverrides, toRawConfig, writeOverrides,
} from './overrides.mjs'
import { createEgressProxy } from './proxy.mjs'
import { registerPanelRpc } from './rpc.mjs'
import { runFaultCheck, runSelfCheck } from './verify.mjs'

export const name = 'proxy-egress'
export const inject = ['tools']

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const ok = (payload) => JSON.stringify(payload, null, 2)

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} [rawConfig] 装载行里的 config
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger
  /** 装载行原样保留：面板覆盖是叠在它上面的，不是替换它。 */
  const baseRaw = rawConfig
  /** 生效配置。面板保存覆盖后会重算，所以是 let。 */
  let parsed = normalizeConfig(baseRaw)
  /** 面板覆盖值；null = 完全按装载行配置。 */
  let overrides = null
  let overrideError = null
  /** `$DSH_HOME`：profileContext 就绪后填充，之前用环境变量/家目录兜底。 */
  let home = null
  ctx.inject(['profileContext'], (profileCtx) => {
    const value = profileCtx?.profileContext?.home
    if (typeof value === 'string' && value !== '') home = value
  })
  const homeDir = () => home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')

  /** 运行期状态（不进 config，不上报凭据）。 */
  const runtime = {
    credential: null,
    credentialError: null,
    lastSelfCheck: null,
    lastFaultCheck: null,
    disposed: false,
  }

  /** @type {ReturnType<typeof createEgressProxy> | null} */
  let proxy = null
  let credentials = null

  // ── 面板覆盖（顶层配置 < 面板）────────────────────────────────────────────
  /**
   * 重读面板覆盖并重算生效配置。
   *
   * 关键行为：**覆盖值不合法时回退到装载行配置**，而不是让插件起不来。
   * 否则一个手误的值会把人锁在门外——而纠正它的入口恰恰是这个插件自己的面板。
   */
  async function reloadOverrides() {
    overrideError = null
    try {
      overrides = await readOverrides(homeDir())
    } catch (error) {
      overrides = null
      overrideError = { code: 'OVERRIDES_UNREADABLE', message: String(error?.message ?? error) }
    }

    const merged = normalizeConfig(toRawConfig(baseRaw, overrides === null ? null : overrides.values))
    if (merged.ok) {
      parsed = merged
      return
    }
    parsed = normalizeConfig(baseRaw)
    overrideError = {
      code: 'OVERRIDES_INVALID',
      message: '面板保存的覆盖值无法通过配置校验，已回退到装载行配置',
      errors: merged.errors,
    }
    logger?.warn?.(`[proxy-egress] ${overrideError.message}`)
  }

  /** 覆盖状态（展示用）。路径符号化，不回传绝对路径。 */
  function overridesView() {
    const values = overrides === null ? null : overrides.values
    return {
      path: '$DSH_HOME/proxy-egress/settings.json',
      active: values !== null,
      savedAt: overrides === null ? null : overrides.savedAt,
      values,
      // 每个字段当前来自哪一层 —— 不显示这个，"改了没生效"无法与"被更高层盖住"区分。
      origins: fieldOrigins(values),
      error: overrideError,
    }
  }

  /** 保存面板覆盖：先内存校验，不通过就不写盘。 */
  async function saveOverrides(payload = {}) {
    const input = normalizeOverrideInput(payload)
    if (!input.ok) return input

    const probe = normalizeConfig(toRawConfig(baseRaw, input.value))
    if (!probe.ok) {
      return {
        ok: false,
        error: { code: 'OVERRIDES_INVALID', message: '这些值无法通过配置校验，未保存', errors: probe.errors },
      }
    }
    try {
      await writeOverrides(homeDir(), input.value)
    } catch (error) {
      return {
        ok: false,
        error: { code: 'WRITE_FAILED', message: `写入面板设置失败：${error?.code ?? String(error?.message ?? error)}` },
      }
    }
    await reloadOverrides()
    const restarted = await reloadAndRestart()
    return restarted.ok
      ? { ok: true, restarted: true, status: buildStatus() }
      : { ok: false, restarted: false, error: restarted.error, status: buildStatus() }
  }

  /** 清空面板覆盖（恢复为完全按装载行配置）。 */
  async function clearPanelOverrides() {
    await clearOverrides(homeDir())
    await reloadOverrides()
    const restarted = await reloadAndRestart()
    return restarted.ok
      ? { ok: true, restarted: true, status: buildStatus() }
      : { ok: false, restarted: false, error: restarted.error, status: buildStatus() }
  }

  /**
   * 删除已保存的凭据。
   *
   * 删完之后代理**通常起不来**（上游要认证）——这是预期结果，不是故障。
   * 所以返回值里 `cleared: true` 与 `restarted: false` 可以同时成立，
   * 面板要按「已清除，等待重新录入」来显示，而不是报错。
   */
  async function clearCredential() {
    if (!parsed.ok) return { ok: false, cleared: false, error: { code: 'CONFIG_INVALID', message: '配置校验未通过' } }
    if (parsed.value.credentialSource !== 'file') {
      return {
        ok: false,
        cleared: false,
        error: { code: 'NOT_FILE_MODE', message: '当前 credentialSource 不是 file，凭据不归面板管' },
      }
    }
    try {
      await rm(parsed.value.credentialFile, { force: true })
    } catch (error) {
      return {
        ok: false,
        cleared: false,
        error: { code: 'DELETE_FAILED', message: `删除凭据文件失败：${error?.code ?? String(error?.message ?? error)}` },
      }
    }
    const restarted = await reloadAndRestart()
    return {
      ok: restarted.ok,
      cleared: true,
      restarted: restarted.ok,
      note: restarted.ok
        ? '凭据文件已删除；上游无需认证，代理已重新启动'
        : '凭据文件已删除。上游需要认证，因此代理已停止——重新录入凭据即可恢复',
      ...(restarted.ok ? { fingerprint: restarted.fingerprint } : { error: restarted.error }),
      status: buildStatus(),
    }
  }

  function configView() {
    return parsed.ok
      ? { ok: true, ...describeConfig(parsed.value), warnings: parsed.warnings }
      : { ok: false, errors: parsed.errors }
  }

  function buildStatus() {
    return {
      plugin: '@yiyunet/dsh-proxy-egress',
      ok: proxy !== null && proxy.state === 'listening',
      config: configView(),
      overrides: overridesView(),
      credential: {
        configured: credentials !== null,
        source: credentials === null ? null : credentials.source,
        // 只给指纹：够确认"当前加载的是哪一份"，不够反推。
        fingerprint: credentials === null ? null : credentials.fingerprint,
        error: runtime.credentialError,
      },
      proxy: proxy === null ? { state: 'not-started' } : proxy.snapshot(),
      lastSelfCheck: runtime.lastSelfCheck,
      lastFaultCheck: runtime.lastFaultCheck,
      consumerHint: parsed.ok
        ? {
          // 消费方该填的地址：**不带任何凭据**，这正是本插件存在的理由。
          proxyUrlForConsumer: `http://${parsed.value.listen.host}:${parsed.value.listen.port}`,
          note: '把消费方的代理地址填成上面这个值即可；账号密码由本插件在上游那一跳注入，消费方永远看不到。',
        }
        : null,
      boundary: {
        guarantees: '进入本地监听的连接只经上游转发；失败即断联，不直连目标，无直连开关',
        doesNotGuarantee: '消费方是否绕过代理（L2）；系统级强制出口未实现、未验收（L3）',
      },
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────
  // 用 ctx.effect：插件卸载时自动跑清理，卸载后不留监听端口、不留 socket。
  ctx.effect(() => {
    const boot = (async () => {
      // 先叠面板覆盖，再决定能不能启动（顺序反了会用旧拓扑去连一次）。
      await reloadOverrides()
      if (!parsed.ok) {
        logger?.error?.(`[proxy-egress] 配置校验未通过，插件不启动，也不监听任何端口：${
          parsed.errors.map((item) => `${item.field}: ${item.message}`).join('；')}`)
        return
      }
      try {
        credentials = await resolveCredentials(parsed.value)
        runtime.credential = credentials === null
          ? { configured: false }
          : { configured: true, source: credentials.source, fingerprint: credentials.fingerprint }
      } catch (error) {
        runtime.credentialError = error instanceof CredentialError
          ? { code: error.code, message: error.message }
          : { code: 'CREDENTIAL_UNKNOWN', message: String(error?.message ?? error) }
        logger?.error?.(`[proxy-egress] 凭据解析失败，插件不启动：${runtime.credentialError.message}`)
        return
      }

      if (runtime.disposed) return

      const instance = createEgressProxy({ config: parsed.value, credentials, logger })
      try {
        await instance.start()
      } catch (error) {
        // 启动失败不能静默：状态里要留痕，但绝不能因此掀掉宿主进程。
        logger?.error?.(`[proxy-egress] 启动失败：${error?.code ?? ''} ${error?.message ?? String(error)}`)
        return
      }
      if (runtime.disposed) {
        // 启动期间插件已被卸载：立刻回收，不留孤儿监听。
        await instance.stop().catch(() => undefined)
        return
      }
      proxy = instance
    })()

    // 显式吞掉 rejection：`void boot` 会让失败变成未处理拒绝。
    boot.catch((error) => {
      logger?.error?.(`[proxy-egress] 初始化异常：${error?.message ?? String(error)}`)
    })

    return () => {
      runtime.disposed = true
      const current = proxy
      proxy = null
      return current === null ? undefined : current.stop().catch(() => undefined)
    }
  }, 'dsh-proxy-egress')

  // ── 重读凭据 → 停旧实例 → 起新实例（restart 工具与面板保存凭据共用）─────────
  async function reloadAndRestart() {
    if (!parsed.ok) {
      return { ok: false, error: { code: 'CONFIG_INVALID', message: '配置校验未通过，插件没有启动', details: parsed.errors } }
    }
    try {
      credentials = await resolveCredentials(parsed.value)
      runtime.credentialError = null
      runtime.credential = credentials === null
        ? { configured: false }
        : { configured: true, source: credentials.source, fingerprint: credentials.fingerprint }
    } catch (error) {
      runtime.credentialError = error instanceof CredentialError
        ? { code: error.code, message: error.message }
        : { code: 'CREDENTIAL_UNKNOWN', message: String(error?.message ?? error) }
      return { ok: false, error: runtime.credentialError }
    }

    if (proxy !== null) {
      await proxy.stop().catch(() => undefined)
      proxy = null
    }
    const instance = createEgressProxy({ config: parsed.value, credentials, logger })
    try {
      await instance.start()
    } catch (error) {
      return {
        ok: false,
        error: { code: 'START_FAILED', message: `${error?.code ?? ''} ${error?.message ?? String(error)}`.trim() },
      }
    }
    proxy = instance
    return { ok: true, fingerprint: credentials === null ? null : credentials.fingerprint }
  }

  /**
   * 面板专用：把凭据写进独立凭据文件。
   *
   * **这是全项目唯一合法的凭据写入口**（人的输入通道）。模型工具永远收不到密码：
   * 工具参数会进对话记录、工具调用日志与宿主审计。
   * 写入后立刻重读并重启，返回值只给指纹。
   */
  async function saveCredential(payload = {}) {
    if (!parsed.ok) return { ok: false, error: { code: 'CONFIG_INVALID', message: '配置校验未通过' } }
    if (parsed.value.credentialSource !== 'file') {
      return { ok: false, error: { code: 'NOT_FILE_MODE', message: '当前 credentialSource 不是 file，凭据不由面板接管' } }
    }
    const input = parseCredentialInput(payload)
    if (!input.ok) return input
    const { username, password } = input.value

    const filePath = parsed.value.credentialFile
    try {
      await mkdir(dirname(filePath), { recursive: true })
      // 只写这两个键，不落任何注释或元数据；密码原样写入（不做 trim）。
      await writeFile(filePath, credentialFileBody(username, password), { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      return {
        ok: false,
        error: { code: 'WRITE_FAILED', message: `写入凭据文件失败：${error?.code ?? String(error?.message ?? error)}` },
      }
    }

    const result = await reloadAndRestart()
    return result.ok ? { ok: true, fingerprint: result.fingerprint } : result
  }

  // ── 面板/工具共用的一套方法。铁律：返回值里**永不出现密码**。──────────────
  const api = {
    async state() {
      return buildStatus()
    },
    async selfcheck() {
      if (proxy === null) {
        return {
          ok: false,
          check: 'proxy-link',
          result: 'LISTENER_DOWN',
          detail: parsed.ok ? '代理尚未启动（见状态卡）' : '配置校验未通过，插件没有启动',
        }
      }
      const result = await runSelfCheck(proxy, parsed.value)
      runtime.lastSelfCheck = result
      return result
    },
    async faultcheck() {
      if (!parsed.ok) return { ok: false, check: 'fault-injection', result: 'CONFIG_INVALID', errors: parsed.errors }
      const result = await runFaultCheck(parsed.value, credentials, logger)
      runtime.lastFaultCheck = result
      return result
    },
    async restart() {
      const result = await reloadAndRestart()
      return result.ok
        ? { ok: true, restarted: true, status: buildStatus() }
        : { ok: false, restarted: false, error: result.error }
    },
    async saveCredential(payload) {
      return saveCredential(payload)
    },
    async clearCredential() {
      return clearCredential()
    },
    async saveOverrides(payload) {
      return saveOverrides(payload)
    },
    async clearOverrides() {
      return clearPanelOverrides()
    },
  }

  // connection 只在 web 平面存在 → 必须走可选注入。
  // 写进顶层 inject 会让插件在 headless/tui 平面永远停在 inactive。
  ctx.inject(['connection'], (rpcCtx) => registerPanelRpc(rpcCtx, api, logger))

  // ── 工具 ①：状态 ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'proxy_egress_status',
    description: '查看本地出口代理的状态：监听地址、上游（脱敏）、凭据是否已加载（只给指纹）、'
      + '当前连接数、最近失败原因、是否处于阻断态，以及消费方该填的代理地址。'
      + '不产生任何写操作，也不回传任何凭据。',
    parameters: {},
    output: textOutput,
    async execute() {
      return ok(await api.state())
    },
  }))

  // ── 工具 ②：代理链路检查 ─────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'proxy_egress_selfcheck',
    description: '经本地监听 → 上游 → 回显服务，量一次**实际出口 IP**，并与 expectedEgressIps 比对。'
      + '返回分类结果（OK / EGRESS_IP_MISMATCH / UPSTREAM_UNREACHABLE / UPSTREAM_AUTH_FAILED / '
      + 'LISTENER_DOWN / CHECK_SERVICE_UNAVAILABLE 等）。'
      + '注意：它只代表访问该回显服务时的出口，不能推论模型 API 走同一出口。',
    parameters: {},
    output: textOutput,
    async execute() {
      return ok(await api.selfcheck())
    },
  }))

  // ── 工具 ③：故障注入检查 ─────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'proxy_egress_faultcheck',
    description: '证明本插件在上游坏掉时**不会直连目标**：另起一个独立实例指向"坏上游"，'
      + '把 CONNECT 目标设成一个本机诱饵监听，然后看诱饵有没有被连过。'
      + '诱饵收到连接 = 存在直连行为（BUG）。全程使用独立配置，不动生产实例。'
      + '边界：只证明本插件不直连，不证明消费方不绕过代理。',
    parameters: {},
    output: textOutput,
    async execute() {
      return ok(await api.faultcheck())
    },
  }))

  // ── 工具 ④：重启 ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'proxy_egress_restart',
    description: '重启本地出口代理（改了凭据文件、换了上游之后用）。'
      + '会重新读取凭据文件并重新监听；端口被占用时不会自增换端口，而是直接报错。'
      + '注意：本工具不能设置账号密码——凭据请用设置面板或直接编辑凭据文件。',
    parameters: {},
    output: textOutput,
    async execute() {
      return ok(await api.restart())
    },
  }))
}
