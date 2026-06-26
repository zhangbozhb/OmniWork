# OmniWork Relay Server

Minimal company-network relay for the native OmniWork App and Desktop Agent.

The server does not store the temporary key. It brokers the challenge flow:

1. Desktop Agent registers with `agent.hello` and its `key_id`.
2. App sends `mobile.connect` for a Desktop Agent `device_id`.
3. Relay sends `auth.challenge` to the App.
4. App sends `auth.proof`; Relay forwards `auth.verify` to the Desktop Agent.
5. Desktop Agent verifies the proof with the local startup key and returns `auth.ok` or `auth.failed`.

Run locally:

```sh
pnpm --filter @omniwork/relay-server dev
```

Smoke-check the configuration without binding the port:

```sh
pnpm verify:relay
```

## Environment

```text
OMNIWORK_RELAY_HOST=127.0.0.1
OMNIWORK_RELAY_PORT=8787
OMNIWORK_RELAY_ADMIN_HOST=127.0.0.1
OMNIWORK_RELAY_ADMIN_PORT=8788
OMNIWORK_DEVICE_ID=omniwork-relay
OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true
OMNIWORK_RELAY_REQUIRE_E2E=true
OMNIWORK_RELAY_AUTH_RATE_CAPACITY=5
OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC=1
OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS=60000
OMNIWORK_RELAY_RUNTIME_DIR=.omniwork-relay
OMNIWORK_RELAY_ADMIN_TOKEN_DIR=
OMNIWORK_RELAY_ADMIN_TOKEN_ROTATE_MS=3600000
OMNIWORK_RELAY_ADMIN_SESSION_TTL_MS=1800000
OMNIWORK_RELAY_ADMIN_REQUIRE_HTTPS=true
OMNIWORK_RELAY_ADMIN_WEB_ENABLED=false
OMNIWORK_RELAY_ADMIN_TRUST_PROXY=false
OMNIWORK_RELAY_ADMIN_TRUSTED_PROXY_IPS=127.0.0.1,::1
OMNIWORK_RELAY_ADMIN_CONTROLS_DB_PATH=
OMNIWORK_RELAY_AGENT_DISABLE_DEFAULT_MS=86400000
OMNIWORK_RELAY_IP_BAN_DEFAULT_MS=86400000
```

### Plaintext WS and E2E

The server treats `ws://` and `wss://` as transport only. Business security is
declared per Agent: the same relay process can carry `e2e_required` Agents whose
business traffic is inside `e2e.message`, and `plaintext_allowed` Agents started
with `OMNIWORK_AGENT_REQUIRE_E2E=false`.

Loopback hosts allow plaintext `ws://` by default for local development. Any
non-loopback host must explicitly set `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true`.
`OMNIWORK_RELAY_REQUIRE_E2E` is retained only as a legacy compatibility setting;
business encryption is no longer enforced globally by the relay. `wss://` is
still recommended to reduce network metadata exposure, but it is not the
business security boundary.

### auth.proof rate limiting

`auth.proof` failures are rate limited per `(device_id, remote_ip)` with a
token bucket:

- `OMNIWORK_RELAY_AUTH_RATE_CAPACITY` (default `5`): bucket capacity, i.e. the
  maximum number of failed attempts allowed before the bucket is drained.
- `OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC` (default `1`): tokens refilled per
  second once the bucket is no longer blocked.
- `OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS` (default `60000`): cool-down window in
  milliseconds after the bucket drains; further attempts are rejected during
  this window. After the window elapses the bucket is fully refilled.

When the limiter rejects a request, the relay responds with `auth.failed` and
reason `too_many_attempts`. Only failed `auth.proof` consume a token (either a
malformed proof rejected at the relay, or `auth.failed` returned by the agent
after key verification); legitimate `auth.proof` that lead to `auth.ok` do not
consume the bucket, so frequent reconnects and transport-preference switches
are not throttled. A successful `auth.ok` also resets the bucket so subsequent
attempts are not affected by past failures.

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
- `GET /admin/api/status` — Relay admin status summary with device / Agent /
  App / link / connection totals and traffic counters.
- `GET /admin/api/devices` — Relay-visible device summary with per-device
  Agent, App, link, and traffic counters.
- `GET /admin/api/agents` — online Agent list with current App counts.
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
- `POST /admin/api/controls/agents/agent-op` — disable Agent runtime instances
  or delete disable rules. Body:
  `{ "action": "disable", "agent_instance_ids": ["..."], "reason": "..." }`
  or `{ "action": "delete", "agent_instance_ids": ["..."] }`. Disable rules
  are temporary and default to `OMNIWORK_RELAY_AGENT_DISABLE_DEFAULT_MS` (1 day).
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

Permanent Agent disable and IP-ban rules are stored in
`OMNIWORK_RELAY_ADMIN_CONTROLS_DB_PATH` (default
`<OMNIWORK_RELAY_RUNTIME_DIR>/admin-controls.sqlite`) and reloaded on startup.
Temporary rules with
`ttl_ms`, `expires_in_ms`, `expires_at`, or the default TTL stay in memory only.

The admin web source lives in `relay/server/admin-web`. Production deployments
should serve that source through the web build output and Nginx at `/admin/`,
while relay development mode may read the same source and inject `/admin/web`
as the local base path. Production keeps `/admin/login.html` as the static
login route; relay dev uses `/admin/web` for both the page and login fallback.
Keep UI HTML/CSS/JS out of `src/relayServer.ts`. The traffic board world map
uses `admin-web/world-land-110m.geojson`, derived from Natural Earth 110m land
data, as a local static asset rather than a runtime CDN dependency.
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
