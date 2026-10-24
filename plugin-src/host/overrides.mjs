/**
 * 面板可改项（overrides）：把"能从设置面板改的东西"从启动配置里分出来。
 *
 * ── 为什么不直接改 cordis.patch.yml ──────────────────────────────────────
 *   那是**宿主启动配置**。面板一次手误写坏 YAML，代价是宿主起不来 ——
 *   而"人看得见、能点错"的界面，恰恰是最容易写出非法值的入口。
 *   写自己的状态文件，最坏结果只是这个代理起不来，且还能从面板改回来。
 *
 * ── 优先级（与 v0.2 设计一致）──────────────────────────────────────────
 *   硬编码默认  <  装载行 config  <  面板覆盖（本文件）
 *   每个字段在面板上都要标出"当前值来自哪一层"，两个来源打架时必须看得见。
 *
 * ── 一条硬边界 ────────────────────────────────────────────────────────
 *   `listen.host` **不在这里**：它必须是回环，且只能由启动配置决定。
 *   会注入凭据的代理一旦绑到 0.0.0.0，同网段任何人都能白嫖你的上游账号。
 *
 * @module dsh-proxy-egress/overrides
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 状态文件版本：结构变更时 +1，读到旧版直接忽略（回落到装载行配置）。 */
export const OVERRIDES_VERSION = 1

/** 面板可改的字段白名单。不在表里的字段，面板改了也不认。 */
export const EDITABLE_KEYS = [
  'upstreamType',
  'upstreamHost',
  'upstreamPort',
  'listenPort',
  'expectedEgressIps',
  'egressMismatchAction',
]

/**
 * @param {string} home `$DSH_HOME`
 * @returns {string}
 */
export function overridesPath(home) {
  return join(home, 'proxy-egress', 'settings.json')
}

/**
 * 读面板覆盖。文件不存在 / 版本不符 / 解析失败一律返回 null（回落到配置）。
 * @param {string} home
 * @returns {Promise<null | {values: object, savedAt: string|null}>}
 */
