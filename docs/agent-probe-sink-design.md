# Agent Probe Sink 消息感知与推送设计

关联技术方案：[mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)

## 结论摘要

对 Codex、Claude Code、Trae、Trae-CN、OpenCode、Gemini CLI 这类 coding agent，不采用外部 Agent 直接推送到 App 的模型，也不把不同 Agent 的私有事件协议暴露给 App。

最终采用「专属 Agent Probe + Hook 感知 + Desktop Agent 内部 Probe Sink + 本机消息过滤 + 多端投递」架构：

```text
Codex / Claude Code / Trae / Trae-CN / OpenCode / Gemini CLI
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
- 已落地：桌面端 Agent 内部 `AgentMessageService`，支持 Probe Event 幂等去重、基础过滤和在线 App 广播。目标模型下 Desktop Agent 不维护多 App 一致的消息状态；消息列表、已读和处理状态由各 App 本地 SQLite 自维护，Desktop Agent 只关心消息是否送达任一 App。
- 已落地：Codex / Claude Code / Trae / Trae-CN Hooks Channel 的本机 HTTP receiver，默认监听 `127.0.0.1:17669/api/probes/hooks`，通过 `Authorization: Bearer <token>` 校验，并按 `omniwork_hook_source` 分发到对应 Probe。
- 已落地：`desktop/agent/bin/omniwork-agent-hook.mjs`，用于 Codex / Claude Code / Trae / Trae-CN command hook 将 stdin JSON 转交给本机 receiver。
- 已落地：Codex hooks 自动安装。Desktop Agent 启动生成 session key 后会立即检测并合并写入 `~/.codex/hooks.json`，该步骤发生在 admin server / hook receiver 监听端口之前；启动 Codex runtime 前也会二次校验。不会覆盖用户已有 hooks；安装失败只记录 warning，不阻断 Desktop Agent 或 Codex 会话启动。
- 已落地：Claude Code hooks 自动安装。Desktop Agent 启动生成 session key 后会检测并合并写入 `~/.claude/settings.json`；启动 Claude runtime 前也会二次校验。不会覆盖用户已有 hooks；安装失败只记录 warning，不阻断 Desktop Agent 或 Claude 会话启动。当前支持 `claude-code` 与 `claudecode` 输入别名，内部统一归一化为 `claude-code` provider。
- 已落地：Trae / Trae-CN hook payload normalizer 和本机 HTTP ingest provider 解析，支持 `/api/probes/trae/hooks`、`/api/probes/trae-cn/hooks` 以及共享 `/api/probes/hooks?source=...`。根据本机 `~/.trae/traecli.toml`、`~/.trae/traecli.yaml`、`~/.trae/hooks.json` 和 `~/.trae-cn/hooks.json` 调研，当前只接入 hook 事件语义；不自动改写 `~/.trae*` 配置，不把 Trae / Trae-CN 升级为完整 AgentSurface 主交互协议。
- 已落地：Codex app-server event normalizer 和本机 HTTP ingest endpoint（`/api/probes/codex/app-server`），可把 thread / turn / approval / diff / completion 等结构化事件归一化为 `AgentProbeEvent`。当前尚未接入 app-server 进程管理和主动订阅。
- 已落地：tmux Probe 的最小事件路径，tmux target 消失时会产生 `agent.exited` 并进入消息流。
- 已落地：通知偏好持久化协议、App 设置页开关、服务端通知资格判断和脱敏系统通知 payload 生成。当前仅形成可接入 Push gateway 的候选通知，尚未接入平台原生 Push。
- 已落地：App 端 `agent.message` 的基础在线呈现、本地消息 Inbox、已读、已处理、未读 badge、消息跳转和 `agent.message.delivered` 送达回执。Native 端使用 `react-native-quick-sqlite` 保存消息；Web 端使用同接口本地 fallback。
- 尚未落地：Codex app-server 进程管理和主动订阅、完整 PTY 输出解析、平台原生系统 Push。

## 术语定义

| 中文术语 | 英文术语 | 定义 |
|---|---|---|
| 编码 Agent | Coding Agent | Codex、Claude Code、Trae、Trae-CN、OpenCode、Gemini CLI 等运行在电脑本地的 CLI / TUI / app-server 编码工具。 |
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

当前阶段不要求用户配置消息归属，也不向终端启动命令注入可见的 session/surface 环境变量。Hook payload 进入 Desktop Agent 后，由接收端根据现有 session、workspace path 和 provider 自动补齐 `AgentProbeEvent.surface_id` 与 `AgentAppMessage.surface_id`。App 默认查看全部消息；只有在点击消息跳转、或按 workspace/session/surface 自动分组时才使用这些内部字段。

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

## App 消息呈现与操作设计

### 目标

App 端只消费 Desktop Agent 过滤后的 `AgentAppMessage`，不直接理解 Codex、Claude Code、Trae 或其他 Probe 的私有 hook payload。消息体验分三层：

| 层级 | 产品形态 | 触发来源 | 目标 |
|---|---|---|---|
| 即时提示 | 顶部 banner / toast | 在线收到 `agent.message` | 让用户及时感知审批、失败、等待输入、完成等高价值事件。 |
| 消息中心 | Inbox 列表 | App 本地 SQLite | 让用户回看本端已收到的未处理和历史 Agent 消息。 |
| 上下文操作 | 消息详情 / 快捷操作 | `AgentAppMessage.action` | 跳转到对应 session、surface、workspace、diff 或审批位置。 |

非目标：

- 不在 App 端还原 Probe 原始事件流。
- 不在 App 端做复杂过滤策略；App 只尊重用户偏好和消息状态。
- 不追求多个 App 端之间的消息列表、已读和处理状态一致。
- 不由 Desktop Agent 提供 authoritative inbox；Desktop Agent 只关心消息是否至少送达一个 App。
- 不把系统 Push 当成首期前提；首期先完成在线 App 内消息闭环。

### 信息架构

App 增加一个统一的 `Agent Messages` 模块：

```text
app/src/features/agent/
  agentMessages.ts
    - agentMessageDeliveredRequest
    - getAgentNotificationSettingsRequest
    - setAgentNotificationSettingsRequest
  agentMessageStore.ts
    - SQLite inbox persistence
    - local read / handled state
    - unread count query

