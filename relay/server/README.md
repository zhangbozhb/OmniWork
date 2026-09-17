# OmniWork Relay Server

Minimal company-network relay for the native OmniWork App and Desktop Agent.

The server does not hold App or Agent private keys. It brokers the challenge
flow:

1. Desktop Agent proves its device identity with `agent.auth.init`,
   `agent.auth.challenge`, and a signed `agent.hello`; Relay then applies its
   manual or automatic Agent authorization policy.
2. App sends `mobile.connect` with its public identity and the target Agent
   device ID.
3. Relay resolves the online Agent and sends its registered public key in
   `auth.challenge`.
4. App signs `auth.proof`; Relay verifies and forwards `auth.verify`.
5. Desktop Agent verifies the App signature, requests local approval for an
   unknown App, and returns a signed `auth.ok` or `auth.failed`.
6. App and Agent establish a signed ephemeral X25519 E2E session.

Install and run with Node.js 22.6 or newer:

```sh
npm install --global @omni-work/relay-server
omniwork-relay --config /path/to/config.yml
```

Run from the repository:

```sh
pnpm --filter @omni-work/relay-server dev
```

Smoke-check the configuration without binding the port:

```sh
pnpm verify:relay
```

## Configuration

Relay reads `config.yml` in this order:

```text
1. Explicit path from --config / -c
2. config.yml in the current working directory
3. config.yml next to the running relay server program
4. config.yml in the relay/server package root
5. System global config:
   - macOS: ~/Library/Application Support/OmniWork/relay/config.yml
   - Linux: ${XDG_CONFIG_HOME:-~/.config}/omniwork/relay/config.yml
   - Windows: %APPDATA%/OmniWork/relay/config.yml
```

The config is intentionally sparse: omitted fields use safe local defaults.
Use `pnpm relay:start -- --config /path/to/config.yml` for a one-off explicit
config path. See `config.example.yml` for a fully annotated template. A minimal local config:

```yml
server:
  host: 127.0.0.1
  port: 8787
admin:
  host: 127.0.0.1
  port: 8788
paths:
  runtimeDir: .omniwork-relay
agentAuthorization:
  mode: manual
auth:
  mode: none
```

`OMNIWORK_*` environment variables are supported as fallbacks when the same
value is not present in `config.yml`.

### Agent authorization

Relay authorizes Agent device identities independently from App-to-Agent
approval. Configure:

```yml
agentAuthorization:
  mode: manual
  pendingTtlMs: 86400000
```

- `manual` is the default. After a new Agent proves possession of its Ed25519
  private key, Relay records a pending request and closes the connection with
  `4402 / agent_approval_required`. Approve it in Relay Admin; the Agent keeps
  retrying and connects after approval. The pending row and detail view expose
  the Relay-observed public IP plus the Agent-reported system type and `uname`;
  approval and rejection are available from either view.
- `automatic` permanently authorizes a valid new Agent identity when neither
  its `device_id` nor its Relay-visible source IP is blocked.
- Existing authorizations are reused in both modes and persist in
  `admin-controls.sqlite`.
- Device disable and IP-ban rules always take precedence.

Set the mode with
`OMNIWORK_RELAY_AGENT_AUTHORIZATION_MODE=manual|automatic`. Pending requests
expire after `OMNIWORK_RELAY_AGENT_AUTHORIZATION_PENDING_TTL_MS` (default one
day) unless the Agent retries and refreshes the request.

When `auth.mode=email_link` is enabled, user device enrollment remains an
additional prerequisite. Automatic Relay authorization does not bypass device
ownership checks.

### WebSocket transport and E2E

The server treats `ws://` and `wss://` as transport only. Protocol v2 always
requires App-Agent business traffic inside `e2e.message`.

Loopback hosts allow plaintext `ws://` by default for local development. Any
non-loopback host must explicitly set `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true`.
`wss://` is still recommended to reduce network metadata exposure, but it is
not the business security boundary.

### Optional user registration

User registration is disabled by default with `OMNIWORK_RELAY_AUTH_MODE=none`.
In this mode Relay keeps the current behavior and does not require mail
configuration.