export async function readOverrides(home) {
  let text
  try {
    text = await readFile(overridesPath(home), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (parsed.version !== OVERRIDES_VERSION) return null
  const values = parsed.values !== null && typeof parsed.values === 'object' ? parsed.values : null
  if (values === null) return null
  return { values: pickEditable(values), savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null }
}

/** 只保留白名单内的键，避免状态文件被外部塞入不认识的字段。 */
function pickEditable(values) {
  const out = {}
  for (const key of EDITABLE_KEYS) {
    if (values[key] !== undefined) out[key] = values[key]
  }
  return out
}

/**
 * 写面板覆盖。先写临时文件再 rename —— 中途失败不会留下半个文件。
 * @param {string} home
 * @param {object} values 已经过 {@link normalizeOverrideInput} 校验
 * @returns {Promise<{ok: true, path: string, savedAt: string}>}
 */
export async function writeOverrides(home, values) {
  const path = overridesPath(home)
  const savedAt = new Date().toISOString()
  const body = JSON.stringify({ version: OVERRIDES_VERSION, savedAt, values: pickEditable(values) }, null, 2)
  await mkdir(join(home, 'proxy-egress'), { recursive: true })
  const staging = `${path}.tmp`
  await writeFile(staging, body, 'utf8')
  await rename(staging, path)
  return { ok: true, path, savedAt }
}

/**
 * 清空面板覆盖（恢复为"完全按装载行配置"）。
 * @param {string} home
 * @returns {Promise<{ok: true, removed: boolean}>}
 */
export async function clearOverrides(home) {
  const path = overridesPath(home)
  try {
    await rm(path, { force: true })
  } catch {
    /* 删不掉就当没有；下一次读会自然回落 */
  }
  await rm(`${path}.tmp`, { force: true }).catch(() => {})
  return { ok: true, removed: true }
}

/**
 * 校验面板提交的覆盖值。**纯函数**，不碰文件系统。
 *
 * 只校验"形状"（是不是合法端口、是不是 http/https），
 * 业务级校验（主机名能不能解析、白名单是否为空）交给 normalizeConfig 统一做 ——
 * 两边各校验一遍必然漂移。
 *
 * @param {unknown} payload
 * @returns {{ok: true, value: object} | {ok: false, error: {code: string, message: string, fields?: object}}}
 */
export function normalizeOverrideInput(payload) {
  const record = payload !== null && typeof payload === 'object' ? payload : {}
  /** @type {Record<string, string>} */
  const fields = {}
  const out = {}

  const asPort = (raw, key) => {
    if (raw === undefined || raw === null || raw === '') return
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      fields[key] = '必须是 1-65535 的整数'
      return
    }
    out[key] = value
  }
  asPort(record.upstreamPort, 'upstreamPort')
  asPort(record.listenPort, 'listenPort')

  if (record.upstreamType !== undefined) {
    const type = String(record.upstreamType)
    if (type !== 'http' && type !== 'https') fields.upstreamType = '只支持 http / https'
    else out.upstreamType = type
  }

  if (record.upstreamHost !== undefined) {
    const host = typeof record.upstreamHost === 'string' ? record.upstreamHost.trim() : ''
    if (host === '') fields.upstreamHost = '不能为空'
    else out.upstreamHost = host
  }

  if (record.egressMismatchAction !== undefined) {
    const action = String(record.egressMismatchAction)
    if (action !== 'warn' && action !== 'block') fields.egressMismatchAction = '只支持 warn / block'
    else out.egressMismatchAction = action
  }

  if (record.expectedEgressIps !== undefined) {
    const raw = Array.isArray(record.expectedEgressIps)
      ? record.expectedEgressIps
      : String(record.expectedEgressIps).split(/[,\s]+/)
    const list = raw
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item !== '')
    out.expectedEgressIps = list
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, error: { code: 'INVALID_FIELD', message: '有字段不合法', fields } }
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: { code: 'NOTHING_TO_SAVE', message: '没有可保存的字段' } }
  }
  return { ok: true, value: out }
}

/**
 * 把覆盖值叠到装载行配置上，产出交给 `normalizeConfig` 的原始配置。
 *
 * 刻意**只覆盖白名单字段**，其余（含 upstream.username / credentialFile /
 * allowConnectPorts / listen.host）一律原样保留 —— 面板改不了的东西，
 * 不该因为一次保存而被动改动。
 *
 * @param {object} base 装载行 config
 * @param {null | object} values 覆盖值
 * @returns {object}
 */
export function toRawConfig(base, values) {
  const raw = base !== null && typeof base === 'object' ? structuredClone(base) : {}
  if (values === null || values === undefined) return raw

  raw.listen = raw.listen !== null && typeof raw.listen === 'object' ? raw.listen : {}
  raw.upstream = raw.upstream !== null && typeof raw.upstream === 'object' ? raw.upstream : {}

  if (values.listenPort !== undefined) raw.listen.port = values.listenPort
  if (values.upstreamType !== undefined) raw.upstream.type = values.upstreamType
  if (values.upstreamHost !== undefined) raw.upstream.host = values.upstreamHost
  if (values.upstreamPort !== undefined) raw.upstream.port = values.upstreamPort
  if (values.expectedEgressIps !== undefined) raw.expectedEgressIps = values.expectedEgressIps
  if (values.egressMismatchAction !== undefined) raw.egressMismatchAction = values.egressMismatchAction

  return raw
}

/**
 * 每个可改字段当前的值来自哪一层。面板必须显示这个 ——
 * 否则"改了没生效"和"改了生效但被更高层盖住"看起来一模一样。
 *
 * @param {null | object} values 覆盖值
 * @returns {Record<string, 'panel'|'config'>}
 */
export function fieldOrigins(values) {
  /** @type {Record<string, 'panel'|'config'>} */
  const origins = {}
  for (const key of EDITABLE_KEYS) {
    origins[key] = values !== null && values !== undefined && values[key] !== undefined ? 'panel' : 'config'
  }
  return origins
}
