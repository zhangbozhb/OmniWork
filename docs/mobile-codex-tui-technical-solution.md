# 手机端 Codex TUI 工作台技术方案

调研时间：2026-05-11（美国时间）/ 2026-05-12（工作区时区 Asia/Shanghai）

关联设计文档：[mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)

关联工程要求：[engineering-requirements.md](./engineering-requirements.md)

关联鉴权设计：[auth-key-design.md](./auth-key-design.md)

关联内网穿透方案：[relay-architecture.md](./relay-architecture.md)（终版架构）；[archive/intranet-tunnel-technical-solution-v1.md](./archive/intranet-tunnel-technical-solution-v1.md)（已弃用，仅作历史参考）

## 当前实装状态（2026-05-22）

- 主通道（Codex app-server runtime adapter）：已落地基础适配层，见 [mac/agent/src/runtime/](../mac/agent/src/runtime/)；provider 配置驱动 + `session.list` 下发已对齐。
- 兼容通道（tmux + node-pty 原生终端快照）：已落地，见 [mac/agent/src/pty-bridge](../mac/agent/src/pty-bridge) 与 [mac/agent/src/tmux-manager](../mac/agent/src/tmux-manager)。
- Agent Provider 元数据层：`packages/protocol-ts` 定义 + Mac Agent 配置化 provider 已实现。
- Workspace 只读上下文层：已实现 `workspace.list/status` + `files.list/read` + `git.status/diff`，详见 [mac/agent/src/workspace](../mac/agent/src/workspace) / [files](../mac/agent/src/files) / [git](../mac/agent/src/git)。
- Relay + P2P 升级：已落地（终版见 [relay-architecture.md](./relay-architecture.md)），不在本文档继续维护。

## 结论摘要

推荐采用「公司内网中继 + TypeScript Mac 本地 Agent + Agent Provider 运行时适配层 + Android/iOS/Web 跨端 App」的方案。

与初始设计相比，最新技术调研后需要补充一个重要判断：

- OpenAI Codex 已经提供官方的 `codex app-server` 和 `--remote` 能力，可以用 JSON-RPC 和 WebSocket 驱动更结构化的 Codex 客户端。
- 但 Codex app-server 的 WebSocket 传输目前仍标注为 experimental / unsupported，且官方明确提醒非 loopback WebSocket 监听在 rollout 阶段默认不应直接远程暴露，必须配置认证。
- 因此，正式企业方案不应把 Codex app-server 直接暴露给手机或中继，而应由 Mac Agent 在本机 loopback / unix socket / stdio 内部管理，再通过我们自己的企业中继协议对外提供受控能力。

最终推荐是双通道架构，同时保留 Agent Provider 抽象，避免把 Codex、Claude、Gemini、OpenCode 等 CLI 能力写死在 App 页面或 Mac Agent 会话管理逻辑中：

1. **主通道：Codex App Server 结构化通道**
   - 面向长期产品体验。
   - 用于会话、线程、审批、流式事件、历史记录、状态摘要。
   - 手机端可以做移动友好的 Codex UI，而不必完整复刻桌面 TUI。

2. **兼容通道：tmux + PTY + React Native 原生终端快照通道**
   - 面向最小闭环和兼容性。
   - 用于真实显示 Codex CLI TUI。
   - 可满足「手机查看 TUI 结果并交互、多个 TUI 切换」的 MVP 诉求。

3. **Agent Provider 元数据层**
   - `packages/protocol-ts` 定义 `AgentProviderDefinition`、`runtime_kind`、能力标识等共享协议类型，并提供默认 presets 作为 fallback。
   - Mac Agent 通过 `OMNIWORK_AGENT_PROVIDERS` 配置实际启用的 provider、展示名、能力标识和命令，例如用户可直接增加 `opencode`。
   - Mac Agent 的 Runtime Adapter 从配置化 provider 列表创建 runtime，并通过 `agent.hello` / `session.list` 下发给 App。
   - App 会话列表按 Mac Agent 下发的 provider 分组展示，并在创建会话时传递 `runtime_kind`。
   - 未识别的外部 tmux 会话归入 `other`，只展示和附加，不作为可创建 provider。

