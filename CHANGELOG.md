# Changelog

本文件记录对外可见的行为变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-12

首个公开版本。

### 新增

- **本地回环转发代理**：在 `127.0.0.1` 上开一个无需认证的 HTTP 代理，向上游注入
  `Proxy-Authorization`，让"只接受无凭据代理地址"的消费方也能用上需要账号密码的上游。
- **失败即断联（fail-closed）**：上游不可达 / 认证失败 / 拒绝 / 握手超时，一律关闭连接
  并返回分类原因；**不创建到目标的直连连接**，代码里不存在可以打开直连的开关。
- **CONNECT 精度契约**：完整解析上游状态行才判成功；发 200 之后任何错误只关闭隧道、
  不再写 HTTP 字节；处理客户端 `head` 与响应头后同包到达的隧道数据。
- **CONNECT 端口白名单**：默认只放行 443，避免退化成任意 TCP 转发器。
- **普通 HTTP 转发**：只接受绝对形式请求，业务状态码原样透传（429 不会被改成 502）。
- **出口钉定**：`expectedEgressIps` + `egressMismatchAction`（`warn` / `block`），
  自检可量出真实出口 IP 并与期望比对。
- **设置面板**（`settings.section`）：状态、验证、上游与监听配置、凭据录入与清除。
- **四个模型工具**：`proxy_egress_status` / `proxy_egress_selfcheck` /
  `proxy_egress_faultcheck` / `proxy_egress_restart`。

### 安全

- 凭据**只**经设置面板或独立凭据文件进入；模型工具**永不接收或回显**密码
  （工具参数会进对话记录、工具调用日志与宿主审计）。
- 状态查询只回凭据指纹（sha256 前 8 位），不回明文、不回完整账号。
- 本地监听**强制回环**，`listen.host` 不接受非回环值。
- 兼容带 UTF-8 BOM 的凭据文件（PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM）。

### 已知边界

- 只保证 **L1**（进入本地监听的连接只经上游转发）；**不保证 L2**（消费方是否绕过代理）。
- 系统级强制出口（L3）未实现、未验收；`hosts` 黑洞只能算辅助防误连，不可证明。
- 阻断态**不中断已建立的隧道**（隧道内字节已无边界）。
- HTTP 上游的 Basic 认证只是 Base64；跨公网请用 `https` 上游。
- SOCKS5 尚未实现（配置里写了会明确报错，不会静默忽略）。
