# OmniWork 桌面端 Agent

TypeScript/Node.js 桌面端 Agent for managing Terminal provider TUI sessions.

## Install

Requires Node.js 22.6 or newer and `tmux`.

```sh
npm install --global @omni-work/desktop-agent
omniwork-agent --config /path/to/config.yml
```

Validate configuration without starting the agent:

```sh
omniwork-agent --check --config /path/to/config.yml
```

## Current MVP

- Generates one long-term Ed25519 Agent identity on first use and reuses it.
  The `DEV1-...` device ID is derived from the public key and includes a
  checksum.
- Stores the identity in the macOS login Keychain when available and mirrors it
  to `identity-v2.json` with `0600` file and `0700` directory permissions.
- Defaults to local approval in Agent Admin before trusting a new App identity.
  `appAuthorization.mode: automatic` can instead trust cryptographically
  verified App identities immediately. Revocation invalidates active
  connections for that App.
- Uses a separate local probe bearer token in `probe-token.json`; the token is
  never reused for App-Agent authentication.
- Reads convention-based YAML configuration; `relay.url` is required.
- Reconnects to Relay with exponential backoff. The only Relay-driven path that
  stops the local Agent service and exits the Agent process is WebSocket close
  `4404` with reason `agent_disabled` or `ip_banned`, which is reserved for an
  explicit operator disable or IP-ban action.
- Manages configured Terminal provider TUI sessions through `tmux` once tmux is installed.
- Persists user-edited session titles through the `session.rename` protocol message.
- Discovers remote workspaces from managed/external tmux session working directories, including path availability and Git repository detection.
- Creates a user-specified session working directory recursively when it does not exist. Directory creation or access failures reject the whole session creation request.
- Provides workspace file listing/reading/writing for supported UTF-8 text files, Git status/diff, and controlled index-only stage/unstage actions. Git writes use typed E2E messages, literal pathspecs, current-change checks, and reject directories or paths outside the Workspace. File type policy is centralized in `src/files/fileTypePolicy.ts`: untracked Git line stats are bounded by file count, file size, and concurrency limits; binary, lock, generated, archive, media, and database-like files are listed without reading them as text.
- Runs structured AgentSurface sessions over local stdio subprocesses. Codex and TraeX use `app-server --listen stdio://`; Claude Code uses `-p --input-format stream-json --output-format stream-json`. The runner accepts repeated prompts and emits incremental provider-neutral surface events without parsing terminal rendering. Surface events are persisted in the session SQLite database and served to reconnecting Apps through cursor-based `agent.surface.sync` pages.
- Bridges Provider approval and user-input requests through the encrypted `agent.interaction` protocol. Pending requests and idempotent resolutions are stored in SQLite; unanswered requests expire conservatively after a timeout or Desktop Agent restart.
- Resolves prompt file references on the Desktop instead of trusting App-supplied contents. Context files must belong to the Session Workspace, pass the existing realpath and UTF-8 checks, and fit within ten files and 256 KiB total before read-only snapshots are added to the Provider prompt.
- Lists Git worktrees and creates named managed worktrees under `~/.omniwork/worktrees/<workspace-hash>/`. The Desktop Agent fixes the base to current `HEAD`, generates an `omniwork/<name>` branch, coalesces concurrent duplicate creates, and does not expose arbitrary destination paths or worktree removal.
- Supports composite managed-worktree Session creation. A `session.create` request can create or reuse the managed worktree and then start the Runtime there; duplicate `create_action_id` values share one in-process result. If Runtime startup fails after Git succeeds, the worktree is retained and the error explicitly supports a same-name retry.
- Publishes each Pending Interaction once to the SQLite Agent inbox with a high-priority, content-minimized notification summary. Reconnecting Apps recover the inbox through `agent.message.list`; native APNs/FCM delivery remains outside the Desktop Agent.
- Retains the Codex SDK adapter and dependency as an explicit future fallback. The current runtime does not automatically switch from app-server to the SDK.
- Trae IDE and TraeX/`traecli` reuse skills from `~/.trae/skills`, but keep separate hook configuration: Trae uses `~/.trae/hooks.json`, while TraeX uses `~/.trae/cli/hooks.json`. Trae CN remains isolated under `~/.trae-cn`.
- Runs a local Agent Probe hook receiver for low-frequency Codex / Claude Code / Trae / Trae CN lifecycle and attention events. The receiver acknowledges valid requests before ordered background persistence, and hook session enrichment uses the in-memory Session cache instead of invoking `tmux list-sessions`. Codex and Claude Code do not install per-tool OmniWork hooks. POST hooks fail open after 250ms; Trae and Trae CN also keep one deduplicated local record hook for SessionStart, UserPromptSubmit, and Stop.

Claude Code observation hooks use its native `async: true` mode. Do not apply
that field to Codex: current Codex parses it but skips asynchronous command
handlers. Trae does not document an equivalent portable mode, so its
non-blocking boundary remains the local receiver's immediate acknowledgement
followed by ordered Desktop-side processing.
- Server-driven terminal frames: each attached session runs a ~450ms pusher in `src/core/terminalFramePusher.ts` that captures the current PTY snapshot, hashes it with SHA-1, and emits `terminal.frame` only when the hash changes. Terminal input/resize/frame hot paths use `SessionManager`'s lightweight in-memory session cache before falling back to the authoritative `session.list` reconciliation path.
- Serves the local Agent Admin UI from `static/admin/index.html`; keep UI HTML/CSS/JS there instead of embedding it in `src/core/adminServer.ts`.
  The page provides English and Simplified Chinese resources. It prefers an
  explicit selection from the non-sensitive `omniwork_admin_locale` cookie,
  then inspects the browser language list, and finally uses the browser time
  zone as a fallback. Mainland China time zones select Simplified Chinese;
  other unsupported combinations default to English.