Set `OMNIWORK_RELAY_AUTH_MODE=email_link` to enable email-link login and
device ownership checks. Startup then requires `OMNIWORK_PUBLIC_BASE_URL` and
`OMNIWORK_MAIL_FROM`; non-loopback hosts must use an HTTPS public base URL and
cannot use the `console` mail provider. `OMNIWORK_MAIL_PROVIDER=smtp` also
requires SMTP host, port, user and password. A personal Gmail account with an
App Password can be used for low-volume deployments.

Users register and manage device enrollment from the Relay website:

```text
https://relay.example.com/auth/
```

The page sends the email magic link, sets an HttpOnly login cookie after
verification, lists enrolled devices, revokes devices, and creates a short-lived
device token. Browser session tokens are not embedded in HTML or persisted in
`localStorage`; `/auth/` also removes the legacy `omniwork_user_session` storage
entry. The Desktop Agent can consume the device token:

```sh
omniwork-agent enroll \
  --relay-url wss://relay.example.com/relay/ws/agent \
  --token <device-enrollment-token>
```

The enrollment command creates the Agent identity on first use or reuses the
existing identity, then registers its derived `device_id` and public key with
Relay. The private key remains in the Agent identity store.

Native and cross-site Web Apps cannot use the Relay website's login cookie.
After signing in as the Agent's owner, click **Create App sign-in token** on
`/auth/`, then copy the private token into the App's optional **Relay sign-in
token** field (details, link, or edit mode). It can be entered before scanning
or after import by editing the device. Same-site Web keeps using its login
cookie. Tokens never belong in pairing/share links.

Each click creates an independent session with `auth.sessionTtlMs`, without
replacing the browser cookie. The page shows its expiry and supports
show/select/copy; it clears the displayed token on logout. Browser logout only
revokes that browser session, not issued App tokens. To revoke an App token,
call `POST /auth/logout` with that token as `Authorization: Bearer ...`.
Auth responses use `Cache-Control: no-store`. Use HTTPS and `wss://` outside
local development: this account credential is sent before App-Agent E2E.

Auth data is stored in `OMNIWORK_RELAY_AUTH_DB_PATH` (default
`<OMNIWORK_RELAY_RUNTIME_DIR>/relay-auth.sqlite`). Public endpoints:

- `POST /auth/email/start` — body `{ "email": "user@example.com" }`; sends a
  magic login link and always returns `202` for rate-limited valid requests.
- `GET /auth/email/verify?token=...` — consumes the one-time link, creates the
  user if needed, and sets an HttpOnly session cookie before redirecting to
  `/auth/`; the browser token is not exposed to page JavaScript.
- `GET /auth/me`, `POST /auth/logout` — session inspection and logout.
- `POST /auth/sessions` — authenticated user creates an independent App
  session; returns `{ "session_token": "...", "expires_at": "<ISO timestamp>" }`.
- `POST /auth/devices/enrollments` — authenticated user creates a short-lived
  device enrollment token.
- `POST /auth/devices` — Agent submits an enrollment token, its derived
  `device_id`, and Ed25519 public key. The ID is normalized before Agent-role
  key validation and storage.
- `GET /auth/devices`, `POST /auth/devices/:device_id/revoke` — list and
  revoke user devices.

Cookie-authenticated state-changing requests must include `x-csrf-token` from
`GET /auth/me`. Bearer-token API calls are not subject to this CSRF check.

When enabled, Agent device auth uses two signatures. `agent.auth.init` carries
`device_id`, registered `device_public_key`, `timestamp`, and a signature over
those fields so Relay can reject spoofed challenge requests early. Relay then
returns an opaque stateless `agent.auth.challenge` string. The final
`agent.hello.relay_auth` signs `device_id|challenge|timestamp`, verified against
the registered device public key. The challenge is not stored; it carries an
HMAC-protected expiry and connection binding, and defaults to a 60s TTL via
`auth.agentAuthChallengeTtlMs`. Init/proof timestamps use the separate
`auth.agentAuthClockSkewMs` window, also defaulting to 60s. `mobile.connect`
must include a user `session_token` unless the WebSocket upgrade already
authenticated the same-site login cookie. Relay only allows access when the
session user owns the target device.

