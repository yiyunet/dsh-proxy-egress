# dsh-proxy-egress

把「只接受**无凭据**代理地址的消费方」接到「需要账号密码的上游代理」上。

```
消费方 ──► http://127.0.0.1:8899 ──► 本插件（注入 Proxy-Authorization）──► 上游代理 ──► 目标
           （无认证，消费方只填这个）        （账号密码只在这里出现一次）
```

- **失败即断联**：上游不通、认证失败、被拒、超时 —— 一律关闭连接并给出分类原因。
  没有直连降级，没有兜底重试，**代码里不存在可以打开直连的开关**（配置里写 `allowDirectFallback` 会直接报错）。
- **零构建、零运行时依赖**：`plugin-src/` 即真源，不需要编译。
- **凭据不进模型通道**：工具只查状态、只跑验证，回传里只有指纹（sha256 前 8 位）。

---

## 一、它能保证什么，不能保证什么

| | 内容 | 可证明性 |
|---|---|---|
| **L1 代理层** | 进入本地监听的每一条连接只经上游转发；失败不创建到目标的直连 | **代码级，可测**（`scripts/smoke.mjs` + `scripts/faultcheck.mjs`） |
| **L2 消费方层** | 消费方是否真的把请求交给本监听、失败后是否自己 fallback | **本插件管不了**，只能取证 |
| **L3 系统层** | 整机强制出口 | **未实现、未验收**。需要防火墙白名单或独立网络环境 |

> 说人话：本插件保证「进来的一定走代理」，不保证「该进来的都进来了」。

---

## 二、安装

本插件是一个 DSH bundle（`package.json` 里声明了 `dsh.bundle.patch`）。

1. 把本仓库放到本机任意目录。
2. 在 profile 的 `package.json` 里加一条 `link:` 依赖，并把它加进 `dsh.profile.bundles`。
3. **装出符号链接**：`dsh plugin --profile <profile> install`
   （`bundles` 是手改的，但链接不装出来，加载器就解析不到这个包。）
4. 在 profile 的 `cordis.patch.yml` 里加**同 id 覆盖**行（见下面「配置」）。
5. **重启前预检**：`dsh --profile <profile> --dump-config`
   应当只看到**一行** `proxy-egress`，且带 `patched by ...cordis.patch.yml`。
   这一步能验证 YAML 语法与包解析，不用等重启才发现。
6. 重启宿主，然后问模型 `proxy_egress_status`。

> 不要手写 `$DSH_HOME` 下的插件包，也不要在 profile 目录里跑 pnpm —— 那是 install_bundle 的活。

装好后在 **设置 → 侧栏「出口代理」** 有一个面板（零构建客户端，`plugin-src/client/client.js`）：

- 看状态：监听、上游（脱敏）、凭据是否已配置（只给指纹）、连接计数、最近失败
- 触发验证：代理链路检查 / 故障注入检查 / 重启
- **改上游与监听**：协议、主机、端口、本地端口、期望出口 IP、不匹配时 warn/block
- **录入凭据**：人工在面板里敲账号密码，宿主写进凭据文件并重启代理
- **清除凭据**：删掉凭据文件（上游要认证时代理会停止，这是预期状态）

面板的改动存在插件自己的状态文件 `$DSH_HOME/proxy-egress/settings.json` 里，**不写进宿主的启动配置**——
面板写启动配置，一次手误就是宿主起不来，而纠正它的入口恰恰是这个面板。
两个来源并存时，面板会标出每个字段当前来自「面板」还是「配置文件」。

面板是**全项目唯一合法的凭据写入口**。模型工具永远收不到密码——工具参数会进对话记录、
工具调用日志与宿主审计；面板走的是本机 HTTP，只在人的通道里。
凭据只写不读：保存后输入框清空，界面只显示指纹。

---

## 三、配置

```yaml
# ⚠️ 用「同 id 顶层覆盖」，不要写 `- insert:`。
# 本包自带的 patch 已经插入过这一行；再 insert 一次会变成两个同 id 的行，
# 两个实例抢同一个端口（症状是 EADDRINUSE）。
- id: proxy-egress
  config:
    listen: { host: '127.0.0.1', port: 8899 }   # 只允许回环
    upstream:
      type: 'http'             # http | https
      host: '203.0.113.9'      # 只写主机名/IP，端口另写
      port: 8080
    credentialSource: 'file'
    credentialFile: '<凭据文件绝对路径>'
    allowConnectPorts: [443]
    expectedEgressIps: ['203.0.113.9']
    egressMismatchAction: 'warn'   # warn | block
    selfCheck:
      enabled: true
      url: 'https://api.ipify.org?format=json'
```

凭据文件（UTF-8）：

```json
{ "username": "<账号>", "password": "<密码>" }
```

