# OmniWork Mac Agent

TypeScript/Node.js Mac Agent for managing Agent CLI TUI sessions.

## Current MVP

- Generates a fresh 32-character temporary key on every start.
- Saves the key to `~/Library/Application Support/OmniWork/agent/session-key.json`.
- Persists a local `dev_` device ID in macOS Keychain first and `~/.omniwork/agent.json` as the file fallback, with `sha256(deviceId + sha256(ip + hostname))` checksum validation.
- Uses `0600` file permissions and `0700` parent directory permissions.
- Requires `OMNIWORK_RELAY_URL` and fails fast when it is missing.
- Reconnects to Relay with exponential backoff unless Relay explicitly rejects the Agent.
- Manages configured Agent CLI TUI sessions through `tmux` once tmux is installed.
- Persists user-edited session titles through the `session.rename` protocol message.
- Discovers remote workspaces from managed/external tmux session working directories, including path availability and Git repository detection.
- Provides workspace file listing/reading/writing for supported UTF-8 text files, plus read-only Git status/diff messages.
- Server-driven terminal frames: each attached session runs a ~450ms pusher in `src/core/agentService.ts` that captures the current PTY snapshot, hashes it with SHA-1, and emits `terminal.frame` only when the hash changes. The App no longer polls the snapshot on a 3s idle interval or after each input.
- Serves the local Agent Admin UI from `static/admin/index.html`; keep UI HTML/CSS/JS there instead of embedding it in `src/core/adminServer.ts`.

## Run

```sh
node --experimental-strip-types src/main.ts
```

Useful environment variables:

```sh
OMNIWORK_RELAY_URL=wss://relay.company.example/relay/ws/agent
OMNIWORK_DEVICE_ID=my-mac
OMNIWORK_AGENT_DISPLAY_NAME="Alice MacBook"
OMNIWORK_AGENT_IDENTITY_PATH=/Users/me/.omniwork/agent.json
OMNIWORK_AGENT_IDENTITY_KEYCHAIN=1
OMNIWORK_CODEX_COMMAND=codex
OMNIWORK_CLAUDE_COMMAND=claude
OMNIWORK_GEMINI_COMMAND=gemini
OMNIWORK_DEFAULT_CWD=/Users/me/Code
OMNIWORK_APP_SUPPORT_DIR=/tmp/omniwork-agent
OMNIWORK_TERMINAL_STREAM_ENABLED=false
```

`OMNIWORK_AGENT_PROVIDERS` is the primary way to choose and extend Agent CLI
providers. When it is unset, the Mac Agent falls back to the default Codex,
Claude, and Gemini presets. The `OMNIWORK_CODEX_COMMAND`,
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
repository; non-Git directories still support file browsing, guarded text
editing for supported file types, and session grouping.

## Verify

```sh
pnpm --filter @omniwork/mac-agent test
```