## Run

For repository development:

```sh
node --experimental-strip-types src/main.ts
```

The delivery-learning tables use an explicit local schema version. New
databases are created at the current version. Existing databases must already
match that version; the runtime does not contain old-schema migration or
column-repair branches.

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
  displayName: Alice DesktopBook
  identityPath: /Users/me/Library/Application Support/OmniWork/agent/identity-v2.json

appAuthorization:
  mode: manual

paths:
  defaultCwd: /Users/me/Code
  probeTokenPath: /Users/me/Library/Application Support/OmniWork/agent/probe-token.json
  trustedAppsPath: /Users/me/Library/Application Support/OmniWork/agent/trusted-apps-v2.json

terminal:
  streamEnabled: false
  commands:
    codex: codex
    claude: claude
    gemini: gemini
    traex: traecli
```

`appAuthorization.mode` accepts `manual` (default) or `automatic`. Automatic
mode still requires valid App identity signatures and protocol scope
validation, then persists the trusted App before returning `auth.ok`. A revoked
or removed App is automatically trusted again on its next valid connection
while this mode remains enabled.
The equivalent environment variable is
`OMNIWORK_AGENT_APP_AUTHORIZATION_MODE`. Identity, Probe token, and trusted-App
paths can be overridden with `OMNIWORK_AGENT_IDENTITY_PATH`,
`OMNIWORK_AGENT_PROBE_TOKEN_PATH`, and `OMNIWORK_TRUSTED_APPS_PATH`.

When a loopback Relay URL is converted for the pairing QR code, the Agent
chooses a non-loopback IPv4 address and excludes `169.254.0.0/16` link-local
addresses, which are not suitable as general client connection targets.

### Agent Admin security

The default Agent Admin has no bearer token and is intended for its loopback
browser page. In this mode, approve, reject, revoke, and remove requests require
both a loopback client address and a same-origin loopback `Origin` header.
Revocation retains the App identity record; removal also deletes its trust
record and observed connection history. Either action disconnects the active
App, which must be approved again before reconnecting. Remote or CLI write
access must configure `admin.token` and send
`Authorization: Bearer <token>`; all Admin API routes then require that token.
The server refuses a non-loopback `admin.host` when no token is configured.
Pending approvals are keyed by App identity. Reconnects from the same App
refresh the existing request instead of adding one row per Relay connection.
The pending table shows the App name, device platform, and Relay-observed IP.
Selecting a row opens the signed App/device metadata, requested scopes, and
request timing, with approve and reject actions available in the detail view.

Keychain is macOS-only and does not need a user-facing switch. On macOS, the
agent first verifies the user login keychain with non-interactive `security`
checks; if the keychain is missing, locked, or otherwise unavailable, it
silently falls back to the local identity file. On other platforms the agent
uses `identity-v2.json` under the platform application-support directory.

`terminal.providers` is the primary way to choose and extend terminal providers.
When it is unset, the 桌面端 Agent falls back to the default Codex, Claude,
Gemini, and TraeX presets. `terminal.commands` only overrides those fallback
preset commands. `traex` is the CLI provider (`traex` and `traecli` are command
aliases); `trae` and `trae-cn` are kept as separate IDE Probe providers.

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

Every Relay connection uses the Agent identity: the Agent sends a time-bound
`agent.auth.init` signature, receives a stateless `agent.auth.challenge`, then
signs that challenge in `agent.hello.relay_auth`. With
`OMNIWORK_RELAY_AUTH_MODE=email_link`, the same identity must first be enrolled
to the owning user. Register on the Relay website at `/auth/`, create a device
token, then run:

```sh
omniwork-agent enroll \
  --relay-url wss://relay.example.com/relay/ws/agent \
  --token <device-enrollment-token> \
  --identity-path "/Users/me/Library/Application Support/OmniWork/agent/identity-v2.json"
```

The command creates the long-term Agent identity on first use or reuses the
existing identity. It registers the derived `deviceId` and public key; the
private key remains in the Agent identity store. Subsequent Agent starts use
the same identity automatically. `OMNIWORK_RELAY_URL` may still provide the
Relay URL when it is not present in `config.yml`; `--identity-path` is optional
and defaults to the configured application-support directory.

Workspaces are not configured provider lists. The 桌面端 Agent discovers them from
the current working directories of managed sessions and existing tmux sessions.
When a session cwd is inside a Git repository, the workspace is promoted to the
Git root; otherwise the cwd itself is used. The workspace path is the stable
identifier, and the display name falls back to the final path segment. Git UI
appears in the App only when the discovered workspace is inside a Git
repository; non-Git directories still support file browsing, guarded text
editing for supported file types, and session grouping.

Git index actions are deliberately narrower than a remote shell. The App can
stage or unstage explicit changed files, but cannot submit arbitrary Git
arguments, discard worktree content, commit, push, or delete a worktree. Both
actions are reversible without changing file contents. To roll the capability
back, stop advertising `git.write.index` and remove the App action controls;
there is no new persisted state or database migration.

## Verify

```sh
pnpm --filter @omni-work/desktop-agent test
```
