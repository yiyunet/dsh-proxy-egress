/**
 * dsh-proxy-egress —— 浏览器半侧（设置 → 侧栏「出口代理」面板）。
 *
 * 零构建：本文件就是官方 module-loader 的工厂格式，由 dsh-client-modules 从
 * package.json 的 `exports["./client"]` 取用，挂到「说明符恰为包名」的那一行 Loader 行上。
 *
 * ── 面板能做什么，不能做什么（与宿主侧 G8 一致）──────────────────────────
 *   ✅ 看状态：监听、上游（脱敏）、凭据是否已配置（只给指纹）、连接计数、最近失败
 *   ✅ 触发验证：代理链路检查 / 故障注入检查 / 重启
 *   ✅ **录入凭据**：人工在这里敲账号密码，宿主写进凭据文件 —— 这是唯一合法的凭据入口
 *   ❌ 绝不回显密码；宿主只回「已配置 + 指纹」，所以输入框永远从空开始
 *   ❌ 不编辑 cordis.patch.yml（那是启动配置，改错了宿主起不来）
 *
 * 为什么凭据能进面板却不能进模型工具：面板是**人的输入通道**，工具是**模型的输入通道**。
 * 模型工具的参数会进对话记录、工具调用日志与宿主审计；人在这里敲的密码只走本机 HTTP。
 *
 * RPC：ctx.connection.rpc.call('/api', 'proxy-egress', { method, payload })
 */

