# OmniWork Mac Agent

TypeScript/Node.js Mac Agent for managing Codex TUI sessions.

## Current MVP

- Generates a fresh 32-character temporary key on every start.
- Saves the key to `~/Library/Application Support/OmniWork/agent/session-key.json`.
- Uses `0600` file permissions and `0700` parent directory permissions.
- Connects to Relay when `OMNIWORK_RELAY_URL` is set.
- Uses `OMNIWORK_PAIRING_RELAY_URL` for QR pairing when the App must connect to a different public Tunnel Service URL.
- Uses `OMNIWORK_PAIRING_TRANSPORT` to write the App connection type into the QR code. Supported values are `webrtc` and `websocket`.
- Runs without Relay for local key-generation and environment checks.
- Manages Codex TUI sessions through `tmux` once tmux is installed.

## Run

```sh
node --experimental-strip-types src/main.ts
```

Useful environment variables:

```sh
OMNIWORK_RELAY_URL=wss://relay.company.example/agent
OMNIWORK_PAIRING_RELAY_URL=wss://tunnel.company.example/mobile
OMNIWORK_PAIRING_TRANSPORT=webrtc
OMNIWORK_DEVICE_ID=my-mac
OMNIWORK_CODEX_COMMAND=codex
OMNIWORK_DEFAULT_CWD=/Users/me/Code
OMNIWORK_APP_SUPPORT_DIR=/tmp/omniwork-agent
```

## Verify

```sh
node --experimental-strip-types tests/auth-key.test.ts
```
