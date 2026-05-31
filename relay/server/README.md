# OmniWork Relay Server

Minimal company-network relay for the native OmniWork App and Mac Agent.

The server does not store the temporary key. It brokers the challenge flow:

1. Mac Agent registers with `agent.hello` and its `key_id`.
2. App sends `mobile.connect` for a Mac `device_id`.
3. Relay sends `auth.challenge` to the App.
4. App sends `auth.proof`; Relay forwards `auth.verify` to the Mac Agent.
5. Mac Agent verifies the proof with the local startup key and returns `auth.ok` or `auth.failed`.

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
OMNIWORK_DEVICE_ID=omniwork-relay
OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true
OMNIWORK_RELAY_REQUIRE_E2E=true
OMNIWORK_RELAY_AUTH_RATE_CAPACITY=5
OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC=1
OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS=60000
```

### Plaintext WS and E2E

The server treats `ws://` and `wss://` as transport only. Business security is
provided by App-Agent E2E encryption, and relay business traffic must be carried
inside `e2e.message`.

Loopback hosts allow plaintext `ws://` by default for local development. Any
non-loopback host must explicitly set `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true`.
When plaintext WS is allowed, `OMNIWORK_RELAY_REQUIRE_E2E` must remain `true`;
otherwise startup fails with `RelayConfigError`. `wss://` is still recommended
to reduce network metadata exposure, but it is not the business security
boundary.

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
Mac Agent. Configuration:

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

- `GET /metrics` — JSON snapshot of `proposed`, `committed`, `failed[reason]`,
  `downgrade[reason]`, `prefs[preference]`, `skipped_by_pref`, `in_flight`,
  `active_p2p`, `durations` (p50/p95/max over the last 100 successful
  upgrades).
- `POST /debug/upgrade?device_id=<id>` — manually triggers an upgrade for a
  paired device; included in metrics and logs.

Full architecture, downgrade triggers, and a troubleshooting runbook live in
[docs/relay-architecture.md](../../docs/relay-architecture.md).
