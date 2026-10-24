/**
 * 面板覆盖测试。
 *
 * 最重要的一条在最下面：`toRawConfig` **只能**改白名单字段。
 * 面板改不了凭据、改不了监听地址、改不了端口白名单——这些不该因为一次
 * "保存端口" 而被动变化。这条要是破了，症状是"我只改了端口，怎么上游账号没了"。
 *
 * 运行：node --test test/overrides.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearOverrides,
  fieldOrigins,
  normalizeOverrideInput,
  overridesPath,
  readOverrides,
  toRawConfig,
  writeOverrides,
} from '../plugin-src/host/overrides.mjs'

const BASE = {
  listen: { host: '127.0.0.1', port: 8899 },
  upstream: { type: 'http', host: '203.0.113.9', port: 8080, username: 'u1', password: 'p1' },
  credentialSource: 'file',
  credentialFile: 'D:\\keys\\proxy-egress.json',
  allowConnectPorts: [443, 8443],
  expectedEgressIps: ['203.0.113.9'],
  egressMismatchAction: 'warn',
  selfCheck: { enabled: true, url: 'https://api.ipify.org?format=json' },
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-proxy-egress-home-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('输入校验：端口必须是 1-65535 的整数', () => {
  assert.equal(normalizeOverrideInput({ upstreamPort: 0 }).ok, false)
  assert.equal(normalizeOverrideInput({ upstreamPort: 70000 }).ok, false)
  assert.equal(normalizeOverrideInput({ listenPort: 'abc' }).ok, false)
  const good = normalizeOverrideInput({ upstreamPort: '8080', listenPort: 8899 })
  assert.equal(good.ok, true)
  assert.deepEqual(good.value, { upstreamPort: 8080, listenPort: 8899 })
})

test('输入校验：协议与不匹配策略都只认白名单值', () => {
  assert.equal(normalizeOverrideInput({ upstreamType: 'socks5' }).ok, false)
  assert.equal(normalizeOverrideInput({ egressMismatchAction: 'panic' }).ok, false)
  assert.equal(normalizeOverrideInput({ upstreamType: 'https' }).ok, true)
  assert.equal(normalizeOverrideInput({ egressMismatchAction: 'block' }).ok, true)
})

test('输入校验：主机不能为空；期望出口支持逗号/空白分隔', () => {
  assert.equal(normalizeOverrideInput({ upstreamHost: '   ' }).ok, false)
  const result = normalizeOverrideInput({ expectedEgressIps: ' 1.2.3.4, 5.6.7.8  9.9.9.9 ' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.expectedEgressIps, ['1.2.3.4', '5.6.7.8', '9.9.9.9'])
  const emptied = normalizeOverrideInput({ expectedEgressIps: '' })
  assert.deepEqual(emptied.value.expectedEgressIps, [], '清空应当等于"不比对"，不是"没改"')
})

test('输入校验：一个字段都没有时明确拒绝，而不是写一个空覆盖', () => {
  const result = normalizeOverrideInput({})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NOTHING_TO_SAVE')
})

test('叠加：只改白名单字段，其余一律原样保留', () => {
  const raw = toRawConfig(BASE, {
    upstreamHost: '198.51.100.7',
    upstreamPort: 3128,
    listenPort: 18899,
  })

  assert.equal(raw.upstream.host, '198.51.100.7')
  assert.equal(raw.upstream.port, 3128)
  assert.equal(raw.listen.port, 18899)

  // 以下都**不该**被动过
  assert.equal(raw.listen.host, '127.0.0.1', '监听地址是安全边界，面板不得改动')
  assert.equal(raw.upstream.username, 'u1', '凭据不该因为改端口而消失')
  assert.equal(raw.upstream.password, 'p1')
  assert.equal(raw.credentialSource, 'file')
  assert.equal(raw.credentialFile, 'D:\\keys\\proxy-egress.json')
  assert.deepEqual(raw.allowConnectPorts, [443, 8443])
  assert.deepEqual(raw.selfCheck, BASE.selfCheck)
})

test('叠加：原始配置不被就地修改', () => {
  const before = JSON.stringify(BASE)
  toRawConfig(BASE, { upstreamPort: 1, listenPort: 2, expectedEgressIps: [] })
  assert.equal(JSON.stringify(BASE), before)
})

test('叠加：没有覆盖时等于原配置的深拷贝', () => {
  const raw = toRawConfig(BASE, null)
  assert.deepEqual(raw, BASE)
  raw.upstream.host = 'changed'
  assert.equal(BASE.upstream.host, '203.0.113.9', '深拷贝，不能把原对象一起改了')
})

test('来源标注：哪些字段被面板盖住了，必须能说清', () => {
  const origins = fieldOrigins({ upstreamHost: 'x', listenPort: 1 })
  assert.equal(origins.upstreamHost, 'panel')
  assert.equal(origins.listenPort, 'panel')
  assert.equal(origins.upstreamType, 'config')
  assert.equal(origins.expectedEgressIps, 'config')
  assert.equal(fieldOrigins(null).upstreamHost, 'config')
})

test('落盘与回读：往返一致，且路径在 $DSH_HOME/proxy-egress 下', async () => {
  await withTempHome(async (home) => {
    assert.equal(overridesPath(home), join(home, 'proxy-egress', 'settings.json'))
    assert.equal(await readOverrides(home), null, '没写过时应当返回 null')

    const written = await writeOverrides(home, { upstreamPort: 3128, expectedEgressIps: ['1.2.3.4'] })
    assert.equal(written.ok, true)

    const read = await readOverrides(home)
    assert.equal(read.values.upstreamPort, 3128)
    assert.deepEqual(read.values.expectedEgressIps, ['1.2.3.4'])
    assert.match(read.savedAt, /^\d{4}-\d{2}-\d{2}T/)

    const text = await readFile(overridesPath(home), 'utf8')
    assert.equal(text.charCodeAt(0), '{'.charCodeAt(0), '不能带 BOM')

    await clearOverrides(home)
    assert.equal(await readOverrides(home), null)
  })
})

test('回读：白名单外的键被丢弃（状态文件被外部塞东西也不生效）', async () => {
  await withTempHome(async (home) => {
    await writeOverrides(home, { upstreamPort: 3128, allowConnectPorts: [80], listenHost: '0.0.0.0' })
    const read = await readOverrides(home)
    assert.equal(read.values.upstreamPort, 3128)
    assert.equal(read.values.allowConnectPorts, undefined)
    assert.equal(read.values.listenHost, undefined)
  })
})