app/src/screens/messages/
  AgentMessageInboxScreen.tsx
  AgentMessageBanner
```

导航入口：

- 底部 Tab 或设置页入口新增“消息”，显示未读 badge。
- 会话页和终端页内可显示轻量 banner，不强制打断当前操作。
- 点击消息后优先跳转到对应 session/surface；如果上下文不存在，则打开消息详情。

### 消息状态模型

App 端状态由本端 SQLite 维护。每个 App 只保证自己的消息状态正确，不需要与其他 App 同步。

| 状态 | 来源字段 | App 呈现 |
|---|---|---|
| unread | 本地 `read_at` 为空 | Inbox 高亮、badge 计数。 |
| read | 本地 `read_at` 有值 | Inbox 普通样式。 |
| pending action | `message.action` 存在且本地 `handled_at` 为空 | 显示主操作按钮。 |
| handled | 本地 `handled_at` 有值 | 操作按钮降级为已处理状态。 |
| stale | 目标 session/surface 不存在 | 允许查看详情，不再显示跳转主操作。 |

App 收到 `agent.message` 后必须先写入 SQLite；写入成功后再向 Desktop Agent 发送 delivery receipt。Desktop Agent 收到任一 App 的 delivery receipt 后，即可认为该消息已送达，不再关心其他 App 是否收到或展示。

App 本地 SQLite 建议表：

```text
agent_messages
  message_id TEXT PRIMARY KEY
  payload_json TEXT NOT NULL
  provider TEXT
  event_type TEXT
  priority TEXT
  workspace_id TEXT
  session_id TEXT
  surface_id TEXT
  created_at TEXT NOT NULL
  received_at TEXT NOT NULL
  read_at TEXT
  handled_at TEXT
  dismissed_at TEXT
