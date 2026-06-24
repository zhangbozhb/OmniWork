# Agent Probe Sink 消息感知与推送设计

关联技术方案：[mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)

## 结论摘要

对 Codex、Claude Code、OpenCode、Gemini CLI 这类 coding agent，不采用外部 Agent 直接推送到 App 的模型，也不把不同 Agent 的私有事件协议暴露给 App。

最终采用「专属 Agent Probe + Hook 感知 + Desktop Agent 内部 Probe Sink + 本机消息过滤 + 多端投递」架构：

```text
Codex / Claude Code / OpenCode / Gemini CLI
        ↓
专属 Agent Probe + Hook
        ↓
Desktop Agent 内部 Agent Probe Sink
        ↓
Agent Event Normalizer
        ↓
Agent Message Filter
        ↓
Agent Message Router
        ↓
App Delivery Layer
        ↓
Android / iOS / Web App
```

核心边界：

- 不同 coding agent 的差异由各自 Probe 消化。
- Desktop Agent 只接收统一的 `AgentProbeEvent`。
- App 只接收过滤后的 `AgentAppMessage`。
- Relay 仍只转发 E2E 加密业务消息，不理解 Probe 或 Agent 消息语义。
- Codex Probe 采用 app-server、hooks、PTY/tmux 三通道：app-server 是结构化主路径，hooks 是生命周期和治理补充路径，PTY/tmux 是兼容兜底路径。
- tmux / PTY 属于 `TerminalSurface` 后端；Codex app-server 或其他结构化协议才属于 `AgentSurface` 后端。
- Hooks 只提供感知和治理信号，不作为 AgentSurface 的主交互协议。

## 实装状态

- 已落地：`packages/protocol-ts` 中的 `AgentProbeEvent`、`AgentAppMessage` 与 `agent.message*` 协议类型。
- 已落地：桌面端 Agent 内部 `AgentMessageService`，支持 Probe Event 幂等去重、基础过滤、内存消息列表、已读回执和在线 App 广播。
- 已落地：Codex / Claude Code Hooks Channel 的本机 HTTP receiver，默认监听 `127.0.0.1:17669/api/probes/hooks`，通过 `Authorization: Bearer <token>` 校验，并按 `omniwork_hook_source` 分发到对应 Probe。
- 已落地：`desktop/agent/bin/omniwork-agent-hook.mjs`，用于 Codex / Claude Code command hook 将 stdin JSON 转交给本机 receiver。
- 已落地：Codex hooks 自动安装。Desktop Agent 启动生成 session key 后会立即检测并合并写入 `~/.codex/hooks.json`，该步骤发生在 admin server / hook receiver 监听端口之前；启动 Codex runtime 前也会二次校验。不会覆盖用户已有 hooks；安装失败只记录 warning，不阻断 Desktop Agent 或 Codex 会话启动。
- 已落地：Claude Code hooks 自动安装。Desktop Agent 启动生成 session key 后会检测并合并写入 `~/.claude/settings.json`；启动 Claude runtime 前也会二次校验。不会覆盖用户已有 hooks；安装失败只记录 warning，不阻断 Desktop Agent 或 Claude 会话启动。
- 尚未落地：Codex App Server Channel、PTY/tmux Probe Channel、SQLite pending inbox、系统 Push、通知偏好 UI。

## 术语定义

| 中文术语 | 英文术语 | 定义 |
|---|---|---|
| 编码 Agent | Coding Agent | Codex、Claude Code、OpenCode、Gemini CLI 等运行在电脑本地的 CLI / TUI / app-server 编码工具。 |
| 工作区 | Workspace | 工作目录、repo 或项目上下文，不代表具体交互形态。 |
| 工作会话 | WorkSession | 一次可恢复的工作单元，可同时挂载多个交互入口。 |
| 交互入口 | Surface | App 面向用户展示和操作的入口，例如 TerminalSurface、AgentSurface、文件和 diff surface。 |
| 运行绑定 | RuntimeBinding | Surface 背后的本机实现绑定，例如 tmux session、PTY、app-server thread、socket 或进程。 |
| 终端交互入口 | TerminalSurface | 基于字符流、按键、resize、终端快照和终端帧的交互入口。 |
| Agent 交互入口 | AgentSurface | 基于结构化 Agent 协议的交互入口，承载 prompt、turn、plan、tool、approval、diff 和 completion。 |
| Agent 探针 | Agent Probe | 针对某一类 coding agent 的专属感知模块，负责理解该 Agent 的事件源。 |
| 探针 Hook | Probe Hook | Probe 内部接入具体事件源的机制，例如 app-server event、CLI hook、PTY 输出、tmux pane 状态、进程生命周期、文件变更或 Git diff。 |
| 探针接收器 | Agent Probe Sink | Desktop Agent 内部统一接收 Probe 事件的入口。 |
| 事件归一化器 | Agent Event Normalizer | 补齐 session、workspace、provider 等元数据，并把事件转成统一语义。 |
| 消息过滤器 | Agent Message Filter | 判断哪些事件能进入 App 消息流或系统通知，并执行去重、频控、权限和敏感信息过滤。 |
| 消息路由器 | Agent Message Router | 根据 App 在线状态、端类型和消息优先级选择投递路径。 |