然后把消费方的代理地址填成 `http://127.0.0.1:8899` —— **不带任何账号密码**，这正是本插件存在的理由。

### 校验规则（不满足就不启动，不监听任何端口）

| 编号 | 规则 |
|---|---|
| V1 | `upstream.host` 不能含端口、不能带协议前缀；IPv6 必须写 `[地址]` |
| V2 | `username` / `password` 必须同时提供或同时留空 |
| V3 | 任何输出（状态、日志、错误）都不含密码，也不含完整账号 |
| V4 | 域名做 IDN → punycode 归一 |
| V5 | 配置变了，旧的检查结果要作废 |
| V6 | 校验不过就不启动；**端口被占用也不自增换端口** |

---

## 四、验证

```bash
npm test           # 纯逻辑 + 沙箱里真跑客户端面板（不需要宿主、不联网）
npm run smoke      # 离线端到端（假上游 + 假目标）
npm run faultcheck # 证明上游坏掉时不会直连
npm run verify     # 发布契约断言（入口存在、白名单自洽、无安装期脚本…）
npm run scan       # 公开前脱敏扫描（词表由 DSH_PRIVATE_TERMS 挂入，未设置则跳过）
npm run check      # 上面全部串起来跑；prepublishOnly 用的就是它
```

`npm test` 覆盖六个层次：

| 文件 | 守什么 |
|---|---|
| `test/parse.test.mjs` | IPv6 三分法、CONNECT 状态行、Basic、逐跳头剥离 |
| `test/config.test.mjs` | V1–V6、直连降级开关被拒、端口白名单非空 |
| `test/credentials.test.mjs` | 凭据文件只有两个键、密码逐字、BOM 容忍 |
| `test/overrides.test.mjs` | **改端口不能把上游账号搞丢**、白名单外的键不生效、来源标注 |
| `test/rpc.test.mjs` | 面板 RPC 信封、错误分级、**业务 ok:false 不走错误通道** |
| `test/client.test.mjs` | 客户端文件能在沙箱里执行、只 require react、面板挂载与首帧渲染 |

`smoke.mjs` 用一个假上游代理和一个 TCP 回声目标，把六件事跑一遍：

1. 正常隧道建立、认证头由本插件注入
2. 上游 407 → `502 UPSTREAM_AUTH_FAILED`，**目标零连接**
3. 上游不可达 → `502 UPSTREAM_UNREACHABLE`，**目标零连接**
4. 非白名单端口 → `403 CONNECT_PORT_NOT_ALLOWED`
5. 普通 HTTP 走绝对形式，**业务状态码原样透传**（429 不被改成 502）
6. 停止后端口释放（再连是 `ECONNREFUSED`）

装到宿主之后，还有两个模型工具可以跑：

- `proxy_egress_selfcheck` —— 经本地监听 → 上游 → 回显服务，量一次**实际出口 IP**
- `proxy_egress_faultcheck` —— 独立实例 + 诱饵端口，验证不直连

---

## 五、分类失败码

| `X-Egress-Reason` | 含义 |
|---|---|
| `UPSTREAM_UNREACHABLE` | 连不上上游（网络/端口/超时） |
| `UPSTREAM_AUTH_FAILED` | 上游回 401 或 407：账号密码不对，或凭据改过但没重启 |
| `UPSTREAM_REJECTED` | 上游明确拒绝该目标 |
| `UPSTREAM_MALFORMED_RESPONSE` | 上游响应解析不出来（按失败处理，不当成功） |
| `TUNNEL_HANDSHAKE_TIMEOUT` | 上游接受了连接但不说话 |
| `HANDSHAKE_HEADER_TOO_LARGE` | 上游响应头超过上限 |
| `CONNECT_PORT_NOT_ALLOWED` | 目标端口不在白名单 |
| `PROXY_BLOCKED` | 处于阻断态（出口 IP 不匹配等） |
| `EGRESS_IP_MISMATCH` | 观测出口不在 `expectedEgressIps` |
| `CHECK_SERVICE_UNAVAILABLE` | 回显服务本身不可用（**不代表代理坏**） |

---

## 六、几个必须说清楚的限制

1. **一次检查不能替代持续约束。** 自检只证明"那一刻、那条路径"。
2. **回显服务只观测它自己的出口。** 上游若按目标分流，不能推论模型 API 走同一出口。
3. **阻断态不中断已建立的隧道。** 因为隧道里的字节已经看不到边界；要更强的效果只能用系统隔离。
4. **HTTP 上游的 Basic 认证只是 Base64。** 上游若在公网，账号密码在链路上可被还原。走公网请优先 `type: 'https'`。
5. **SOCKS5 尚未实现。** 写了会明确报错，不会静默忽略。

---

## 七、许可

MIT。