```

索引：

```text
idx_agent_messages_created_at
idx_agent_messages_read_at
idx_agent_messages_handled_at
idx_agent_messages_session_id
```

### 在线消息呈现

App 收到 `agent.message` 时：

1. 按 `message_id` 幂等写入本地 SQLite。
2. SQLite 写入成功后发送 `agent.message.delivered`，携带 `message_id` 和本端 `app_connection_id`。
3. 将消息合并进内存 inbox state。
4. 如果当前页面正是该消息对应 session/surface，只显示低干扰 inline hint。
5. 如果是 `approval_required`、`waiting_user_input`、`failed`，显示顶部 banner。
6. 如果是 `completed`，只在用户不在该 session 页面时显示短 toast。
7. 如果用户关闭了 Agent 通知开关，不显示 banner/toast，但仍写入 Inbox。

推荐 banner 文案结构：

```text
[Provider] [Workspace/session short title]
消息摘要
主操作：查看 / 处理
次操作：稍后
```

优先级规则：

| `AgentAppMessage.priority` | 呈现方式 |
|---|---|
| `high` / `critical` | banner，直到用户关闭或进入目标页。 |
| `normal` | toast，自动消失并保留 Inbox。 |
| `low` | 只进入 Inbox，不主动打扰。 |

### Inbox 列表

首期 Inbox 使用时间倒序列表，分组不超过两层：

- 未处理：未读或本地未 handled 的 actionable message。
- 最近消息：其他消息，按时间倒序。

每条消息显示：

- provider display name，例如 Codex、Claude Code、Trae。
- severity / priority 视觉标记。
- summary。
- workspace 或 session 短名称。
- 相对时间。
- unread dot。
- action 状态，例如“待处理”“已读”“已处理”。

列表交互：

- 下拉刷新读取本地 SQLite；不向 Desktop Agent 拉取 authoritative inbox。
- 点击列表项先更新本地 `read_at`，再打开详情或跳转。
- 长按或右滑可执行“标为已读”；移动端不要把 handled 放在隐藏手势里，handled 必须有明确按钮。

React Native 实现约束：

- Inbox 使用 `FlatList`，消息项组件 `React.memo`。
- `renderItem` 保持稳定引用，避免高频 `agent.message` 导致列表重渲染。
- 空态要区分“没有消息”和“无法连接 Desktop Agent”。
- 错误提示必须可被辅助功能读出，不能只用颜色提示。

### 消息详情与操作

消息详情负责展示完整 summary、source、workspace、session、时间和可执行操作。首期不展示未脱敏的 raw payload。

操作映射：

| `message.action` | App 主操作 | 协议动作 |
|---|---|---|
| `open_session` | 打开会话 | 切换到 session/surface 页面，然后更新本地 `handled_at`。 |
| `open_surface` | 打开 Agent/Terminal surface | 切换到对应 surface，然后更新本地 `handled_at`。 |
| `open_workspace` | 打开工作区 | 切换到 workspace 页面，然后更新本地 `handled_at`。 |
| `review_diff` | 查看 diff | 打开 Git diff / 文件 diff 页面，然后更新本地 `handled_at`。 |
| `approve` | 进入审批处理页 | 首期先跳转到对应 Terminal/Agent surface，不直接替用户审批。 |
| `none` 或缺失 | 仅查看 | 只更新本地 `read_at`。 |

本地 `handled_at` 表示用户已经处理或明确忽略该消息，不等价于 Agent 审批同意。审批同意必须走对应 AgentSurface 或 TerminalSurface 的原有交互路径。

### 协议接入

App 端需要补齐以下请求封装：

```ts
agent.message.delivered
```

消息处理主循环需要补齐：

```text
case "agent.message":
  persist to local SQLite
  send agent.message.delivered after successful persist
  merge in-memory inbox state
  maybe show banner/toast
```

连接成功后，App 应按顺序请求：

1. `agent.notification.settings.get`
2. 从本地 SQLite 恢复未读和未处理消息
3. 现有 session/workspace 初始化请求

这样可以在用户刚打开 App 时先恢复本端未处理消息，再恢复其他工作台状态。

### 通知偏好

设置页现有 `Agent 通知` 开关保留，但语义调整为“是否显示 App 内即时提示 / 未来系统通知”。关闭后：

- Desktop Agent 仍可生成并投递 `agent.message`。
- App 仍写入本地 SQLite，但不显示 banner/toast。
- 后续接入 APNs / FCM 时不触发系统 Push。
- Inbox 入口和未读状态仍可见。

后续可扩展为：

- 仅审批和等待输入。
- 审批、失败和完成。
- 全部重要消息。
- 静默模式时间段。

首期不做多级设置，避免过早复杂化。

### 系统 Push 边界

平台原生 Push 是第二阶段：

```text
AgentMessageService
  ↓ notification candidate
Push Gateway / APNs / FCM
  ↓