## Surface 与 Probe 的关系

Probe/Sink 不直接定义 App 的交互形态，它负责把 coding agent 的私有事件转成统一事实流。`Surface` 决定这些事实如何被用户操作和查看。

```text
TerminalSurface
  后端：tmux / PTY / shell
  输入：text / key / paste / resize
  输出：terminal.snapshot / terminal.frame

AgentSurface
  后端：Codex app-server / Claude Code 结构化协议
  输入：prompt / approval / cancel / resume / user input
  输出：thread / turn / plan / tool / diff / completion event

Probe Sink
  输入：app-server event / hooks / PTY signal / process / git
  输出：AgentProbeEvent / AgentAppMessage
```

运行在 tmux 中的 Codex / Claude Code TUI 仍然是 `TerminalSurface`。只有当 Desktop Agent 能绑定到 app-server thread 或等价结构化协议时，才创建 `AgentSurface`。两者可以属于同一个 `WorkSession`：

```text
tmux -> codex TUI
  TerminalSurface active

Codex app-server thread detected
  AgentSurface active
  TerminalSurface still active

Codex TUI exits to shell
  AgentSurface ended / detached
  TerminalSurface still active
```

`AgentSurface` 的产品形态不是纯聊天，而是 `Thread + Turn + Timeline + Approval + Diff + Tool Activity + Composer`。聊天气泡只适合展示 user prompt 和 assistant response；plan、tool、diff、approval 必须保留结构化组件。

## 职责边界

### Agent Probe

每个 coding agent 单独实现自己的 Probe：

```text
CodexProbe
ClaudeCodeProbe
OpenCodeProbe
GeminiCliProbe
```

Probe 负责：

- 连接对应 Agent 的可用事件源。
- 感知任务开始、计划生成、工具调用、审批等待、用户输入等待、文件修改、diff 变化、完成、失败和退出。
- 将私有事件转换为统一 `AgentProbeEvent`。
- 处理该 Agent 独有的 hook、输出格式和兼容逻辑。

Probe 不负责：

- 决定是否系统通知用户。
- 直接连接 App。
- 直接连接 Relay。
- 直接写入 App 消息协议。

### Agent Probe Sink

`Agent Probe Sink` 是 Desktop Agent 内部能力，不是公网 Adapter，也不是 App 接入点。

Sink 负责：

- 接收不同 Probe 发布的 `AgentProbeEvent`。
- 校验事件 schema。
- 做基础幂等去重。
- 绑定 session、workspace 和 provider。
- 写入本地事件日志。
- 将事件交给 Normalizer 和 Message Filter。
- 对 Probe 异常做隔离，避免单个 Probe 影响 Desktop Agent 主链路。

### Agent Message Filter

Filter 负责把高频、低价值、敏感或重复的 Probe Event 控制在本机内。

过滤结果分三层：

| 层级 | 名称 | 行为 |
|---|---|---|
| Level 1 | Local Event | 只写本地事件日志，不发送给 App。 |
| Level 2 | In-App Message | 发送到 App 会话页、消息流或 Inbox。 |
| Level 3 | Push Notification | 允许触发系统通知，例如 APNs / FCM / 公司统一推送网关。 |

## Probe Hook 接入方式

### Codex Probe

Codex Probe 采用三通道设计：

```text
Codex App Server Channel
  - 结构化主路径
  - 感知 thread、turn、item、plan、diff、approval、completion

Codex Hooks Channel
  - 生命周期和治理补充路径
  - 感知 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Stop、SubagentStart、SubagentStop、PreCompact、PostCompact

Codex PTY / tmux Channel
  - TUI 兼容兜底路径
  - 从 TUI 输出快照、进程状态、tmux pane 状态中提取粗粒度事件
```