4. **Workspace 只读上下文层**
   - Workspace 是远端项目目录，不是 Agent 端静态配置；Mac Agent 从 managed session 和 external tmux session 的 cwd 自主发现 workspace。
   - 如果 session cwd 位于 Git 仓库内，workspace path 提升为 Git root；否则使用 cwd 本身。workspace path 是稳定标识，展示名为空时使用路径最后一级目录。
   - `session.list` 下发 workspace 元数据，App 以 Workspace 作为一级项目对象；Workspace Detail 使用底部 Tab 展示 `Sessions` / `Git` / `Files`。
   - `Sessions` Tab 按 provider 分组，例如 OmniWork workspace 内展示 Codex、Claude、OpenCode 各自相关的 session。
   - `Files` Tab 仅允许只读浏览 workspace 边界内的文件，禁止通过相对路径越界。
   - `Git` Tab 仅当目标 workspace 是 Git 仓库时显示，能力限制为只读 `status` / `diff`，不提供 stage、commit、reset、push 等写操作。

MVP 可以先做兼容通道，随后引入主通道。正式企业版建议两者并存：默认使用结构化通道，必要时切换到原始 TUI。

## 工程技术栈要求

已确认的工程要求：

- Mac 端采用 TypeScript / Node.js 技术栈。
- Mac Agent 的业务主体不采用 Rust/Swift 重写。
- 如需 macOS 原生能力，只允许做极薄平台桥接，例如 Keychain、LaunchAgent、签名公证和可选 Menu Bar shell。
- App 采用 React Native 技术栈，同时适配 Android、iOS 和 Web SPA。
- 手机端推荐采用 React Native CLI + TypeScript。
- 原始 TUI 快照通过 React Native 原生组件渲染；完整 ANSI renderer 作为后续可替换能力。
- 结构化 Codex UI 使用 React Native 原生组件实现。
- App 和 Mac Agent 共享 TypeScript 协议类型和纯逻辑 SDK。
- 当前登录鉴权不接入 SSO；Mac Agent 每次启动生成 32 字符临时 key，保存到本地文件，App 使用该 key 完成本次连接授权。
- App 移动端交付 Android APK 和 iOS IPA 安装包；Web 端以 `react-native-web` 输出静态 SPA，不作为 PWA 或扫码入口。

这意味着此前「手机 PWA 优先」和「Mac 企业版迁移 Rust/Swift」不再作为主路线。App 继续以 React Native 为唯一 UI 技术栈，移动端按 APK/IPA 交付，Web 端只作为同代码库 SPA 目标；Rust/Swift 只作为 Relay 可选实现或极薄 macOS 原生桥接。

## 技术调研要点

### Codex 官方能力

Codex CLI 当前不仅支持传统交互式 TUI，也支持 app-server 协议。官方文档说明：

- Codex CLI 是运行在本地终端的 coding agent，可以读取、修改并运行本机目录中的代码。
- Codex app-server 是官方用于 VS Code extension、桌面 App 等 rich client 的接口。
- app-server 使用类似 MCP 的 JSON-RPC 2.0 双向通信，支持 stdio、WebSocket、off 等监听模式。
- WebSocket 模式中，一个 JSON-RPC 消息对应一个 WebSocket text frame。
- app-server 可暴露 `/readyz` 和 `/healthz` 健康检查。
- `codex --remote ws://...` 可以让交互式 TUI 连接远端 app-server。

关键限制：

- app-server WebSocket 传输仍是 experimental / unsupported。
- 非 loopback WebSocket 监听目前不应直接远程暴露。
- 暴露 WebSocket 时需要配置 capability token 或 signed bearer token。
- app-server 使用 bounded queues；客户端需要处理 overloaded / retry。

技术判断：

- 直接把 app-server 暴露给手机不合适。
- Mac Agent 应作为 app-server 的本地守护和安全边界。
- 公司中继只面对 Mac Agent 和手机，不直接面对裸 Codex app-server。

### Web SPA 与浏览器终端技术

`@xterm/xterm` 当前稳定包是 6.0.0，是成熟的浏览器端终端组件。不过在本项目当前 App 目标下，MVP 不引入独立浏览器终端组件，避免形成第二套 UI 和输入模型。Web SPA 通过 `react-native-web` 复用现有 React Native 终端快照视图。

技术判断：

- 手机端 MVP 使用 React Native 原生终端快照视图。
- Web 端 MVP 使用同一套 React Native 终端快照视图经 `react-native-web` 渲染。
- Mac Agent 通过 tmux capture/snapshot 提供当前画面。
- App 先做文本归一化、ANSI 控制序列清理、横向/纵向滚动、快捷键输入。
- 如果后续需要完整 ANSI 行为，再以可替换 renderer 引入，不能复制整套 Web 页面。

### PTY 与 tmux

`tmux` 的核心能力是终端复用和会话持久化：session 可以 detach 后继续在后台运行，并在之后 reattach。每个 session 可以包含多个 window / pane，每个 pane 是独立 pseudo terminal。

技术判断：