App foreground/background notification
```

App 内消息 UI 不依赖系统 Push。系统 Push 到达后只作为唤醒和入口；点击后优先打开本地 SQLite 中的消息。若本端没有该消息，说明消息可能已送达其他 App 或尚未送达本端，App 只展示轻量提示，不向 Desktop Agent 拉取跨端 authoritative inbox。

### 验收标准

首期 App 端完成后应满足：

- 在线收到 `agent.message` 后，App 能展示 banner/toast 或写入 Inbox。
- Inbox 能从本地 SQLite 展示、刷新、标为已读和标为已处理。
- 点击 actionable message 能跳转到 session/surface/workspace/diff 的可用目标。
- `agent.message.delivered` 仅在本地 SQLite 写入成功后发送；Desktop Agent 收到任一 App 的送达回执后认为该消息已送达。
- 关闭 Agent 通知后不再显示即时提示，但 Inbox 仍保留消息。
- App 重连后能通过本地 SQLite 恢复本端未读和未处理消息。

## 职责边界

### Agent Probe

每个 coding agent 单独实现自己的 Probe：

```text
CodexProbe
ClaudeCodeProbe
TraeProbe
TraeCnProbe
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

自动安装的 hook 事件覆盖 Claude Code 官方生命周期主干：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`PermissionDenied`、`Notification`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Stop`、`SessionEnd`。这让 Claude Code 先以 Probe Channel 进入阶段 5 的统一 Agent 事件语义；在没有等价 app-server 的情况下，不创建 `AgentSurface` 主交互协议。

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
    "Notification": [
      {
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
| `PermissionDenied` | `agent.failed` | 可进入 App 内消息，可系统 Push |
| `PostToolUse` | `agent.tool_call_finished` | 本地记录，失败时可生成 warning |
| `PostToolUseFailure` | `agent.failed` | 可进入 App 内消息，可系统 Push |
| `Notification` | `agent.waiting_user_input` | 可进入 App 内消息，可系统 Push |
| `PreCompact` | `agent.compaction_started` | 本地记录 |
| `PostCompact` | `agent.compaction_finished` | 本地记录 |
| `SubagentStart` | `agent.subagent_started` | App 内消息可选 |
| `SubagentStop` | `agent.subagent_completed` | App 内消息可选 |
| `Stop` | `agent.completed` | 可进入 App 内消息，系统 Push 可选 |
| `SessionEnd` | `agent.exited` | 本地记录 |

Trae / Trae-CN hook 到 Probe Event 的默认映射与 Claude Code 保持一致，并额外兼容 `traecli.yaml` 中的 snake_case 事件名：

| Trae Hook | AgentProbeEvent | 默认处理 |
|---|---|---|
| `SessionStart` / `session_start` | `agent.started` | 可进入 App 内消息，不系统 Push |
| `UserPromptSubmit` / `user_prompt_submit` | `agent.user_prompt_submitted` | 本地记录，默认不发 App |
| `PreToolUse` / `pre_tool_use` | `agent.tool_call_started` | 本地记录，默认不发 App |
| `PermissionRequest` / `permission_request` | `agent.approval_required` | 可进入 App 内消息，可系统 Push |
| `PermissionDenied` / `permission_denied` | `agent.failed` | 可进入 App 内消息，可系统 Push |
| `PostToolUse` / `post_tool_use` | `agent.tool_call_finished` | 本地记录 |
| `PostToolUseFailure` / `post_tool_use_failure` | `agent.failed` | 可进入 App 内消息，可系统 Push |
| `Notification` / `notification` | `agent.waiting_user_input` | 可进入 App 内消息，可系统 Push |
| `PreCompact` / `pre_compact` | `agent.compaction_started` | 本地记录 |
| `PostCompact` / `post_compact` | `agent.compaction_finished` | 本地记录 |
| `SubagentStart` / `subagent_start` | `agent.subagent_started` | App 内消息可选 |
| `SubagentStop` / `subagent_stop` | `agent.subagent_completed` | App 内消息可选 |
| `Stop` / `stop` | `agent.completed` | 可进入 App 内消息，系统 Push 可选 |
| `SessionEnd` / `session_end` | `agent.exited` | 本地记录 |

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

### Trae / Trae-CN Probe

Trae 与 Trae-CN 当前按 Coding Agent Probe 接入，不按完整 `AgentSurface` 主协议接入。原因是本地 `~/.trae` 与 `~/.trae-cn` 目录只证明了 CLI hook、skills、agents、MCP schema、memory 和 worktree 组织存在，尚未发现可等价 Codex app-server 的 thread / turn / approval / diff 主交互协议。

本机调研到的组织方式：

- `~/.trae/hooks.json` 与 `~/.trae-cn/hooks.json`：均为 `version + hooks` 结构，当前包含 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。
- `~/.trae/traecli.toml`：声明 `features.hooks = true`，并覆盖 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`Notification`、`SessionEnd`、`Stop`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`。
- `~/.trae/traecli.yaml`：使用 snake_case event 名称，例如 `user_prompt_submit`、`post_tool_use_failure`、`permission_request`、`session_end`、`subagent_start`。
- `~/.trae-cn/builtin_skills`、`~/.trae-cn/skills`、`~/.trae/skills`：采用 `SKILL.md + references/scripts/assets` 的能力包组织。
- `~/.trae/agents`：采用 markdown frontmatter `name/description` 加角色、输入、输出约束的 agent 定义。
- `~/.trae-cn/mcps/.../tools/*.json`：按 workspace/session/agent scope 存放 MCP server metadata 与 tool schema。