Relay 校验顺序：

1. `agent.auth.init` 只能从未鉴权连接进入，失败按 `agent|device_id|public_remote_ip` 和 `agent_ip|public_remote_ip` 两层限流；成功发出 challenge 也会消耗公网 IP-only 桶，最终 `agent.hello` 成功后只重置 `agent|device_id|public_remote_ip`。`public_remote_ip` 只来自 Relay 连接层观测；内网、loopback、链路本地和保留地址不进入 Agent 准入限流。
2. `device_id` 已登记且未撤销。
3. `agent.auth.init.device_public_key` 与登记公钥规范化后匹配。
4. `agent.auth.init.timestamp` 在允许窗口内，init 签名有效。
5. 无状态 `agent.auth.challenge` 的 HMAC、过期时间和 connection 绑定有效。
6. `agent.hello.relay_auth.timestamp` 在允许窗口内，proof 签名有效。
7. Relay 按 `agentAuthorization.mode` 检查已批准设备；人工模式记录待授权请求，自动模式在 device/IP 未封禁时持久化授权。
8. `agent.hello` 只允许从 `pending` 进入 `verified`；重复 `agent.hello` 被忽略并记录 `agent.hello.ignored` 审计日志。
9. 身份和授权均通过后分配 `agent_connection_id`，并执行同一 `device_id` 单 Agent 在线策略。

### auth.proof rate limiting

`auth.proof` failures are rate limited per `(device_id, remote_ip)` with a
token bucket:

- `OMNIWORK_RELAY_AUTH_RATE_CAPACITY` (default `5`): bucket capacity, i.e. the
  maximum number of failed attempts allowed before the bucket is drained.
- `OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC` (default `2`): tokens refilled per
  second once the bucket is no longer blocked.
- `OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS` (default `120000`): cool-down window in
  milliseconds after the bucket drains; further attempts are rejected during
  this window. After the window elapses the bucket is fully refilled.

When the limiter rejects a request, Relay responds with `auth.failed` and
reason `too_many_attempts`. Only failed `auth.proof` consume a token (either a
malformed proof rejected at the relay, or `auth.failed` returned by the agent
after signature or trust verification); legitimate `auth.proof` that lead to `auth.ok` do not
consume the bucket, so frequent reconnects and transport-preference switches
are not throttled. A successful `auth.ok` also resets the bucket so subsequent
attempts are not affected by past failures.

### WebSocket keepalive

Relay actively probes every Agent/App WebSocket with ping frames to avoid stale
RuntimeTopology entries when a reverse proxy or load balancer silently drops an
idle connection:

- `OMNIWORK_RELAY_WS_KEEPALIVE_INTERVAL_MS` (default `3300000`): ping interval.
  This is 55 minutes, intended to sit below a 1 hour Nginx `proxy_read_timeout`.
- `OMNIWORK_RELAY_WS_PONG_TIMEOUT_MS` (default `30000`): how long Relay waits
  for pong before closing the socket and unregistering the connection.

If Nginx fronts Relay, keep `proxy_read_timeout` above the ping interval. The
deployment example uses `3600s`.

Relay accepts masked, final client frames with payloads up to 8 MiB. Unsupported
fragmentation, reserved bits, unmasked client frames, and malformed control
frames close only the offending connection with code `1002`; oversized frames
close it with code `1009`.

### Agent shutdown close code

Relay uses WebSocket close code `4404` only when it intentionally asks the
Desktop Agent service to stop and exit its process. Reason `agent_disabled`
means an operator disabled the active Agent instance; reason `ip_banned` means
an operator banned the Agent's source IP. Ordinary disconnects, keepalive
timeouts, and generic policy rejections use other close codes and must not stop
the Agent process.

IP bans are enforced through the `RelayAuthGuard` policy chain before the
connection enters App/Agent business routing. Banned Mobile/App upgrades are
rejected with `403 ip_banned`; banned Agent upgrades complete the WebSocket only
long enough to deliver `4404 / ip_banned`, so the Agent can exit intentionally.