- Codex TUI 的持久化应交给 `tmux`。
- Mac Agent 不应自己模拟 session 生命周期。
- 每个手机可切换会话对应一个 `tmux` session 或 window。
- Mac Agent 重启后通过 `tmux list-sessions` 重新发现会话。

PTY 实现路线：

- Mac Agent 使用 TypeScript / Node.js。
- `node-pty` 作为 PTY 主实现，和 xterm.js 生态天然匹配。
- 所有 PTY 能力必须封装在 `pty-bridge` 模块后面。
- `tmux` 操作必须封装在 `tmux-manager` 模块后面。
- 如需 native addon，只能作为 Node.js TypeScript Agent 的底层适配层，不承载业务逻辑。

建议：

- Mac Agent 从 MVP 开始就按 TypeScript 生产结构组织，不再单独规划 Rust/Swift 迁移路线。
- 企业部署阶段重点解决 Node runtime 固定、签名、公证、自启动、Keychain、MDM 配置和打包分发。
- macOS 原生桥接保持最薄，不把 Agent 业务逻辑下沉到 Swift/Objective-C。

### WebSocket 与 WebTransport

WebSocket 仍是 MVP 主通信协议。MDN 说明 WebSocket 是浏览器和服务端之间的双向交互通信 API，支持广泛，但标准 WebSocket API 本身没有 backpressure；如果消息到达速度超过应用处理速度，可能导致内存增长或 CPU 占用过高。

WebTransport 是更现代的 HTTP/3 传输能力，支持多 stream、单向 stream、乱序、datagram 和更好的低延迟网络切换；但 W3C 规范在 2026-03-25 仍是 Working Draft，且企业代理、网关、TLS 检查、HTTP/3 支持链路更复杂。

技术判断：

- MVP 使用 WebSocket over TLS。
- 协议层自己实现 seq / ack / flow-control。
- WebTransport 列入第二阶段实验，不进入第一版主链路。

### 跨端移动 App 与通知

- App 第一版建议使用 React Native CLI 作为跨端技术，同时交付 Android、iOS 和 Web SPA。

技术判断：

- Android、iOS 和 Web 共享同一套 TypeScript 业务代码。
- 原始 TUI 页面使用 React Native 原生终端快照视图。
- 结构化 Codex UI 使用 React Native 原生组件实现，避免被 WebView 体验限制。
- 任务完成通知使用 APNs / FCM 或公司统一推送网关。
- 需要明确：手机 App 切后台、锁屏或系统回收后，长连接仍可能暂停，所以 24 小时能力必须依赖 Mac 端会话持久，而不是手机端在线。
- 移动端交付物是 APK / IPA 安装包；Web 交付物是静态 SPA，不提供 PWA 或扫码能力。

### macOS 企业部署

Mac Agent 是公司设备上的本地常驻组件，应优先使用 Apple 官方系统能力：

- macOS 13+ 使用 `SMAppService` 注册和管理 LoginItems、LaunchAgents、LaunchDaemons。
- 当前 MVP 不使用长期认证 token；Agent 每次启动生成临时 key，并以权限受限的本地文件保存。
- 后续如引入长期凭证，再使用 Keychain 保存设备凭证或 relay secret。
- 企业分发需要签名和 notarization。
- 如果公司 MDM 支持，可使用 Managed Device Attestation 参与设备信任判断。

技术判断：

- Mac Agent 不需要 SSH、屏幕录制或辅助功能权限。
- Mac Agent 需要最小文件系统和网络权限。
- Mac Agent 应默认只与公司中继建立出站 TLS 连接。

## 推荐总体架构

```mermaid
flowchart LR
  Phone["Android/iOS 跨端 App"] -->|WSS + key proof| Relay["公司内网 Relay"]
  Relay -->|WSS + agent hello| Agent["Mac Agent"]

  Agent --> Control["控制面"]
  Agent --> Runtime["Agent Provider 运行时适配层"]
  Agent --> Tmux["tmux 会话池"]
  Agent --> Store["本地 SQLite + session-key.json"]

  Runtime --> AppServer["Codex app-server<br/>stdio/unix/127.0.0.1"]
  Runtime --> PTY["PTY bridge"]
  PTY --> Tmux
  Tmux --> ProviderTUI["Configured Agent CLI TUI"]

  AppServer --> CodexHarness["Codex harness"]
```

## 模块拆分

### 手机跨端 App

职责：

- 临时 key 输入 / 扫码配对。
- 设备选择。
- 会话列表。
- 原始 TUI 渲染。
- 结构化 Codex 会话 UI。
- 输入和快捷键。
- 横屏、缩放、复制、粘贴。
- 断线重连。
- APNs / FCM / 公司统一推送订阅。