优先级：

| 通道 | 稳定性判断 | 负责事件 | 优先级 |
|---|---|---|---:|
| App Server Channel | 结构化能力最完整，WebSocket 传输仍不作为生产远程暴露路径；Desktop Agent 内部优先使用 stdio / Unix socket | thread、turn、item、approval、diff、plan | P0 |
| Hooks Channel | Codex 官方扩展机制，适合补充生命周期和治理信号；必须走本地 receiver | prompt、permission、tool 前后、stop、compact、subagent | P1 |
| PTY / tmux Channel | 只保证粗粒度可观测，不能作为语义主协议 | 进程存活、屏幕关键字、会话退出 | P2 |

Codex Probe 的推荐目录：

```text
desktop/agent/src/probes/codex/
  CodexProbe.ts
  channels/
    AppServerProbeChannel.ts
    HookProbeChannel.ts
    PtyProbeChannel.ts
  normalizers/
    normalizeAppServerEvent.ts
    normalizeHookEvent.ts
    normalizePtySignal.ts
  hook-receiver/
    agentHookReceiver.ts
    omniwork-agent-hook.mjs
```

#### Codex App Server Channel

Codex app-server 是 Codex Probe 的结构化主信号源。

Desktop Agent 负责启动或连接本机 `codex app-server`：

```text
codex app-server --listen stdio://
codex app-server --listen unix://
codex app-server --listen unix:///absolute/path.sock
```

约束：

- 不把 app-server 直接暴露给 App、Relay 或公司网络。
- 生产路径优先 stdio 或 Unix socket。
- loopback WebSocket 只用于本机调试或明确受控场景。
- Probe 必须能处理 app-server bounded queue 的 overloaded / retry。
- Probe 启动时生成或读取当前 Codex 版本 schema，避免把某一版私有字段写死。

Codex app-server 通知到 Probe Event 的默认映射：

| Codex app-server 信号 | CodexProbe 事件 |
|---|---|
| `thread/started` | `agent.started` |
| `thread/status/changed`，状态含 active / waiting | `agent.thinking` 或 `agent.waiting_user_input` |
| `turn/started` | `agent.thinking` |
| `turn/plan/updated` | `agent.plan_created` |
| `item/started`，`item.type = commandExecution / mcpToolCall / dynamicToolCall` | `agent.tool_call_started` |
| `item/completed`，`item.type = commandExecution / mcpToolCall / dynamicToolCall` | `agent.tool_call_finished` |
| `item/started` 或 `item/completed`，`item.type = fileChange` | `agent.file_changed` |
| `turn/diff/updated` | `agent.git_diff_changed` |
| `item/commandExecution/requestApproval` | `agent.approval_required` |
| `item/fileChange/requestApproval` | `agent.approval_required` |
| `item/tool/requestUserInput` | `agent.waiting_user_input` |
| `turn/completed`，状态 completed | `agent.completed` |
| `turn/completed`，状态 failed 或 error | `agent.failed` |

#### Codex Hooks Channel

Codex hooks 是补充信号源，不直接发送 App 消息。

Hook 命令只负责把 stdin JSON 原样转交给 Desktop Agent 的本地 hook receiver：

```text
Codex hook command
        ↓
omniwork-agent-hook.mjs
        ↓
Desktop Agent local hook receiver
        ↓
HookProbeChannel
        ↓
CodexProbe normalizeHookEvent
        ↓
Agent Probe Sink
```

推荐 hook 配置形态：

当前实现默认自动安装到用户级 `~/.codex/hooks.json`。以下 JSON 是自动安装后的目标形态示意；实际 `command` 会携带 `OMNIWORK_AGENT_PROBE_URL`、`OMNIWORK_SESSION_KEY_PATH`、`OMNIWORK_AGENT_HOOK_SOURCE=codex` 和阶段化的 `OMNIWORK_AGENT_HOOK_EVENT`，但不会把 token 明文写进 hooks 文件。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10,
            "statusMessage": "OmniWork collecting Codex session event"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Hook receiver 约束：

