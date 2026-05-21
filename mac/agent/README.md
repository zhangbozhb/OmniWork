# OmniWork Mac Agent

TypeScript/Node.js Mac Agent for managing Agent CLI TUI sessions.

## Current MVP

- Generates a fresh 32-character temporary key on every start.
- Saves the key to `~/Library/Application Support/OmniWork/agent/session-key.json`.
- Uses `0600` file permissions and `0700` parent directory permissions.
- Connects to Relay when `OMNIWORK_RELAY_URL` is set.
- Uses `OMNIWORK_PAIRING_RELAY_URL` for QR pairing when the App must connect to a different public Tunnel Service URL.
- Uses `OMNIWORK_PAIRING_TRANSPORT` to write the App connection type into the QR code. Supported values are `webrtc` and `websocket`.
- Runs without Relay for local key-generation and environment checks.
- Manages configured Agent CLI TUI sessions through `tmux` once tmux is installed.
- Persists user-edited session titles through the `session.rename` protocol message.
- Discovers remote workspaces from managed/external tmux session working directories, including path availability and Git repository detection.
- Provides read-only workspace file listing/reading and read-only Git status/diff messages.
- Server-driven terminal frames: each attached session runs a ~450ms pusher in `src/core/agentService.ts` that captures the current PTY snapshot, hashes it with SHA-1, and emits `terminal.frame` only when the hash changes. The App no longer polls the snapshot on a 3s idle interval or after each input.

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
OMNIWORK_CLAUDE_COMMAND=claude
OMNIWORK_GEMINI_COMMAND=gemini
OMNIWORK_DEFAULT_CWD=/Users/me/Code
OMNIWORK_APP_SUPPORT_DIR=/tmp/omniwork-agent
```

`OMNIWORK_AGENT_PROVIDERS` is the primary way to choose and extend Agent CLI
providers. When it is unset, the Mac Agent falls back to the default Codex,
Claude, and Gemini presets. The legacy `OMNIWORK_CODEX_COMMAND`,
`OMNIWORK_CLAUDE_COMMAND`, and `OMNIWORK_GEMINI_COMMAND` variables only override
those fallback preset commands.

Example custom provider set:

```sh
OMNIWORK_AGENT_PROVIDERS='[
  {
    "kind": "codex",
    "displayName": "Codex",
    "command": "codex",
    "capability": "codex.cli",
    "summary": "OpenAI Codex CLI TUI session"
  },
  {
    "kind": "opencode",
    "displayName": "OpenCode",
    "command": "opencode",
    "capability": "opencode.cli",
    "summary": "OpenCode CLI TUI session"
  }
]'
```

Provider metadata is sent to the App through `agent.hello` and `session.list`,
so the App can display and create configured providers without hardcoded
Codex/Claude/Gemini assumptions.

Workspaces are not configured provider lists. The Mac Agent discovers them from
the current working directories of managed sessions and existing tmux sessions.
When a session cwd is inside a Git repository, the workspace is promoted to the
Git root; otherwise the cwd itself is used. The workspace path is the stable
identifier, and the display name falls back to the final path segment. Git UI
appears in the App only when the discovered workspace is inside a Git
repository; non-Git directories still support read-only file browsing and
session grouping.

## Verify

```sh
node --experimental-strip-types tests/auth-key.test.ts
```