推荐技术：

- TypeScript。
- React Native CLI。
- React Native 原生终端快照视图。
- WebSocket client。
- 安全存储使用平台安全存储能力。
- 通知使用 APNs / FCM 或公司统一推送网关。

手机端页面：

- `PairingScreen`：输入或扫码 32 字符临时 key。
- `DeviceListScreen`：选择 Mac。
- `SessionListScreen`：会话列表。
- `TerminalScreen`：原始 TUI 快照，React Native 原生终端视图。
- `CodexSessionScreen`：结构化 Codex UI。
- `SettingsScreen`：安全、通知、键盘偏好。

### 公司内网 Relay

职责：

- 手机临时 key proof 校验中继。
- Mac Agent 在线注册。
- App 连接与 Mac Agent 实例匹配。
- 中继手机和 Mac Agent 之间的数据。
- 会话路由。
- 连接状态管理。
- 审计日志。
- 管理员撤销。
- 速率限制和异常保护。

推荐技术：

- Go 或 Rust。
- WebSocket over TLS。
- MVP 不接入 SSO / OIDC。
- App 使用 32 字符临时 key 的 HMAC proof 完成连接授权。
- Mac Agent 使用 `agent.hello` 注册 `device_id`、`agent_instance_id`、`key_id`。
- PostgreSQL 存设备、Agent 实例、审计元数据。
- Redis 用于在线状态、短期路由、分布式锁。
- OpenTelemetry 做 trace / metrics。

不建议：

- 不在 Relay 上保存完整终端内容。
- 不在 Relay 上保存完整 key。
- 不把 Relay 设计成任意命令执行网关。
- 不让手机直接访问 Mac 上的 Codex app-server。

### Mac Agent

职责：

- 与 Relay 建立出站连接。
- 注册设备状态。
- 管理本机 Codex 会话。
- 启动和监督 `codex app-server`。
- 启动和监督 `tmux` / Codex TUI。
- 将本地 PTY / app-server 事件转换为企业中继协议。
- 存储本地会话 registry。
- 每次启动生成 32 字符临时 key。
- 将临时 key 保存到权限受限的本地文件。
- 上报审计事件。

推荐技术路线：

- TypeScript + Node.js LTS。
- PTY：`node-pty`。
- 会话持久：`tmux`。
- 打包：固定 Node runtime 的 macOS 分发包。
- 自启动：`SMAppService` 注册 LaunchAgent。
- 本地存储：SQLite。
- 临时 key 文件：`~/Library/Application Support/OmniWork/agent/session-key.json`。
- 后续长期 secret：Keychain。
- 与 app-server 通信：优先 stdio 或 unix socket；必要时 loopback WebSocket。

工程约束：

- Agent 业务主实现必须在 TypeScript 中。
- macOS 原生代码只做 Keychain、LaunchAgent、签名公证、可选 Menu Bar 等薄桥接。
- `node-pty`、SQLite、Keychain 等 native 依赖必须收敛在独立 adapter 模块内。
- 不依赖用户机器上不受控的全局 Node 版本。

Mac Agent 的本地端口策略：

- 默认不监听 LAN 地址。
- 如果需要本机调试，只监听 `127.0.0.1`。
- 不直接开放 Codex app-server 到公司网络。

### Codex Runtime Adapter

运行时适配层统一屏蔽两种 Codex 访问方式。

#### App Server Adapter

用于结构化能力。

能力：

- `thread/list`
- `thread/start`
- `thread/resume`
- turn events streaming
- approvals
- diffs
- history
- auth endpoints

实现原则：

- app-server 进程只在 Mac 本机内部可达。
- adapter 将 app-server JSON-RPC 事件转换为 Relay protocol。
- 手机端不直接依赖 app-server 原始协议，以降低 Codex 升级风险。
- adapter 负责版本探测和 feature flag。

#### PTY Adapter

用于原始 TUI 能力。

能力：

- 创建 `tmux` session。
- 启动 `codex` TUI。
- attach 到指定 session。
- 推送 terminal frame。
- 写入键盘输入。
- resize。
- snapshot。
- reconnect。

实现原则：

- 每个 TUI 会话固定 `session_id`。
- 后台运行交给 `tmux`。
- WebSocket 慢客户端不能拖垮 PTY 读取，需要缓冲和丢弃策略。
- 对每个会话维护最后 N 秒输出和当前屏幕快照。
- 终端帧由 Mac Agent 主动推送：`mac/agent/src/core/agentService.ts` 为每个 attached session 启动一个 ~450ms 的定时器，对当前 PTY 内容做 SHA-1 哈希，仅当哈希变化时下发 `terminal.frame`，避免无变化空帧；App 不再做 3 秒 idle 全量轮询或输入后多次轮询，进入终端页时只主动拉取一次 `terminal.snapshot` 作为初始画面。