- receiver 只监听本机 loopback 或 Unix socket。
- hook receiver 必须校验 token；当前 MVP 默认复用桌面端 Agent 临时 session key，也可通过 `OMNIWORK_AGENT_PROBE_TOKEN` 覆盖。
- hook 自动安装在 Desktop Agent 启动后立即触发一次；启动具体 runtime 前也会二次触发，二次触发的识别规则是 `runtime.kind === "codex"` 或启动命令首词为 `codex`。
- hook 自动安装采用合并策略：只追加 OmniWork 缺失的 command hook，不修改或删除用户已有的非 OmniWork hooks。
- hook 自动安装按阶段生成 command，每个阶段都会写入对应的 `OMNIWORK_AGENT_HOOK_EVENT`，例如 `SessionStart`、`PermissionRequest`、`PostToolUse`、`Stop`；hook 脚本会用该值补齐缺失的 `hook_event_name`。
- hook 自动安装会检查 `omniwork-agent-hook` 命令有效性：当前阶段的完整 command 与 installer 生成值一致才视为有效；旧路径、缺失环境变量、来源参数不匹配、阶段参数不匹配或历史无效安装会被移除并替换。
- hook 自动安装不会把 token 写入 `~/.codex/hooks.json`；脚本通过 `OMNIWORK_SESSION_KEY_PATH` 定位 Desktop Agent 生成的 `session-key.json`，再读取其中的临时 key。
- hook command 不做 App 推送、不做消息过滤、不连接 Relay。
- hook command 失败不能阻塞 Codex 主流程，除非明确进入企业 managed hook 治理模式。
- `transcript_path` 只能作为辅助定位字段，不能当作稳定协议依赖。

本地 receiver 配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OMNIWORK_AGENT_PROBE_ENABLED` | `true` | 是否启用 Probe receiver。 |
| `OMNIWORK_AGENT_PROBE_HOST` | `127.0.0.1` | receiver 监听地址。 |
| `OMNIWORK_AGENT_PROBE_PORT` | `17669` | receiver 监听端口。 |
| `OMNIWORK_AGENT_PROBE_TOKEN` | 当前 session key | hook command 的 bearer token。 |

#### Claude Code Hooks Channel

Claude Code hooks 与 Codex hooks 走同一个本机 receiver 和同一个共享脚本，不直接发送 App 消息。

Claude Code 官方配置位置包括用户级 `~/.claude/settings.json`、项目级 `.claude/settings.json`、项目本地 `.claude/settings.local.json` 和 managed policy。当前实现只自动合并用户级 `~/.claude/settings.json`，避免修改项目仓库文件。

自动安装的 hook 事件与 Codex MVP 保持一致：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/omniwork-agent-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

实际 command 会携带：

- `OMNIWORK_AGENT_PROBE_URL=http://127.0.0.1:17669/api/probes/hooks`
- `OMNIWORK_SESSION_KEY_PATH=<Desktop Agent 生成的 session-key.json>`
- `OMNIWORK_AGENT_HOOK_SOURCE=claude-code`
- `OMNIWORK_AGENT_HOOK_EVENT=<当前 hook 阶段>`

Claude Code hook 到 Probe Event 的默认映射：

| Claude Code Hook | ClaudeCodeProbe 事件 | 默认处理 |
|---|---|---|
| `SessionStart` | `agent.started` | 可进入 App 内消息，不系统 Push |
| `UserPromptSubmit` | `agent.user_prompt_submitted` | 本地记录，默认不发 App |
| `PreToolUse` | `agent.tool_call_started` | 本地记录，默认不发 App |
| `PermissionRequest` | `agent.approval_required` | 可进入 App 内消息，可系统 Push |
| `PostToolUse` | `agent.tool_call_finished` | 本地记录，失败时可生成 warning |
| `PreCompact` | `agent.compaction_started` | 本地记录 |
| `PostCompact` | `agent.compaction_finished` | 本地记录 |
| `SubagentStart` | `agent.subagent_started` | App 内消息可选 |
| `SubagentStop` | `agent.subagent_completed` | App 内消息可选 |
| `Stop` | `agent.completed` | 可进入 App 内消息，系统 Push 可选 |
| `SessionEnd` | `agent.exited` | 本地记录 |

Codex hook 到 Probe Event 的默认映射：