`RelayAuthGuard` is the Relay-local auth orchestrator, not the rule container.
Stable policy modules own the concrete checks: IP bans, Agent instance disable,
`email_link` Agent device lookup/revoke, init/proof device signatures and
stateless challenge checks, plus Mobile user session and device ownership
checks. Admission modules consume the guard decision and then only advance
connection state or create the App pairing challenge.

### P2P upgrade orchestrator

The relay coordinates optional WebRTC DataChannel upgrades between the App and
Desktop Agent. Configuration:

```text
OMNIWORK_UPGRADE_ENABLED=true
OMNIWORK_UPGRADE_ROLLOUT=100
OMNIWORK_UPGRADE_DEVICE_BLOCKLIST=
OMNIWORK_UPGRADE_ICE_SERVERS_JSON=[{"urls":"stun:stun.l.google.com:19302"}]
OMNIWORK_UPGRADE_PROPOSE_DELAY_MS=3000
OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF=true
```

- `OMNIWORK_UPGRADE_ENABLED` (`true`/`false`, default `true`): global kill switch.
- `OMNIWORK_UPGRADE_ROLLOUT` (`0..100`, default `100`): percent rollout, hashed by
  `sha1(device_id)`.
- `OMNIWORK_UPGRADE_DEVICE_BLOCKLIST`: comma-separated device IDs that must
  never upgrade.
- `OMNIWORK_UPGRADE_ICE_SERVERS_JSON`: JSON array of `{ urls, username?,
credential? }` sent to clients in `tunnel.upgrade.propose`.
- `OMNIWORK_UPGRADE_PROPOSE_DELAY_MS` (default `3000`): stable window between
  mobile auth success and the propose.
- `OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF` (`true`/`false`, default `true`):
  honour the App's `mobile.connect.transport_preference` field. Set to `false`
  to force every connection to be treated as `auto` (and never propagate
  `strict: true` on propose).
  See `docs/relay-architecture.md §6.1`.

When the App connects with `transport_preference=prefer_p2p`, the relay sets
`strict: true` on the `tunnel.upgrade.propose` payload sent to both peers.
Strict P2P clients only allow control-plane traffic on the relay path; any
upgrade negotiation or runtime failure (`timeout`, `peer_unavailable`,
`ice_failed`, `pong_timeout`, etc.) closes the session instead of falling
back to relay. The relay still records the failure under `failed[reason]` and
applies the same backoff policy as `auto`.

Operational endpoints:

- `GET /metrics` — JSON snapshot with `relay` control-plane counters and
  `upgrade` orchestrator counters. `relay` includes runtime uptime, device /
  Agent / App / link / connection totals, traffic bytes/messages, auth failures,
  routing drops, and protocol errors sent. `upgrade` includes `proposed`,
  `committed`, `failed[reason]`, `downgrade[reason]`, `prefs[preference]`,
  `skipped_by_pref`, `in_flight`, `active_p2p`, and `durations`
  (p50/p95/max over the last 100 successful upgrades).
- Business listener (`OMNIWORK_RELAY_HOST` / `OMNIWORK_RELAY_PORT`):
  `GET /healthz`, `GET /readyz`, `GET /metrics`, `POST /debug/upgrade`, and
  `GET /relay/ws/*` WebSocket upgrades.
- `POST /debug/upgrade?device_id=<id>&app_connection_id=<connection_id>` —
  manually triggers an upgrade for one E2E-ready App connection under a paired
  device; included in metrics and logs.
- Admin listener (`OMNIWORK_RELAY_ADMIN_HOST` / `OMNIWORK_RELAY_ADMIN_PORT`):
  all `/admin/api/*` routes and, in development mode, `/admin/web`.
- `GET /admin/web` — development-only Relay admin web page for viewing online
  Agents and Apps. Requires HTTPS and a valid admin session.
- `GET /admin/api/status` — Relay admin status summary with active device /
  Agent / App / link / connection totals, persisted known/offline device
  counts, and traffic counters.