## 协议设计

### 外层连接

手机与 Relay：

```text
wss://relay.company.example/mobile
auth.proof: HMAC_SHA256(session_key, relay_nonce)
```

Mac Agent 与 Relay：

```text
wss://relay.company.example/agent
agent.hello: device_id + agent_instance_id + key_id
```

其中 `session_key` 是 Mac Agent 本次启动生成的 32 字符临时 key。Relay 不应持久化或打印完整 key；推荐由 Relay 发起 nonce，App 计算 proof，Mac Agent 使用本地 key 校验。

### 消息 Envelope

```json
{
  "v": 1,
  "id": "msg_01",
  "type": "terminal.input",
  "device_id": "mac_01",
  "session_id": "sess_01",
  "seq": 42,
  "ts": "2026-05-12T00:00:00Z",
  "payload": {}
}
```

字段说明：

- `v`：协议版本。
- `id`：消息 ID，用于追踪。
- `type`：消息类型。
- `device_id`：目标 Mac。
- `session_id`：目标 Codex session。
- `seq`：有序流序号。
- `ts`：发送时间。
- `payload`：业务负载。

### 主要消息类型

控制面：

```text
auth.challenge
auth.proof
auth.ok
auth.failed
agent.hello
agent.heartbeat
device.list
session.list
session.create
session.rename
session.close
session.attach
session.detach
session.status
session.audit
```

TUI 数据面：

```text
terminal.frame
terminal.input
terminal.resize
terminal.snapshot
terminal.ack
terminal.pause
terminal.resume
terminal.error
```

Codex 结构化面：

```text
codex.thread.list
codex.thread.start
codex.thread.resume
codex.turn.start
codex.turn.event
codex.approval.request
codex.approval.answer
codex.diff.event
codex.error
```

### Backpressure

WebSocket 本身不提供标准 backpressure，因此协议层必须实现：

- terminal frame `seq`。
- 客户端定期发送 `terminal.ack`。
- 每个连接设置最大未确认字节数。
- 超限后进入降级策略：
  - 暂停非关键帧。
  - 合并连续输出。
  - 只保留最新屏幕快照。
  - 向用户显示「连接较慢，已进入快照模式」。

TUI 输出分两类：

- 交互帧：实时推送，尽量低延迟。
- 快照帧：慢连接或重连时发送当前屏幕状态。

## 会话模型

### Relay 侧表

```text
users
devices
device_bindings
agent_connections
mobile_connections
relay_sessions
audit_events
push_subscriptions
```

### Mac Agent 本地表

```text
codex_sessions
tmux_sessions
app_server_instances
terminal_snapshots
agent_settings
```

### 会话状态

```mermaid
stateDiagram-v2
  [*] --> Created
  Created --> Starting
  Starting --> Running
  Running --> Detached
  Detached --> Running
  Running --> Exited
  Detached --> Exited
  Running --> Error
  Detached --> Error
  Error --> Recovering
  Recovering --> Running
  Exited --> Archived
```

状态定义：

- `Created`：元数据已创建。
- `Starting`：正在启动 Codex / tmux / app-server。
- `Running`：会话运行中。
- `Detached`：无人连接但后台运行。
- `Exited`：Codex 进程已退出。
- `Error`：会话异常。
- `Recovering`：Agent 正在重建映射或重连。
- `Archived`：不可交互，仅保留元数据。

## 手机端 TUI 体验方案

第一版推荐：

- React Native 页面中嵌入原生终端快照视图。
- 终端帧先做 ANSI 控制序列清理。
- 横向和纵向滚动由 React Native ScrollView 处理。
- 终端固定逻辑尺寸：`100x32` 或 `120x36`。
- 手机上默认缩放到宽度适配。
- 支持双指缩放。
- 支持横向拖动。
- 横屏时切换到宽终端。
- 底部固定输入栏。
- 快捷键栏提供：
  - `Esc`
  - `Tab`
  - `Ctrl+C`
  - `Ctrl+D`
  - `Ctrl+L`
  - 方向键
  - 回车
  - 复制
  - 粘贴

输入策略：

- 普通文本先进入手机输入栏，点击发送后写入 PTY。
- 快捷键即时发送。
- 支持「粘贴前预览」，避免大段文本误发送。
- iOS 中文 IME 使用 React Native 输入栏承接，提交后再写入 PTY。

安全策略：