| Codex Hook | CodexProbe 事件 | 默认处理 |
|---|---|---|
| `SessionStart` | `agent.started` | 可进入 App 内消息，不系统 Push |
| `UserPromptSubmit` | `agent.user_prompt_submitted` | 本地记录，默认不发 App |
| `PreToolUse` | `agent.tool_call_started` | 本地记录，默认不发 App |
| `PermissionRequest` | `agent.approval_required` | 可进入 App 内消息，可系统 Push |
| `PostToolUse` | `agent.tool_call_finished` | 本地记录，失败时可生成 warning |
| `PreCompact` | `agent.compaction_started` | 本地记录 |
| `PostCompact` | `agent.compaction_finished` | 本地记录 |
| `SubagentStart` | `agent.subagent_started` | App 内消息可选 |
| `SubagentStop` | `agent.subagent_completed` | App 内消息可选 |
| `Stop` | `agent.completed` | 可进入 App 内消息，系统 Push 可选 |

#### Codex PTY / tmux Channel

PTY / tmux 通道只作为兼容兜底。

允许感知：

- tmux session 创建、attach、detach、kill。
- Codex 进程启动、退出、异常。
- TUI 画面中可稳定识别的等待输入、approval、完成、失败关键状态。

禁止依赖：

- 对 TUI 文本做复杂 NLP 判断。
- 从屏幕文本解析完整 diff、命令输出或审批 payload。
- 用 PTY/tmux 通道替代 app-server 的结构化事件。

### Claude Code Probe

Claude Code Probe 推荐按能力可用性分层接入：

```text
Claude Code hook script
  - 如果 Claude Code 提供生命周期 hook，则优先使用

Claude Code CLI output hook
  - 解析 stdout / stderr 或 PTY 输出

Process lifecycle hook
  - 监听进程启动、退出、异常

Workspace / Git hook
  - 辅助判断文件修改和 diff 变化
```

### 其他 Coding Agent Probe

OpenCode、Gemini CLI 等后续 Agent 只需要新增各自 Probe，并输出统一 `AgentProbeEvent`，不要求改 App 消息协议。

## 统一 Probe Event 协议

不同 Probe 上报给 Sink 的最小结构：

```ts
type AgentProbeEvent = {
  id: string;
  provider: "codex" | "claude-code" | "opencode" | "gemini" | string;
  probe_id: string;
  session_id: string;
  workspace_id?: string;
  workspace_path?: string;

  event_type:
    | "agent.started"
    | "agent.thinking"
    | "agent.plan_created"
    | "agent.tool_call_started"
    | "agent.tool_call_finished"
    | "agent.file_changed"
    | "agent.git_diff_changed"
    | "agent.approval_required"
    | "agent.waiting_user_input"
    | "agent.user_prompt_submitted"
    | "agent.compaction_started"
    | "agent.compaction_finished"
    | "agent.subagent_started"
    | "agent.subagent_completed"
    | "agent.completed"
    | "agent.failed"
    | "agent.exited";

  severity: "debug" | "info" | "notice" | "warning" | "critical";

  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;

  source: {
    kind: "app-server" | "cli-hook" | "pty" | "tmux" | "process" | "filesystem" | "git";
    raw_event_id?: string;
  };

  created_at: string;
};
```

约束：

- `payload` 可以保留 Probe 私有字段，但不能直接透传给 App。
- `id` 在单个 Probe 内必须稳定，Sink 使用 `provider + probe_id + id` 做幂等键。
- `session_id` 必须能映射到 Desktop Agent 内部会话。
- `workspace_path` 只能用于本机绑定，不应作为 App 侧鉴权依据。

## App 消息协议

Filter 之后进入 App 的消息使用 `AgentAppMessage`：

```ts
type AgentAppMessage = {
  id: string;
  type: "agent.message";
  provider: string;
  session_id: string;
  workspace_id?: string;

  message_kind:
    | "status"
    | "plan"
    | "approval"
    | "input_required"
    | "result"
    | "error"
    | "diff_summary";

  title: string;
  summary?: string;
  priority: "low" | "normal" | "high" | "critical";

  action?: {
    type: "open_session" | "open_approval" | "open_diff" | "open_workspace";
    session_id?: string;
    workspace_id?: string;
  };

  created_at: string;
};
```

App 不处理 `AgentProbeEvent`，也不理解 Codex、Claude Code 等私有事件结构。

## 默认过滤规则