- `GET /admin/api/devices?include_offline=true&limit=100` — Relay-visible
  device summary. Active devices come from in-memory runtime state; offline
  devices come from the persisted device-status summary and contain only
  minimal metadata.
- `GET /admin/api/agents` — online Agent list with current App counts.
- `GET /admin/api/agent-authorizations` — Agent authorization mode, pending
  requests, and permanently authorized device IDs.
- `POST /admin/api/agent-authorizations/device-op` — approve, reject, or
  remove Agent authorizations. Rejecting a request also creates a permanent
  Agent device-disable rule.
- `GET /admin/api/agent-connections/:connection_id/apps` — Relay-visible App
  connections under one online Agent connection.
- `GET /admin/api/links` — current Relay-visible Agent/App links, including E2E
  and transport path state.
- `GET /admin/api/traffic` — highest-traffic online Agent/App connections.
- `GET /admin/api/traffic-map` — map-ready location and flow aggregates for the
  Admin traffic board. Nodes are aggregated location buckets, not individual
  Agent/App connections. Flow edges are aggregated by `from_location_id ->
to_location_id`, with link/device counts and transport-path distribution.
  Node area represents active connection count; directional bytes are counted
  from Relay ingress so App-to-Agent and Agent-to-App traffic are not
  double-counted. Relay resolves public IPs with the bundled local GeoIP
  database and falls back to private/reserved/unknown buckets when no location
  is available.
- `GET /admin/api/controls` — active disabled-Agent and IP-ban rules.
- `POST /admin/api/login` — consumes the current one-time admin token and sets
  a secure 30-minute session cookie.
- `POST /admin/api/logout` — clears the current admin session. Requires a valid
  admin session.
- `GET /admin/api/me` — reports the current admin session state. Requires a
  valid admin session.
- `POST /admin/api/controls/agent-devices/device-op` — disable Agent devices or
  delete disable rules. Body:
  `{ "action": "disable", "agent_device_ids": ["..."], "reason": "..." }`
  or `{ "action": "delete", "agent_device_ids": ["..."] }`. Disable rules
  are temporary and default to `OMNIWORK_RELAY_AGENT_DEVICE_DISABLE_DEFAULT_MS`
  (1 day).
  Add `"permanent": true` or `"duration": "permanent"` to persist them in
  SQLite.
  Requires a valid admin session.
- `POST /admin/api/controls/ip-bans` — ban or unban IPs. Body:
  `{ "action": "ban", "ips": ["..."], "reason": "..." }` or
  `{ "action": "unban", "ips": ["..."] }`. Default ban duration is
  `OMNIWORK_RELAY_IP_BAN_DEFAULT_MS` (1 day). Add `"permanent": true` or
  `"duration": "permanent"` to persist them in SQLite. Requires a valid admin
  session.

Relay Admin requires HTTPS by default. When the server is behind a trusted TLS
terminating proxy, set `OMNIWORK_RELAY_ADMIN_TRUST_PROXY=true` and include the
proxy IPs in `OMNIWORK_RELAY_ADMIN_TRUSTED_PROXY_IPS`; only those proxy
connections may assert `X-Forwarded-Proto: https` or `X-Forwarded-For`. The
fronting Nginx config must overwrite `X-Forwarded-For` with `$remote_addr`
rather than appending `$proxy_add_x_forwarded_for`, so client-supplied forwarded
chains cannot affect GeoIP, IP-ban, or auth rate-limit attribution.

Relay Admin API is provided only by the separate admin listener under
`/admin/api/...`; the business listener intentionally returns 404 for admin
routes. The Node-served admin web page under `/admin/web` is a development
convenience and is disabled by default with
`OMNIWORK_RELAY_ADMIN_WEB_ENABLED=false`. Use `pnpm dev:relay` or set
`OMNIWORK_RELAY_ADMIN_WEB_ENABLED=true` explicitly when you want the relay
process to serve Admin Web on the admin listener. When enabled, startup logs
include an `admin.web.ready` record with the local `/admin/web` access URL.

