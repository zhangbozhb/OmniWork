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

Environment:

```text
OMNIWORK_RELAY_HOST=127.0.0.1
OMNIWORK_RELAY_PORT=8787
```

Production should run this behind company TLS so the App uses `wss://`.