| Probe Event | In-App Message | Push Notification |
|---|---:|---:|
| `agent.started` | 可选 | 否 |
| `agent.thinking` | 否 | 否 |
| `agent.plan_created` | 是 | 否 |
| `agent.tool_call_started` | 否 | 否 |
| `agent.tool_call_finished` | 否 | 否 |
| `agent.file_changed` | 合并摘要 | 否 |
| `agent.git_diff_changed` | 合并摘要 | 否 |
| `agent.approval_required` | 是 | 是 |
| `agent.waiting_user_input` | 是 | 是 |
| `agent.user_prompt_submitted` | 否 | 否 |
| `agent.compaction_started` | 否 | 否 |
| `agent.compaction_finished` | 否 | 否 |
| `agent.subagent_started` | 可选 | 否 |
| `agent.subagent_completed` | 可选 | 可选 |
| `agent.completed` | 是 | 可选 |
| `agent.failed` | 是 | 是 |
| `agent.exited` | 可选 | 否 |

过滤器必须支持：

- 按用户、session、provider、event type 做频控。
- 对 `file_changed` / `git_diff_changed` 做时间窗口聚合。
- 对 `thinking`、tool call 进度等高频事件默认不打扰用户。
- 对审批、等待输入、失败等事件允许升级为系统通知。
- 对通知内容做敏感信息裁剪，系统 Push 只携带轻量摘要和 `message_id`。

## 多端投递

Desktop Agent 内部 Router 根据连接状态投递：

```text
App 在线：
  通过 App-Agent E2E 内层消息发送 agent.message

App 离线：
  写入 Desktop Agent 本地 pending inbox
  可选调用公司 Push Gateway / APNs / FCM 发轻量通知

App 重连：
  通过消息同步接口拉取 missed messages / inbox
```

系统 Push payload 不承载完整 Agent 内容：

```json
{
  "message_id": "msg_123",
  "title": "Claude Code 等待确认",
  "body": "有一个工具调用需要你处理",
  "action": "open_session"
}
```

完整内容必须由 App 在鉴权和 E2E 链路就绪后向 Desktop Agent 拉取。

## 本地存储

Desktop Agent 本地 SQLite 建议新增或复用以下逻辑表：

```text
agent_probe_events
agent_app_messages
agent_message_deliveries
agent_notification_settings
```

`agent_probe_events` 保存 Probe 原始归一化事件，供审计和问题定位使用。

`agent_app_messages` 保存过滤后可给 App 展示的消息。

`agent_message_deliveries` 保存不同 App 连接的投递状态。

`agent_notification_settings` 保存用户对 provider、session、message kind 的通知偏好。

## 阶段执行约束

| 阶段 | 范围 | 必须完成 | 不做 |
|---|---|---|---|
| MVP | Codex Hooks Channel + PTY/tmux 粗粒度 Probe | `AgentProbeEvent`、Sink、基础 Filter、在线 App 内消息、Codex hook receiver | 系统 Push、复杂 NLP 解析、跨设备云端 Inbox、完整 app-server UI |
| Beta | Codex App Server Channel + Claude Code hook | 本地 pending inbox、重连补发、审批/输入等待通知、Codex app-server 事件映射 | Relay 解析业务、App 直接消费 Probe Event |
| 企业版 | 多 provider Probe 体系 | 系统 Push、通知偏好、审计检索、频控配置 | 把 Agent 私有协议写进 App 页面 |

## 安全约束

- Probe 只能读取 Desktop Agent 已授权管理的 session、workspace 和进程。
- Probe Event 进入 App 前必须经过 Filter。
- 系统 Push 不携带完整 diff、文件内容、命令输出或敏感路径。
- Relay 不解析 `agent.message` 明文，业务消息继续封装在 App-Agent E2E 内层协议中。
- App 侧打开消息详情时必须重新校验 device、session、workspace 权限。
- Codex hook receiver 只允许本机访问，且必须校验 Desktop Agent 当前实例 token。
- Codex app-server 不能直接暴露给 App、Relay 或公司网络。

## 最终判断

Agent 消息推送能力应放在 Desktop Agent 内部完成：专属 Probe 负责感知，Probe Sink 负责统一接收，Message Filter 负责决定哪些内容可以打扰用户，Delivery Layer 负责把标准化消息发给不同端。

这个设计保留 Codex、Claude Code 等 coding agent 的差异化 hook 能力，同时避免 App、Relay 或统一消息层被具体 Agent 的私有协议污染。

## 参考来源

- [OpenAI Codex app-server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex hooks](https://developers.openai.com/codex/hooks)
- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference)
