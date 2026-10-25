# dsh-proxy-egress

Give a **credential-free** proxy URL to consumers that reject credentials, while your
real upstream needs a username and password.

```
consumer ──► http://127.0.0.1:8899 ──► inject Proxy-Authorization ──► upstream ──► target
             (no auth on this hop)        (credentials live only here)
```

A DeepSeek Harness (DSH) plugin. Zero build, zero runtime dependencies.

---

## What it guarantees, and what it does not

| | Content | Provable |
|---|---|---|
| **L1 proxy layer** | Every connection entering the local listener is forwarded **only** through the configured upstream. On failure it closes — it never creates a direct connection to the target. | **Yes** — code-level, covered by `npm run faultcheck` |
| **L2 consumer layer** | Whether the consumer actually routes through this listener | **No** — the plugin has no control over it; only observation |
| **L3 system layer** | Machine-wide egress enforcement | **Not implemented, not verified.** Needs OS-level network isolation |

In one sentence: it guarantees "anything that comes in goes through the proxy", not
"everything that should come in does".

---

## Install

```sh
# 0. verify offline first (no host, no network needed)
npm test && npm run smoke && npm run faultcheck

# 1. install — this both installs the package and registers it in dsh.profile.bundles
dsh plugin --profile <profile> add @yiyunet/dsh-proxy-egress

# from source instead (for hacking on it): this one needs a manual bundles entry
# dsh plugin --profile <profile> add "link:<abs path to this repo>"
```

Then add a row to the profile's `cordis.patch.yml` — **as an id override, not an `insert`**
(this package's own patch already inserts the row; a second `insert` creates two rows
fighting over one port):

```yaml
- id: proxy-egress
  config:
    listen: { host: '127.0.0.1', port: 8899 }
    upstream: { type: 'http', host: '<upstream host>', port: 8080 }
    credentialSource: 'file'
    credentialFile: '<absolute path to credentials json>'
    allowConnectPorts: [443]
    expectedEgressIps: []
    egressMismatchAction: 'warn'
```

Credentials file (kept **outside** the repo):

```json
{ "username": "<user>", "password": "<pass>" }
```

Then point the consumer at `http://127.0.0.1:8899` and restart the host.

Full walkthrough: [`docs/安装步骤.md`](docs/安装步骤.md).

---

## Credentials never reach the model

- Model-facing tools **cannot** read or set a password. Tool parameters end up in the
  conversation transcript, tool-call logs and host audit trails.
- The **settings panel** is the only legitimate write path: a human types the password,
  the host writes it to the credentials file, and only a fingerprint (sha256, first 8 hex
  chars) is ever shown back.
- Status output never includes the password or the full username.

---

## Settings panel

**Settings → 出口代理** (web plane):

- status: listener, upstream (redacted), credential fingerprint, connection counters
- verify: proxy-link check / fault injection check / restart
- upstream & listener: protocol, host, port, local port, expected egress IPs, mismatch action
- credentials: enter, save-and-restart, or clear

Panel overrides are stored in `$DSH_HOME/proxy-egress/settings.json`, **not** in the
host's boot config — a typo in a boot config keeps the host from starting, and the only
place to fix it is the very panel that wrote it.

---

## Classified failure codes

`UPSTREAM_UNREACHABLE` · `UPSTREAM_AUTH_FAILED` (401 or 407) · `UPSTREAM_REJECTED` ·
`UPSTREAM_MALFORMED_RESPONSE` · `TUNNEL_HANDSHAKE_TIMEOUT` · `HANDSHAKE_HEADER_TOO_LARGE` ·
`CONNECT_PORT_NOT_ALLOWED` · `PROXY_BLOCKED` · `EGRESS_IP_MISMATCH` · `CHECK_SERVICE_UNAVAILABLE`

---

## Development

```sh
npm test           # pure logic + the client panel executed in a sandbox
npm run smoke      # offline end-to-end with a fake upstream and a fake target
npm run faultcheck # proves the plugin does not fall back to a direct connection
npm run verify     # release contract assertions
DSH_PRIVATE_TERMS=<path> npm run scan   # public-release redaction scan (word list stays outside the repo)
```

## Feedback

Found a problem or want a new feature? [Open an issue](https://github.com/yiyunet/dsh-proxy-egress/issues/new/choose).
Include the **DSH version** and the **plugin version** — that makes a fix much faster.

The `proxy_egress_selfcheck` verdict usually pinpoints the problem, so it is worth pasting —
but do two things first: **remove upstream credentials** and **mask your real egress IP**
(that IP identifies your network).

## License

MIT
