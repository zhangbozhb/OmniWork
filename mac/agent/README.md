# OmniWork Mac Agent

TypeScript/Node.js Mac Agent for managing Codex TUI sessions.

## Current MVP

- Generates a fresh 32-character temporary key on every start.
- Saves the key to `~/Library/Application Support/OmniWork/agent/session-key.json`.
- Uses `0600` file permissions and `0700` parent directory permissions.
- Connects to Relay when `OMNIWORK_RELAY_URL` is set.
- Runs without Relay for local key-generation and environment checks.
- Manages Codex TUI sessions through `tmux` once tmux is installed.

## Run

```sh
node --experimental-strip-types src/main.ts
```

Useful environment variables:

```sh
OMNIWORK_RELAY_URL=wss://relay.company.example/agent
OMNIWORK_DEVICE_ID=my-mac.local
OMNIWORK_CODEX_COMMAND=codex
OMNIWORK_DEFAULT_CWD=/Users/me/Code
OMNIWORK_APP_SUPPORT_DIR=/tmp/omniwork-agent
```

## Verify

```sh
node --experimental-strip-types tests/auth-key.test.ts
```