On startup the server writes runtime artifacts under
`OMNIWORK_RELAY_RUNTIME_DIR` (default `.omniwork-relay` in the current working
directory). The 64-character one-time admin token is written to
`admin-token.json` in that directory by default, and the initial startup token
is also emitted once in the `admin.token.ready` structured log record for
operator convenience. Set
`OMNIWORK_RELAY_ADMIN_TOKEN_DIR` to write the token file elsewhere. The token
directory uses mode `0700` when the server creates it, and the token file uses
mode `0600`. The token rotates every
`OMNIWORK_RELAY_ADMIN_TOKEN_ROTATE_MS` (default 1 hour). A successful login
immediately consumes the token, rotates a new one, and creates a secure
`HttpOnly; Secure; SameSite=Strict` session cookie that expires after
`OMNIWORK_RELAY_ADMIN_SESSION_TTL_MS` (default 30 minutes).

Permanent Agent authorizations, Agent disable rules, and IP-ban rules are stored in
`OMNIWORK_RELAY_ADMIN_CONTROLS_DB_PATH` (default
`<OMNIWORK_RELAY_RUNTIME_DIR>/admin-controls.sqlite`) and reloaded on startup.
Temporary rules with
`ttl_ms`, `expires_in_ms`, `expires_at`, or the default TTL stay in memory only.

Relay active connection state is memory-only: closed Agent/App/link records are
removed from runtime maps immediately. Device-level minimal status is persisted
to `OMNIWORK_RELAY_DEVICE_STATUS_DB_PATH` (default
`<OMNIWORK_RELAY_RUNTIME_DIR>/relay-device-status.sqlite`) so Admin can show
recent offline devices without retaining connection objects. The persisted
record stores only `device_id`, status, first/last seen timestamps, offline
timestamp, last Agent/App remote IPs, last Agent instance ID, close role/reason,
and device-level byte/message counters. It does not store connection history,
link history, App info, session data, E2E details, or business payload.
Offline device summaries are pruned after
`OMNIWORK_RELAY_DEVICE_STATUS_RETENTION_MS` (default 7 days). Device counters
flush every `OMNIWORK_RELAY_DEVICE_STATUS_FLUSH_INTERVAL_MS` (default 5s);
expired pending auth entries and Relay app delivery contexts are swept by
`OMNIWORK_RELAY_STATE_SWEEP_INTERVAL_MS` (default 30s).

The admin web source lives in `relay/server/admin-web`. Production deployments
should serve that source through the web build output and Nginx at `/admin/`,
while relay development mode may read the same source and inject `/admin/web`
as the local base path. Production keeps `/admin/login.html` as the static
login route; relay dev uses `/admin/web` for both the page and login fallback.
Keep UI HTML/CSS/JS out of `src/relayServer.ts`. The traffic board world map
uses `admin-web/world-land-110m.geojson`, derived from Natural Earth 110m land
data, as a local static asset rather than a runtime CDN dependency.
The Admin page and login page provide English and Simplified Chinese resources.
They prefer an explicit selection from the non-sensitive
`omniwork_admin_locale` cookie, then inspect the browser language list, and
finally use the browser time zone as a fallback. Mainland China time zones
select Simplified Chinese; other unsupported language/time-zone combinations
default to English.
Admin HTTP routing, auth checks, snapshots, and control-rule mutations live in
`src/relayAdminController.ts`; keep `src/relayServer.ts` focused on Relay
connections and protocol routing.
E2E handshake, ready-state validation, and encrypted message routing live in
`src/relayE2EController.ts`. Business payload encryption policy is owned by App
and Agent. Relay logging helpers live in `src/relayLog.ts`.
When Agent needs Relay to return an App-scoped protocol error, it sends
`relay.app.deliver` with the Relay-issued `relay_context_id` plus the
`protocol.error` content. Relay resolves the target App from its own delivery
context, binds the handle to the Agent connection that received the original
request, and rejects content that tries to carry an App target.

Full architecture, downgrade triggers, and a troubleshooting runbook live in
[docs/relay-architecture.md](../../docs/relay-architecture.md).
