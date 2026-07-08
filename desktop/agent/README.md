# OmniWork 桌面端 Agent

TypeScript/Node.js 桌面端 Agent for managing Terminal provider TUI sessions.

## Current MVP

- Generates a fresh 32-character temporary key on every start.
- Saves the key to `~/Library/Application Support/OmniWork/agent/session-key.json`.
- Persists a local `dev_` device ID in `~/.omniwork/agent.json`, with `sha256(deviceId + sha256(ip + hostname))` checksum validation. On macOS, the agent also uses Keychain when it is safely available.
- Uses `0600` file permissions and `0700` parent directory permissions.
- Reads convention-based YAML configuration; `relay.url` is required unless Relay device credentials already provide it.
- Reconnects to Relay with exponential backoff. The only Relay-driven path that
  stops the local Agent service and exits the Agent process is WebSocket close
  `4404` with reason `agent_disabled` or `ip_banned`, which is reserved for an
  explicit operator disable or IP-ban action.
- Manages configured Terminal provider TUI sessions through `tmux` once tmux is installed.
- Persists user-edited session titles through the `session.rename` protocol message.
- Discovers remote workspaces from managed/external tmux session working directories, including path availability and Git repository detection.
- Provides workspace file listing/reading/writing for supported UTF-8 text files, plus read-only Git status/diff messages. File type policy is centralized in `src/files/fileTypePolicy.ts`: untracked Git line stats are bounded by file count, file size, and concurrency limits; binary, lock, generated, archive, media, and database-like files are listed without reading them as text.
- Runs a local Agent Probe hook receiver for Codex / Claude Code / Trae / Trae CN events and auto-installs Codex, Claude Code, and Trae CLI hooks with the shared `omniwork-agent-hook.mjs` script.
- Server-driven terminal frames: each attached session runs a ~450ms pusher in `src/core/terminalFramePusher.ts` that captures the current PTY snapshot, hashes it with SHA-1, and emits `terminal.frame` only when the hash changes. Terminal input/resize/frame hot paths use `SessionManager`'s lightweight in-memory session cache before falling back to the authoritative `session.list` reconciliation path.
- Serves the local Agent Admin UI from `static/admin/index.html`; keep UI HTML/CSS/JS there instead of embedding it in `src/core/adminServer.ts`.

## Run

```sh
node --experimental-strip-types src/main.ts
```

By convention, the Agent looks for `config.yml` in this order:

```text
1. Explicit path from --config / -c
2. config.yml in the current working directory
3. config.yml next to the running omniwork-agent program
4. config.yml in the desktop/agent package root
5. System global config:
   - macOS: ~/Library/Application Support/OmniWork/agent/config.yml
   - Linux: ${XDG_CONFIG_HOME:-~/.config}/omniwork/agent/config.yml
   - Windows: %APPDATA%/OmniWork/agent/config.yml
```

Use `omniwork-agent --config /path/to/config.yml` when you need to point the
Agent at a specific config file for one launch. The config is intentionally
sparse: omitted fields use safe local defaults. See `config.example.yml` for a
fully annotated template.

Example config:

```yml
relay:
  url: wss://relay.company.example/relay/ws/agent

agent:
  deviceId: my-desktop
  displayName: Alice DesktopBook
  identityPath: /Users/me/.omniwork/agent.json
  requireE2e: true

paths:
  defaultCwd: /Users/me/Code

terminal:
  streamEnabled: false
  commands:
    codex: codex
    claude: claude
    gemini: gemini
    trae: traecli
    trae-cn: traecli
```

Keychain is macOS-only and does not need a user-facing switch. On macOS, the
agent first verifies the user login keychain with non-interactive `security`
checks; if the keychain is missing, locked, or otherwise unavailable, it
silently falls back to the local identity file. On other platforms the agent
uses `~/.omniwork/agent.json`.

`terminal.providers` is the primary way to choose and extend terminal providers.
When it is unset, the 桌面端 Agent falls back to the default Codex, Claude,
Gemini, Trae, and Trae CN presets. `terminal.commands` only overrides those
fallback preset commands. Trae and Trae CN Probe events are kept as separate
providers: `trae` and `trae-cn`.

Example custom provider set:

```yml
terminal:
  providers:
    - kind: codex
      displayName: Codex
      command: codex
      capability: codex.cli
      summary: OpenAI Codex CLI TUI session
    - kind: opencode
      displayName: OpenCode
      command: opencode
      capability: opencode.cli
      summary: OpenCode CLI TUI session
```

Provider metadata is sent to the App through `agent.hello` and `session.list`,
so the App can display and create configured providers without hardcoded
Codex/Claude/Gemini assumptions.

When Relay is started with `OMNIWORK_RELAY_AUTH_MODE=email_link`, the Agent
must send device-signature auth in `agent.hello`. Register on the Relay website
at `/auth/`, create a device token, then run:

```sh
omniwork-agent enroll \
  --relay-url wss://relay.example.com/relay/ws/agent \
  --token <device-enrollment-token>
```

The command generates an Ed25519 key pair and stores `relayUrl`, Relay-owned
`deviceId`, and the local private key in
`<OMNIWORK_APP_SUPPORT_DIR>/relay-device.json`. Later Agent starts read that file
automatically. `OMNIWORK_RELAY_URL`, `OMNIWORK_DEVICE_ID`, and
`OMNIWORK_AGENT_RELAY_DEVICE_PRIVATE_KEY` remain supported as legacy fallbacks
when the same values are not present in `config.yml`.
If no stored key or private-key environment variable is present, the Agent keeps
the legacy hello format for relays running with `OMNIWORK_RELAY_AUTH_MODE=none`.

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