window.__ModuleLoader__.load({
  id: '@yiyunet/dsh-proxy-egress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** RPC 端点名（不含 /api/ 前缀），必须与宿主一致。 */
    const RPC_ENDPOINT = 'proxy-egress'
    const POLL_MS = 5000

    // ── 样式（内联；只取主题 token，禁自带皮肤）─────────────────────────────
    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.7 },
      card: { border: '1px solid var(--dsh-border, #e3e5e8)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
      title: { fontSize: 13, fontWeight: 600, margin: '0 0 8px' },
      note: { opacity: 0.72, fontSize: 12, margin: '0 0 8px' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 },
      kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', fontSize: 12 },
      k: { opacity: 0.65 },
      v: { fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' },
      input: { flex: '1 1 200px', minWidth: 150, padding: '6px 8px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5 },
      select: { padding: '6px 8px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5, background: 'transparent', color: 'inherit' },
      btn: { padding: '5px 12px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      btnPrimary: { padding: '5px 12px', fontSize: 13, border: '1px solid transparent', borderRadius: 5, cursor: 'pointer', background: 'var(--dsh-accent, #3b6cf0)', color: '#fff' },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      ok: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(32,160,90,.16)' },
      bad: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(200,60,60,.16)' },
      warn: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(210,150,20,.18)' },
      idle: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(127,127,127,.16)' },
      errBox: { border: '1px solid rgba(200,60,60,.45)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: 12, whiteSpace: 'pre-wrap' },
      warnBox: { border: '1px solid rgba(210,150,20,.45)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: 12 },
      field: { marginBottom: 9 },
      label: { display: 'block', fontSize: 12, opacity: 0.75, marginBottom: 3 },
      actions: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
    }

    const Btn = (props) => h('button', {
      type: 'button',
      style: props.kind === 'primary' ? S.btnPrimary : S.btn,
      disabled: props.disabled === true,
      onClick: props.disabled === true ? undefined : props.onClick,
    }, props.label)

    const Badge = (props) => h('span', { style: props.tone || S.idle }, props.text)

    const KV = (props) => h('div', { style: S.kv },
      h('span', { style: S.k }, props.k),
      h('span', { style: S.v }, props.v))

    /** 状态徽章：把宿主状态翻成一眼能懂的颜色。 */
    function stateBadge(state) {
      if (state === 'listening') return h(Badge, { tone: S.ok, text: '运行中' })
      if (state === 'error') return h(Badge, { tone: S.bad, text: '启动失败' })
      if (state === 'not-started') return h(Badge, { tone: S.warn, text: '未启动' })
      return h(Badge, { tone: S.idle, text: String(state) })
    }

    /** 检查结果 → 徽章。⚠️ 分类必须忠实显示，不能把「被拒」说成「连不上」。 */
    function resultTone(result) {
      if (result === 'OK') return S.ok
      if (result === 'EGRESS_IP_MISMATCH') return S.warn
      return S.bad
    }

    function Panel(props) {
      // ⚠️ rpc 来自 slots 的 inject()，每次渲染都可能是一个**新函数**。
      // 直接把它放进 useCallback/useEffect 的依赖 → 依赖每次都变 → 轮询定时器每次重建
      // → load() 立刻 setState → 再渲染 → 无限循环，打开面板就把页面卡死。
      // 所以用 ref 固定它，让 load 的依赖真正为空。
      const rpcRef = React.useRef(props.rpc)
      rpcRef.current = props.rpc
      const rpc = React.useCallback((method, payload, signal) => rpcRef.current(method, payload, signal), [])
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [user, setUser] = React.useState('')
      const [pass, setPass] = React.useState('')
      const [credMsg, setCredMsg] = React.useState('')
      const [panelMsg, setPanelMsg] = React.useState('')
      // 表单初值只在第一次 status 时填一次；之后轮询不再覆盖用户正在编辑的内容。
      const formRef = React.useRef(null)
      const [form, setForm] = React.useState(null)

      const load = React.useCallback(() => {
        return rpc('state', {})
          .then((value) => {
            // 宿主用 ok:true 回包、把 ok/false 留在载荷里。但若拿到的是错误信封
            // （ok:false + error，例如未知方法），要显式报出来，别当成状态渲染。
            if (value && value.ok === false && value.error) {
              throw new Error(value.error.message || value.error.code || 'RPC 失败')
            }
            if (formRef.current === null && value && value.config && value.config.ok !== false) {
              const upstreamOf = value.config.upstream || {}
              const listenText = String(
                (value.proxy && value.proxy.listenConfigured) || value.config.listen || '',
              )
              const next = {
                upstreamType: upstreamOf.type || 'http',
                upstreamHost: upstreamOf.host || '',
                upstreamPort: String(upstreamOf.port === undefined ? '' : upstreamOf.port),
                listenPort: listenText.slice(listenText.lastIndexOf(':') + 1),
                expectedEgressIps: ((value.proxy && value.proxy.expectedEgressIps) || []).join(', '),
                egressMismatchAction: (value.proxy && value.proxy.egressMismatchAction) || 'warn',
              }
              formRef.current = next
              setForm(next)
            }
            setState(value)
            setError('')
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
      }, [rpc])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const run = (method, payload) => {
        setBusy(method)
        setCredMsg('')
        // 结果由宿主的 lastSelfCheck / lastFaultCheck 承载，这里只需重取一次状态。
        return rpc(method, payload || {})
          .then(() => { setError(''); return load() })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(''))
      }

      const saveCredential = () => {
        if (user === '' || pass === '') { setCredMsg('账号与密码都要填'); return }
        setBusy('saveCredential')
        rpc('saveCredential', { username: user, password: pass })
          .then((res) => {
            // 无论成败都不把密码留在内存里
            setPass('')
            setUser('')
            setCredMsg(res && res.ok === true
              ? `已写入凭据文件并重启代理（指纹 ${res.fingerprint}）`
              : `保存失败：${res && res.error ? res.error.message : '未知原因'}`)
            return load()
          })
          .catch((err) => {
            setPass('')
            setCredMsg(`保存失败：${String(err && err.message ? err.message : err)}`)
          })
          .finally(() => setBusy(''))
      }

      const setField = (key, value) => {
        const next = { ...(formRef.current || {}), [key]: value }
        formRef.current = next
        setForm(next)
      }

      const saveOverrides = () => {
        const current = formRef.current
        if (current === null) return
        setBusy('saveOverrides')
        setPanelMsg('')
        rpc('saveOverrides', current)
          .then((res) => {
            if (res && res.ok === true) {
              // 让下一次 load 重新从宿主取生效值（含"来源"标记）
              formRef.current = null
              setPanelMsg('已保存，代理已按新设置重启')
            } else {
              const errors = res && res.error && Array.isArray(res.error.errors) ? res.error.errors : null
              setPanelMsg(errors
                ? `保存失败：${errors.map((item) => `${item.field}: ${item.message}`).join('；')}`
                : `保存失败：${res && res.error ? res.error.message : '未知原因'}`)
            }
            return load()
          })
          .catch((err) => setPanelMsg(`保存失败：${String(err && err.message ? err.message : err)}`))
          .finally(() => setBusy(''))
      }

      const restoreOverrides = () => {
        setBusy('clearOverrides')
        setPanelMsg('')
        rpc('clearOverrides', {})
          .then(() => {
            formRef.current = null
            setPanelMsg('已恢复为配置文件里的值')
            return load()
          })
          .catch((err) => setPanelMsg(`恢复失败：${String(err && err.message ? err.message : err)}`))
          .finally(() => setBusy(''))
      }

      const clearCredential = () => {
        setBusy('clearCredential')
        setCredMsg('')
        rpc('clearCredential', {})
          .then((res) => {
            setPass('')
            setUser('')
            // cleared 与 restarted 可以同时"true / false"：删掉了凭据，代理自然起不来，
            // 这是预期状态，不能显示成"操作失败"。
            setCredMsg(res && res.note ? res.note : '凭据已清除')
            return load()
          })
          .catch((err) => setCredMsg(`清除失败：${String(err && err.message ? err.message : err)}`))
          .finally(() => setBusy(''))
      }

      const proxy = (state && state.proxy) || { state: 'not-started' }
      const credential = (state && state.credential) || { configured: false }
      const config = state && state.config
      const upstream = (config && config.upstream) || (proxy.upstream) || {}
      const lastCheck = (state && state.lastSelfCheck) || null
      const lastFault = (state && state.lastFaultCheck) || null

      // ── 状态卡 ────────────────────────────────────────────────────────────
      const statusCard = h('div', { style: S.card },
        h('div', { style: S.row },
          h('span', { style: S.title }, '出口代理'),
          stateBadge(proxy.state),
          h(Btn, { label: busy === 'state' ? '刷新中…' : '刷新', disabled: busy !== '', onClick: () => { setBusy('state'); load().finally(() => setBusy('')) } })),
        state === null
          ? h('p', { style: S.note }, '读取中…')
          : h('div', null,
            h(KV, { k: '本地监听', v: proxy.listen || (config && config.listen) || '—' }),
            h(KV, { k: '上游代理', v: `${upstream.type || '?'}://${upstream.host || '?'}:${upstream.port || '?'}` }),
            h(KV, {
              k: '凭据',
              v: credential.configured === true
                ? `已配置（来源 ${credential.source}，指纹 ${credential.fingerprint}）`
                : `未配置${credential.error ? `：${credential.error.code}` : ''}`,
            }),
            h(KV, { k: '出口钉定', v: (proxy.expectedEgressIps && proxy.expectedEgressIps.length > 0)
              ? `${proxy.expectedEgressIps.join(', ')}（不匹配时 ${proxy.egressMismatchAction}）`
              : '未设置（只报告，不比对）' }),
            h(KV, { k: '连接', v: `当前 ${(proxy.connections && proxy.connections.total) || 0}；`
              + `累计隧道 ${(proxy.stats && proxy.stats.connectEstablished) || 0} 成功 / `
              + `${(proxy.stats && proxy.stats.connectFailed) || 0} 失败` }),
            proxy.blocked ? h(KV, { k: '阻断态', v: proxy.blocked.reason }) : null,
            proxy.lastFailure
              ? h(KV, { k: '最近失败', v: `${proxy.lastFailure.reason} — ${proxy.lastFailure.detail}` })
              : null,
            proxy.lastError ? h(KV, { k: '错误', v: proxy.lastError }) : null),

        (state && state.consumerHint)
          ? h('p', { style: S.note },
            '消费方该填的代理地址：',
            h('span', { style: S.mono }, state.consumerHint.proxyUrlForConsumer),
            ' —— 不带账号密码，凭据由本插件在上游那一跳注入。')
          : null)

      // ── 验证卡 ────────────────────────────────────────────────────────────
      const verifyCard = h('div', { style: S.card },
        h('div', { style: S.title }, '验证'),
        h('p', { style: S.note },
          '三件事互不代替：链路检查只说明“那一刻这条路径”的出口；故障注入只说明本插件不直连；'
          + '消费方是否真的走代理，只能看下面的连接计数在真实请求后有没有增长。'),
        h('div', { style: S.actions },
          h(Btn, { label: busy === 'selfcheck' ? '检查中…' : '代理链路检查', disabled: busy !== '', onClick: () => run('selfcheck') }),
          h(Btn, { label: busy === 'faultcheck' ? '注入中…' : '故障注入检查', disabled: busy !== '', onClick: () => run('faultcheck') }),
          h(Btn, { label: busy === 'restart' ? '重启中…' : '重启代理', disabled: busy !== '', onClick: () => run('restart') })),

        lastCheck
          ? h('div', { style: { marginTop: 10 } },
            h('div', { style: S.row },
              h('span', { style: S.title }, '最近一次链路检查'),
              h('span', { style: resultTone(lastCheck.result) }, lastCheck.result)),
            h(KV, { k: '观测出口', v: lastCheck.observedEgressIp || '—' }),
            h(KV, { k: '比对', v: lastCheck.matched === null ? '未配置期望值' : (lastCheck.matched ? '与期望一致' : '与期望不一致') }),
            h(KV, { k: '说明', v: lastCheck.detail || '—' }),
            lastCheck.caveat ? h('p', { style: S.note }, lastCheck.caveat) : null)
          : null,

        lastFault
          ? h('div', { style: { marginTop: 10 } },
            h('div', { style: S.row },
              h('span', { style: S.title }, '最近一次故障注入'),
              h('span', { style: lastFault.ok ? S.ok : S.bad }, lastFault.result)),
            h(KV, { k: '诱饵连接数', v: String(lastFault.baitConnections) }),
            h(KV, { k: '客户端结果', v: lastFault.clientOutcome || '—' }),
            lastFault.caveat ? h('p', { style: S.note }, lastFault.caveat) : null)
          : null)

      // ── 凭据卡 ────────────────────────────────────────────────────────────
      const canEdit = config && config.credentialSource === 'file'
      const credentialCard = h('div', { style: S.card },
        h('div', { style: S.title }, '凭据'),
        h('p', { style: S.note },
          canEdit
            ? '在这里录入上游代理的账号密码，宿主会写进凭据文件（不写在启动配置里）。'
              + '密码只写不读：保存后输入框清空，面板只显示指纹。'
            : `当前 credentialSource 是「${config ? config.credentialSource : '?'}」，不是 file —— 面板不接管这份配置，请改 cordis.patch.yml。`),
        canEdit
          ? h('div', null,
            h('div', { style: S.field },
              h('label', { style: S.label }, '账号'),
              h('input', { style: S.input, value: user, autoComplete: 'off', onChange: (e) => setUser(e.target.value) })),
            h('div', { style: S.field },
              h('label', { style: S.label }, '密码'),
              h('input', { style: S.input, type: 'password', value: pass, autoComplete: 'new-password', onChange: (e) => setPass(e.target.value) })),
            h('div', { style: S.actions },
              h(Btn, { kind: 'primary', label: busy === 'saveCredential' ? '保存中…' : '保存并重启代理', disabled: busy !== '', onClick: saveCredential }),
              h(Btn, { label: busy === 'clearCredential' ? '清除中…' : '清除已保存的凭据', disabled: busy !== '', onClick: clearCredential })),
            h('p', { style: S.note },
              '「清除」会删除凭据文件。如果上游需要认证，清除后代理会停止——'
              + '这是预期结果，重新录入并保存即可恢复。'),
            credMsg ? h('p', { style: S.note }, credMsg) : null)
          : null)

      // ── 上游与监听卡 ──────────────────────────────────────────────────────
      const networkCard = h('div', { style: S.card },
        h('div', { style: S.title }, '上游与监听'),
        h('p', { style: S.note },
          '这些值保存在插件自己的状态文件里（$DSH_HOME/proxy-egress/settings.json），'
          + '**不写进宿主的启动配置**——面板写启动配置，一次手误就是宿主起不来。保存后立刻按新设置重启代理。'),
        (state && state.overrides && state.overrides.active)
          ? h('p', { style: S.note }, `当前有面板覆盖（保存于 ${state.overrides.savedAt || '—'}），面板值优先于配置文件。`)
          : h('p', { style: S.note }, '当前完全按配置文件（cordis.patch.yml）的值。'),
        (state && state.overrides && state.overrides.error)
          ? h('div', { style: S.warnBox }, `${state.overrides.error.code}：${state.overrides.error.message}`)
          : null,
        form === null
          ? h('p', { style: S.note }, '读取中…')
          : h('div', null,
            h('div', { style: S.field },
              h('label', { style: S.label }, '上游协议'),
              h('select', {
                style: S.select,
                value: form.upstreamType,
                onChange: (e) => setField('upstreamType', e.target.value),
              },
              h('option', { value: 'http' }, 'http（明文；账号密码在链路上可被还原，仅限可信网络）'),
              h('option', { value: 'https' }, 'https（TLS 到代理；跨公网选这个）'))),
            h('div', { style: S.field },
              h('label', { style: S.label }, '上游主机（只写主机名或 IP，端口另填）'),
              h('input', {
                style: S.input,
                value: form.upstreamHost,
                onChange: (e) => setField('upstreamHost', e.target.value),
              })),
            h('div', { style: S.row },
              h('div', { style: S.field },
                h('label', { style: S.label }, '上游端口'),
                h('input', {
                  style: S.input,
                  value: form.upstreamPort,
                  onChange: (e) => setField('upstreamPort', e.target.value),
                })),
              h('div', { style: S.field },
                h('label', { style: S.label }, '本地监听端口'),
                h('input', {
                  style: S.input,
                  value: form.listenPort,
                  onChange: (e) => setField('listenPort', e.target.value),
                }))),
            h('div', { style: S.field },
              h('label', { style: S.label }, '期望出口 IP（逗号分隔；留空＝只报告不比对）'),
              h('input', {
                style: S.input,
                value: form.expectedEgressIps,
                onChange: (e) => setField('expectedEgressIps', e.target.value),
              })),
            h('div', { style: S.field },
              h('label', { style: S.label }, '观测出口不在期望列表时'),
              h('select', {
                style: S.select,
                value: form.egressMismatchAction,
                onChange: (e) => setField('egressMismatchAction', e.target.value),
              },
              h('option', { value: 'warn' }, 'warn（只记录，照常转发）'),
              h('option', { value: 'block' }, 'block（拒绝新连接；已建立的隧道不中断）'))),
            h('div', { style: S.actions },
              h(Btn, { kind: 'primary', label: busy === 'saveOverrides' ? '保存中…' : '保存并重启代理', disabled: busy !== '', onClick: saveOverrides }),
              h(Btn, { label: busy === 'clearOverrides' ? '恢复中…' : '恢复为配置文件的值', disabled: busy !== '', onClick: restoreOverrides })),
            panelMsg ? h('p', { style: S.note }, panelMsg) : null),
        h('p', { style: S.note },
          '本地监听地址固定为 127.0.0.1，不可改。这是刻意的：会注入凭据的代理一旦绑到 0.0.0.0，'
          + '同网段任何人都能白嫖你的上游账号。'))

      // ── 边界卡（必须写在界面上，不能只写在文档里）─────────────────────────
      const boundaryCard = h('div', { style: S.card },
        h('div', { style: S.title }, '能力边界'),
        h(KV, { k: '保证', v: '进入本地监听的连接只经上游转发；上游失败即断联，不直连目标，无直连开关' }),
        h(KV, { k: '不保证', v: '消费方是否绕过代理；系统级强制出口未实现、未验收' }))

      return h('div', { style: S.wrap },
        error !== '' ? h('div', { style: S.errBox }, error) : null,
        (state && state.config && state.config.ok === false)
          ? h('div', { style: S.errBox },
            '配置校验未通过，插件没有监听任何端口：',
            '\n' + (state.config.errors || []).map((item) => `· ${item.field}: ${item.message}`).join('\n'))
          : null,
        (state && state.config && state.config.warnings && state.config.warnings.length > 0)
          ? h('div', { style: S.warnBox }, state.config.warnings.join('\n'))
          : null,
        statusCard,
        verifyCard,
        networkCard,
        credentialCard,
        boundaryCard)
    }

    return {
      name: 'dsh-proxy-egress',
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-proxy-egress',
          order: 24,
          label: () => '出口代理',
          inject: () => ({
            /** 拆包：成功 = value 载荷；失败 = { ok:false, error }。 */
            rpc: (method, payload, signal) => ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload: payload || {} }, signal)
              .then((result) => (result && result.ok === true ? result.value : result)),
          }),
        }, Panel))
      },
    }
  },
})