- 默认禁用终端程序直接读剪贴板。
- 对 OSC 52 剪贴板写入做确认或禁用。
- 链接点击前展示目标域名。
- 不允许终端输出注入 HTML。

## Codex 结构化 UI 体验方案

长期更适合手机的不是完整 TUI，而是结构化 Codex UI。

建议支持：

- 对话流。
- 当前 turn 状态。
- Codex plan。
- tool call 列表。
- diff 摘要。
- approval 卡片。
- 任务完成通知。
- 多 session 并行状态。
- 快速继续输入。

技术上由 App Server Adapter 提供事件流，手机端渲染移动友好的 UI。

好处：

- 不受终端宽度限制。
- 审批交互更适合手机。
- 可以做通知和摘要。
- 可以更精细地审计操作。

保留 TUI 的原因：

- 兼容用户已有 CLI 使用习惯。
- Codex TUI 新功能可以立即可见。
- 当 app-server 协议变化时，有原始 TUI 兜底。

## 安全方案

### 鉴权

当前 MVP 不接入 SSO / OIDC / 长期设备绑定。

临时 key：

- Mac Agent 每次启动生成一个新的 32 字符随机 key。
- key 使用加密安全随机数生成器。
- key 保存到 `~/Library/Application Support/OmniWork/agent/session-key.json`。
- key 文件权限必须为 `0600`，目录权限必须为 `0700`。
- App 通过手动输入、扫码或后续本机展示方式获得 key。
- Mac Agent 重启后旧 key 失效。

推荐握手：

- Relay 下发 nonce。
- App 使用 key 对 nonce 计算 `HMAC-SHA256` proof。
- Relay 将 proof 转发给 Mac Agent。
- Mac Agent 使用本地 key 校验 proof。
- Relay 不保存完整 key。
- 审计只记录 `key_id`，不记录 key。
- App 收到 `auth.failed` 时立即关闭 relay 连接，并按 [auth-key-design.md](./auth-key-design.md) 的「App 收到 `auth.failed` 后的具体清理动作」清除本地失效 pairing 与会话状态，引导用户重新扫码或输入新的临时 key。

### 授权

授权判断：

```text
device_id + agent_instance_id + key_id + key_proof
```

默认策略：

- 拥有本次临时 key 的 App 才能连接对应 Mac Agent。
- 同一 Mac Agent 重启后必须重新配对。
- 默认不支持跨用户共享或长期授权。
- key 连续校验失败需要限流。

### 审计

默认记录元数据：

- key 配对成功 / 失败。
- 连接 / 断开。
- 会话创建 / 关闭。
- 会话 attach / detach。
- approval allow / deny。
- Agent 版本。
- Codex 版本。
- `key_id`。
- 来源 IP / 网络区域。

终端内容审计：

- 默认不记录完整 TUI 输出。
- 可按公司安全要求开启敏感操作抽样或完整记录。
- 如果开启完整记录，需要明确数据保留期限和访问权限。

### 进程边界

Mac Agent 只允许：

- 启动 `codex`。
- 启动 `codex app-server`。
- 启动和管理白名单 `tmux` session。

Mac Agent 不允许：

- 任意远程 shell。
- 任意命令执行 API。
- 读取屏幕。
- 控制鼠标。
- 监听全局键盘。
- 绕过 MDM、代理、VPN 或防火墙。

## 技术选型表

| 领域 | 推荐 | 备选 | 不推荐作为主线 |
| --- | --- | --- | --- |
| 手机端 | React Native CLI + TypeScript，产出 APK/IPA | Flutter | 只做 PWA 或网页作为主交付 |
| 原始终端 | React Native 原生终端快照视图 | 可替换原生 terminal renderer | Android/iOS 分别自研终端渲染器 |
| TUI 持久化 | tmux | screen / zellij | Agent 自己模拟持久终端 |
| Codex 结构化集成 | Codex app-server adapter | Codex SDK 用于非交互任务 | 直接暴露 app-server 给手机 |
| Mac Agent | TypeScript + Node.js LTS + node-pty | 极薄 native addon | Rust/Swift 承载 Agent 业务 |
| 中继 | Go / Rust WebSocket Relay | Node.js Relay | 通用远控网关 |
| 认证 | 32 字符临时 key + HMAC challenge | 后续 SSO / OIDC | 静态长期共享密码 |
| Agent 设备认证 | agent.hello + key_id + proof 校验 | 后续 mTLS / signed bearer | 无认证 WebSocket |
| key 存储 | `session-key.json`，0600 权限 | 后续 Keychain 存长期凭证 | 仓库内明文配置 |
| 通知 | APNs / FCM / 公司统一推送 | 公司内部调试通道 | WebSocket 长久在线 |

