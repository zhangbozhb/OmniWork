# OmniWork 桌面端 Agent

TypeScript/Node.js 桌面端 Agent for managing Terminal provider TUI sessions.

## Current MVP

- Generates a fresh 32-character temporary key on every start.
- Saves the key to `~/Library/Application Support/OmniWork/agent/session-key.json`.
- Persists a local `dev_` device ID in `~/.omniwork/agent.json`, with `sha256(deviceId + sha256(ip + hostname))` checksum validation. On macOS, the agent also uses Keychain when it is safely available.
- Uses `0600` file permissions and `0700` parent directory permissions.
- Requires `OMNIWORK_RELAY_URL` and fails fast when it is missing.
- Reconnects to Relay with exponential backoff unless Relay explicitly rejects the Agent.
- Manages configured Terminal provider TUI sessions through `tmux` once tmux is installed.
- Persists user-edited session titles through the `session.rename` protocol message.
- Discovers remote workspaces from managed/external tmux session working directories, including path availability and Git repository detection.
- Provides workspace file listing/reading/writing for supported UTF-8 text files, plus read-only Git status/diff messages. File type policy is centralized in `src/files/fileTypePolicy.ts`: untracked Git line stats are bounded by file count, file size, and concurrency limits; binary, lock, generated, archive, media, and database-like files are listed without reading them as text.
- Runs a local Agent Probe hook receiver for Codex / Claude Code / Trae / Trae CN events and auto-installs Codex / Claude Code hooks with the shared `omniwork-agent-hook.mjs` script.
- Server-driven terminal frames: each attached session runs a ~450ms pusher in `src/core/terminalFramePusher.ts` that captures the current PTY snapshot, hashes it with SHA-1, and emits `terminal.frame` only when the hash changes. Terminal input/resize/frame hot paths use `SessionManager`'s lightweight in-memory session cache before falling back to the authoritative `session.list` reconciliation path.
- Serves the local Agent Admin UI from `static/admin/index.html`; keep UI HTML/CSS/JS there instead of embedding it in `src/core/adminServer.ts`.

## Run

```sh
node --experimental-strip-types src/main.ts
```

Useful environment variables:

```sh
OMNIWORK_RELAY_URL=wss://relay.company.example/relay/ws/agent
OMNIWORK_DEVICE_ID=my-desktop
OMNIWORK_AGENT_DISPLAY_NAME="Alice DesktopBook"
OMNIWORK_AGENT_IDENTITY_PATH=/Users/me/.omniwork/agent.json
OMNIWORK_CODEX_COMMAND=codex
OMNIWORK_CLAUDE_COMMAND=claude
OMNIWORK_CLAUDECODE_COMMAND=claudecode
OMNIWORK_GEMINI_COMMAND=gemini
OMNIWORK_TRAE_COMMAND=traecli
OMNIWORK_TRAE_CN_COMMAND=traecli
OMNIWORK_DEFAULT_CWD=/Users/me/Code
OMNIWORK_APP_SUPPORT_DIR=/tmp/omniwork-agent
OMNIWORK_TERMINAL_STREAM_ENABLED=false
```

Keychain is macOS-only and does not need a user-facing switch. On macOS, the
agent first verifies the user login keychain with non-interactive `security`
checks; if the keychain is missing, locked, or otherwise unavailable, it
silently falls back to the local identity file. On other platforms the agent
uses `~/.omniwork/agent.json`.

`OMNIWORK_TERMINAL_PROVIDERS` is the primary way to choose and extend terminal
providers. When it is unset, the 桌面端 Agent falls back to the default Codex,
Claude, Gemini, Trae, and Trae CN presets. The `OMNIWORK_CODEX_COMMAND`,
`OMNIWORK_CLAUDE_COMMAND`, `OMNIWORK_CLAUDECODE_COMMAND`,
`OMNIWORK_GEMINI_COMMAND`, `OMNIWORK_TRAE_COMMAND`, and
`OMNIWORK_TRAE_CN_COMMAND` variables only override those fallback preset
commands. `OMNIWORK_CLAUDECODE_COMMAND` is an alias for environments where the
Claude Code executable or wrapper is named `claudecode`; internally the Probe
provider remains `claude-code`. Trae and Trae CN Probe events are kept as
separate providers: `trae` and `trae-cn`.

Example custom provider set:

```sh
OMNIWORK_TERMINAL_PROVIDERS='[
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

Workspaces are not configured provider lists. The 桌面端 Agent discovers them from
the current working directories of managed sessions and existing tmux sessions.
When a session cwd is inside a Git repository, the workspace is promoted to the
Git root; otherwise the cwd itself is used. The workspace path is the stable
identifier, and the display name falls back to the final path segment. Git UI
appears in the App only when the discovered workspace is inside a Git
repository; non-Git directories still support file browsing, guarded text
editing for supported file types, and session grouping.

## Verify

```sh
pnpm --filter @omniwork/desktop-agent test
```