当前实现支持：

- dedicated endpoints：`/api/probes/trae/hooks`、`/api/probes/trae-cn/hooks`、`/api/probes/trae_cn/hooks`。
- shared endpoint source：`trae`、`traex`、`coco` 归一化为 `trae`；`trae-cn`、`trae_cn`、`traecn` 归一化为 `trae-cn`。
- hook name alias：支持 PascalCase 和 snake_case 两种事件命名。
- session/surface 自动关联：`trae`、`traex`、`coco` 匹配 `trae` terminal provider；`trae-cn`、`trae_cn`、`traecn` 匹配 `trae-cn` terminal provider。

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

Desktop Agent 内部 Router 只做投递，不维护多个 App 之间的消息状态一致性。

```text
存在在线 App：
  通过 App-Agent E2E 内层消息广播 agent.message
  任一 App 将消息写入本地 SQLite 后回传 agent.message.delivered
  Desktop Agent 将该 message_id 标记为 delivered

没有在线 App：
  Desktop Agent 可保留短期未送达队列，或只生成系统 Push candidate
  不为每个 App 维护独立 inbox

App 重连：
  App 从自己的 SQLite 恢复消息状态
  Desktop Agent 不提供跨端 missed messages 同步
```

送达语义：

- `delivered` 是 Desktop Agent 的全局消息状态，不是每个 App 的状态。
- 只要任意一个 App 成功持久化并回传 `agent.message.delivered`，Desktop Agent 即认为该消息已送达。
- 其他 App 是否收到、是否已读、是否处理，均由各自 App 本地 SQLite 负责。
- Desktop Agent 可以对未 delivered 消息做短期重试或超时丢弃；该策略不影响 App 本地状态模型。

系统 Push payload 不承载完整 Agent 内容：

```json
{
  "message_id": "msg_123",
  "title": "Claude Code 等待确认",
  "body": "有一个工具调用需要你处理",
  "action": "open_session"
}
```

完整内容不通过第三方 Push payload 传递。系统 Push 只作为唤醒和入口；首期 App 不依赖系统 Push 来恢复消息正文。

## 本地存储

App 本地 SQLite 必须保存消息正文和本端状态：

```text
agent_messages
agent_message_meta
```

`agent_messages` 保存本端收到的 `AgentAppMessage`、read / handled / dismissed 状态和查询索引。

`agent_message_meta` 保存本端消息设置、最后清理时间、schema version 等轻量元信息。

Desktop Agent 本地只需要保存 Probe 审计、通知设置和全局 delivery 状态：

```text
agent_probe_events
agent_message_delivery_state
agent_notification_settings
```

`agent_probe_events` 保存 Probe 原始归一化事件，供审计和问题定位使用。

`agent_message_delivery_state` 只记录 `message_id` 是否已送达任一 App、首次送达时间、送达的 `app_connection_id` 和重试/过期信息；不记录每个 App 的 read / handled 状态。

`agent_notification_settings` 保存用户的通知开关、最低优先级、muted provider 和 muted message kind。

## 阶段执行约束

| 阶段 | 范围 | 必须完成 | 不做 |
|---|---|---|---|
| MVP | Codex Hooks Channel + PTY/tmux 粗粒度 Probe | `AgentProbeEvent`、Sink、基础 Filter、在线 App 内消息、Codex hook receiver | 系统 Push、复杂 NLP 解析、跨设备云端 Inbox、完整 app-server UI |
| Beta | Codex App Server Channel + Claude Code hook | App 本地 SQLite Inbox、送达回执、审批/输入等待通知、Codex app-server 事件映射 | Relay 解析业务、App 直接消费 Probe Event、多 App 消息状态一致性 |
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
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