## 现有项目参考

### Remodex

Remodex 是一个开源的 Codex 远程控制参考项目，包含 Mac 本地 bridge 和 iOS App，主打 local-first、iPhone 控制 Mac 上的 Codex、配对、安全会话、通知、运行流式展示等能力。

可借鉴：

- 手机控制 Codex 的产品交互。
- 一次性 QR 配对。
- Mac bridge。
- 通知和长任务反馈。
- local-first 思路。

不建议直接采用为企业方案的原因：

- 公司网络、SSO、MDM、审计、设备绑定策略通常需要深度定制。
- 当前目标是公司内网中继和合规边界，不是个人自托管体验。
- 需要适配受控 Mac、不可 SSH、不可屏幕共享的企业约束。

### ttyd / Wetty / Guacamole / code-server

这些项目证明了浏览器终端和远程开发工作台的成熟度：

- `ttyd`：轻量 web terminal。
- `Wetty`：xterm.js + WebSocket 的 web terminal。
- Apache Guacamole：更偏通用远程桌面 / SSH / RDP / VNC 网关。
- code-server：完整 VS Code 浏览器化。

技术判断：

- 可以参考实现，但不建议直接作为主产品核心。
- 我们需要的是 Codex 专用、企业受控、会话可审计、非通用远控的窄能力系统。

## MVP 实施路线

### 阶段 0：环境确认

确认：

- 公司手机能访问内网 Relay。
- Mac Agent 能出站连接 Relay。
- MDM 允许用户态常驻 Agent。
- 允许安装或内置 `tmux`。
- 允许运行 Codex CLI。
- 当前不接入 SSO，确认临时 key 文件和手动配对流程可以接受。

产出：

- 网络连通性报告。
- MDM 权限清单。
- 安全白名单需求。

### 阶段 1：本机 TUI POC

目标：

- 在 Mac 上用 Agent 启动 `tmux + codex`。
- 本机开发界面或 App 原生终端快照视图查看和输入。
- 支持创建、切换 3 个会话。

建议技术：

- TypeScript + Node.js + `node-pty`。
- `tmux`。
- React Native 原生终端快照视图。

验收：

- 手机暂不接入。
- 本机开发界面或 App 原生终端快照视图可查看 Codex TUI 快照并发送输入。
- Agent 退出后 `tmux` session 仍在。
- Agent 重启后可恢复 session 列表。

### 阶段 2：Relay POC

目标：

- Mac Agent 主动连 Relay。
- Android/iOS App 通过 Relay 连 Mac Agent。
- 完成 32 字符临时 key 配对的最小实现。

验收：

- 手机可看到会话列表。
- 手机可进入 TUI。
- 手机可输入文字、回车、方向键、`Esc`、`Tab`、`Ctrl+C`。
- 手机断网后 Mac 会话继续。
- 手机重连后恢复屏幕。

### 阶段 3：企业安全加固

目标：

- 加固临时 key 生成、文件权限、失败限流和审计。
- Relay 不保存完整 key。
- Agent 由 `SMAppService` / LaunchAgent 管理。

验收：

- 未授权用户不能访问设备。
- 错误 key 不能访问设备。
- Mac Agent 重启后旧 key 失效。
- 审计事件完整。
- Agent 可随用户登录自动启动。

### 阶段 4：Codex App Server Adapter

目标：

- Mac Agent 内部启动 `codex app-server`。
- Adapter 与 app-server 用 stdio / unix socket / loopback 建立连接。
- 手机端增加结构化 Codex UI。

验收：

- 可以启动 / 恢复 Codex thread。
- 可以展示流式事件。
- 可以处理 approval。
- 可以查看 diff 摘要。
- TUI 通道仍可作为 fallback。

### 阶段 5：移动体验与通知

目标：

- 横屏优化。
- 终端缩放。
- APNs / FCM / 公司统一推送通知。
- 任务完成提醒。
- 会话摘要。

验收：

- iOS App 可收到任务完成通知。
- Android App 可收到任务完成通知。
- 切后台后重开能恢复状态。

## 关键技术风险与规避

### Codex app-server 协议仍在演进

风险：

- app-server WebSocket 标注 experimental / unsupported。
- 协议升级可能带来兼容问题。

规避：

- 不让手机直接依赖 app-server 原始协议。
- Mac Agent 实现 Adapter。
- Adapter 做版本探测和 feature flag。
- 保留 tmux + PTY 通道兜底。

### WebSocket 慢连接导致积压

风险：

- 手机网络切换、弱网、切后台会导致输出积压。
- 标准 WebSocket 没有应用级 backpressure。

规避：

- seq / ack。
- 限制未确认字节。
- 快照模式。
- 慢连接丢弃非关键中间帧。

### 移动 App 后台能力有限

风险：

- 锁屏、切后台或系统回收后，WebSocket 可能暂停或被断开。

规避：

- 24 小时能力放在 Mac 端。
- 手机重连后恢复快照。
- 任务完成使用 APNs / FCM / 公司统一推送网关。

### 企业网络和 MDM 策略

风险：

- 出站 WebSocket 被代理中断。
- HTTP/3 / WebTransport 被拦截。
- LaunchAgent 或自启动受限。

规避：

- 第一版只要求 WSS over 443。
- WebTransport 不作为 MVP。
- 提前和 IT / 安全团队确认 Agent 分发、签名、证书、代理策略。

### TUI 手机体验

风险：

- Codex TUI 在窄屏下信息密度低。
- 手机输入特殊键不自然。

规避：

- 固定逻辑终端宽度。
- 横屏优先。
- 快捷键栏。
- 结构化 UI 作为长期主体验。

## 最小可行技术栈

如果目标是最快做出企业内可演示版本：

```text
Phone:
  React Native CLI
  TypeScript
  React Native native terminal snapshot view
  WebSocket
  APNs / FCM or company push gateway

Relay:
  Go
  WSS
  32-char key challenge relay
  PostgreSQL
  Redis 可选

Mac Agent:
  TypeScript + Node.js LTS
  node-pty
  tmux
  SQLite
  session-key.json
  Packaged Node runtime

Runtime:
  codex CLI
  tmux session per Codex TUI
```

如果目标是企业正式上线：

```text
Phone:
  React Native CLI native projects
  TypeScript
  React Native native terminal snapshot view for fallback TUI
  React Native structured Codex UI for main workflow
  APNs / FCM / company push gateway

Relay:
  Go or Rust
  WSS over 443
  key proof relay for MVP auth
  PostgreSQL + Redis
  OpenTelemetry

Mac Agent:
  TypeScript + Node.js LTS
  Packaged and signed macOS distribution
  Thin native adapters only where needed
  SMAppService / LaunchAgent
  session-key.json for temporary key
  Keychain only for future long-lived secrets
  SQLite
  tmux
  Codex app-server adapter
  PTY adapter
```

## 推荐最终方案

短期：

- 用 `tmux + PTY + React Native 原生终端快照视图 + WebSocket Relay` 做出真实手机操作 Codex TUI 的 MVP。
- 重点验证网络、输入、重连、多会话和企业安全边界。

中期：

- 引入 Codex app-server adapter。
- 手机端新增结构化 Codex UI。
- TUI 通道保留为 fallback。

长期：

- Mac Agent 企业化：TypeScript/Node.js 固定运行时、签名公证、Keychain、SMAppService、MDM 集成。
- Relay 企业化：临时 key 校验、失败限流、审计、可观测性；SSO/设备绑定只作为后续可选演进。
- 移动体验企业化：通知、摘要、审批卡片、任务状态。

一句话技术方案：

> 用公司内网 Relay 打通 Android/iOS APK/IPA App 与 TypeScript Mac Agent；Mac Agent 在本机安全地管理 Codex app-server 与 tmux/PTY；移动 App 用结构化 Codex UI 作为长期主体验，用 React Native 原生终端快照视图作为 MVP 和兼容通道。

## 调研来源

- [OpenAI Codex CLI](https://developers.openai.com/codex/cli)
- [OpenAI Codex CLI Reference](https://developers.openai.com/codex/cli/reference)
- [OpenAI Codex CLI Features](https://developers.openai.com/codex/cli/features)
- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex App Server Engineering Blog](https://openai.com/index/unlocking-the-codex-harness/)
- [openai/codex app-server source](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [node-pty](https://github.com/microsoft/node-pty)
- [tmux manual](https://www.man7.org/linux/man-pages/man1/tmux.1.html)
- [MDN WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [MDN WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
- [W3C WebTransport Working Draft](https://www.w3.org/TR/webtransport/)
- [Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple Notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple Managed Device Attestation](https://developer.apple.com/documentation/devicemanagement/validating-a-managed-device-attestation-attestation)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [Remodex](https://github.com/Emanuele-web04/remodex)
- [ttyd](https://github.com/tsl0922/ttyd)
- [Wetty](https://github.com/butlerx/wetty)
- [Apache Guacamole](https://guacamole.apache.org/doc/gug/)
- [code-server](https://coder.com/docs/code-server)
