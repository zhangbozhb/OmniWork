# 项目目录结构规划

关联文档：

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [engineering-requirements.md](./engineering-requirements.md)

## 目标

本项目采用 monorepo，把手机端 App、Mac 端 Agent、公司内网 Relay、共享协议和部署材料放在同一个工程下。

目录规划需要满足：

- 手机端代码和 Mac 端代码都在本工程内。
- 各端边界清晰，避免互相直接依赖内部实现。
- 协议契约集中管理，手机、Mac、Relay 只依赖生成物或稳定 SDK。
- 支持先做 MVP，再演进到企业正式部署。
- App 和 Mac Agent 均采用 TypeScript 技术栈。
- App 采用 React Native 技术栈，同时适配 Android、iOS 和 Web SPA；Web 不另起一套 React DOM UI。
- Relay 可独立选择 Go、Rust 或 TypeScript，但必须通过 `protocol/` 与 App/Mac 对齐。
- 不把本项目做成通用远控系统，目录命名也要体现 Codex TUI 工作台的窄能力边界。

## 顶层结构

推荐顶层目录如下：

```text
OmniWork/
|-- app/                     # React Native App，适配 Android / iOS / Web SPA
|-- mac/                     # TypeScript Mac 本地 Agent 与 macOS 集成
|-- relay/                   # 公司内网中继服务
|-- protocol/                # 跨端协议、schema、API 契约
|-- packages/                # TypeScript 共享包
|-- infra/                   # 部署、环境、证书、观测配置
|-- scripts/                 # 本地开发、生成、打包脚本
|-- tests/                   # 跨端集成测试和端到端测试
|-- docs/                    # 设计文档、技术方案、运维说明
|-- tools/                   # 开发工具和一次性辅助工具
|-- fixtures/                # 测试夹具和协议样例
|-- .github/                 # CI/CD，若使用 GitHub
|-- AGENTS.md                # Agent 工作约束，若后续需要落盘
|-- README.md                # 项目入口说明
```

说明：

- `app/`、`mac/`、`relay/` 是三个可运行产品面。
- `protocol/` 是跨端契约的唯一源头。
- `packages/` 只放 TypeScript 共享库，不放后端业务。
- `infra/` 只放部署和环境配置，不放应用业务代码。
- `tests/` 放跨端验证；各端自己的单元测试仍放在各端目录内。

## 工程技术栈约束

已确认的工程约束：

- `app/` 使用 React Native + TypeScript，移动端产出 Android APK 和 iOS IPA，Web 端产出静态 SPA。
- `app/` 必须共享同一套业务代码适配 Android、iOS 和 Web。
- `app/` 推荐采用 React Native CLI；Web 通过 `react-native-web` 接入，不独立重写 UI。
- `mac/` 使用 TypeScript / Node.js 技术栈实现 Agent 主体。
- `mac/` 不采用 Rust/Swift 作为业务主实现；如需 macOS 原生能力，只作为最薄的平台桥接层。
- `protocol/` 优先生成 TypeScript 类型，供 `app/` 和 `mac/` 共同复用。
- Relay 是否使用 TypeScript 不强制，但不得绕过 `protocol/` 自行定义消息格式。

技术栈建议：

| 模块 | 主技术栈 | 说明 |
| --- | --- | --- |
| `app/` | React Native CLI + TypeScript + react-native-web | 同一套代码交付 Android/iOS APK/IPA 和 Web SPA；终端区域默认用 React Native 视图 |
| `mac/` | Node.js LTS + TypeScript | 管理 Relay 连接、tmux、PTY、Codex runtime、本地状态 |
| `relay/` | Go / Rust / TypeScript 均可 | 作为企业内网中继，独立部署 |
| `protocol/` | JSON Schema / OpenAPI / AsyncAPI + TS 生成物 | 跨端协议契约 |
| `packages/` | TypeScript | App 和 Mac 可复用的协议、客户端、terminal core |

## app 目录

`app/` 是 React Native App，负责 Android/iOS/Web 上的配对、设备选择、会话列表、TUI 渲染、结构化 Codex UI 和输入体验。Web 端是单页面程序，不实现摄像头扫码。

推荐结构：

```text
app/
|-- README.md
|-- package.json
|-- tsconfig.json
|-- app.json
|-- index.js
|-- index.web.tsx
|-- babel.config.js
|-- metro.config.js
|-- webpack.config.js
|-- web/
|   |-- index.html
|-- assets/
|   |-- icons/
|   |-- splash/
|-- src/
|   |-- app/
|   |   |-- App.tsx
|   |   |-- navigation.tsx
|   |   |-- providers/
|   |   |-- error-boundary.tsx
|   |-- screens/
|   |   |-- login/
|   |   |-- devices/
|   |   |-- sessions/
|   |   |-- terminal/
|   |   |-- codex/
|   |   |-- settings/
|   |-- features/
|   |   |-- auth/
|   |   |-- devices/
|   |   |-- sessions/
|   |   |-- terminal/
|   |   |-- codex-structured/
|   |   |-- notifications/
|   |   |-- audit/
|   |-- components/
|   |   |-- layout/
|   |   |-- controls/
|   |   |-- feedback/
|   |-- terminal/
|   |   |-- NativeTerminalView.tsx
|   |   |-- terminalText.ts
|   |-- terminal-core/
|   |   |-- keyboard/
|   |   |-- viewport/
|   |   |-- clipboard/
|   |-- platform/
|   |   |-- linking/
|   |   |-- secure-storage/
|   |   |-- webrtc/
|   |-- lib/
|   |   |-- relay-client/
|   |   |-- storage/
|   |   |-- telemetry/
|   |   |-- feature-flags/
|   |-- styles/
|   |-- generated/
|   |   |-- protocol/
|-- ios/
|-- android/
|-- tests/
|   |-- unit/
|   |-- component/
|   |-- e2e/
```

### app 内部边界

`screens/`：

- 移动端导航级页面。
- 不直接实现复杂业务逻辑。
- 组合 `features/` 和 `components/`。

`features/`：

- 按业务能力拆分。
- 每个 feature 内部可以有自己的 state、API 调用、hooks、组件。
- 不跨 feature 深层引用，只通过公开入口引用。

`terminal/`：

- 承载 React Native 原生终端快照视图。
- 处理终端文本归一化、ANSI 控制序列清理、横向/纵向滚动。
- 不加载远程网页，不作为 PWA 或浏览器入口。

`terminal-core/`：

- 只处理原始 TUI 体验。
- 包括快捷键栏、移动端 viewport、终端文本处理、剪贴板策略。
- 不处理 Codex 结构化业务语义。

`features/codex-structured/`：

- 处理 Codex app-server adapter 暴露的结构化事件。
- 包括 thread、turn、approval、diff、tool event、任务摘要。
- 长期作为手机端主体验。

`lib/relay-client/`：

- 封装手机到 Relay 的连接。
- 负责 WebSocket、重连、seq/ack、鉴权 header、错误恢复。
- 页面和 feature 不直接使用裸 WebSocket。

`generated/protocol/`：

- 由 `protocol/` 生成。
- 不手工编辑。

`platform/`：

- 放 Android/iOS/Web 的平台能力适配。
- 例如链接导入、安全存储、WebRTC peer connection。
- 业务层只依赖 `platform` 暴露的统一接口，不直接依赖 Keychain、浏览器 API 或 `react-native-webrtc`。

### app 跨端要求

- Android、iOS 和 Web 必须共享同一套业务代码。
- 允许保留 `ios/`、`android/` 原生目录，但原生代码只处理通知、证书、设备信息等平台边界。
- Web 端只能新增入口、构建配置和必要平台适配，不复制整套页面。
- 平台差异优先放在 `src/platform/` 或局部 `.native/.web` 组件中。
- 不再新增 `src/native/` 作为业务依赖目录；原生能力也通过 `src/platform/*/*.native.ts` 暴露。
- 终端渲染默认使用 React Native 原生快照视图。
- 结构化 Codex UI 使用 React Native 原生组件实现，不放在 WebView 中。
- 推送通知使用 APNs / FCM 或公司统一推送网关，不使用 Web Push 作为交付链路。
- 移动端安全存储使用平台安全存储能力，不能使用普通明文 AsyncStorage 存临时 key。
- Web 端不使用扫码能力，配对通过手动输入或 URL 导入完成。

## mac 目录

`mac/` 是 TypeScript 技术栈的 Mac 本地 Agent，负责连接 Relay、管理 Codex runtime、管理 tmux/PTY 会话、保存本地状态、生成临时 key 和 macOS 自启动。

推荐结构：

```text
mac/
|-- README.md
|-- agent/
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- main.ts
|   |   |-- agentd/
|   |   |-- core/
|   |   |-- relay-client/
|   |   |-- codex-runtime/
|   |   |-- pty-bridge/
|   |   |-- tmux-manager/
|   |   |-- session-store/
|   |   |-- auth-key/
|   |   |-- keychain/
|   |   |-- telemetry/
|   |   |-- config/
|   |   |-- protocol/
|   |-- tests/
|   |-- dist/
|-- macos/
|   |-- README.md
|   |-- LaunchAgent/
|   |-- Entitlements/
|   |-- Packaging/
|   |-- Notarization/
|   |-- MenuBar/
|-- resources/
|   |-- launchd/
|   |-- default-config/
|   |-- icons/
|-- native/
|   |-- keychain/
|   |-- notarization/
|   |-- launch-services/
|-- generated/
|   |-- protocol/
```

### mac/agent

`mac/agent` 是生产 Agent 的主体，必须使用 TypeScript / Node.js 实现。

职责：

- 连接公司内网 Relay。
- 注册设备。
- 维护心跳。
- 管理本地会话。
- 启动和监督 Codex runtime。
- 管理 `tmux` session。
- 管理 PTY 输入输出。
- 处理 backpressure、snapshot、重连。
- 保存本地 SQLite 状态。
- 每次启动生成 32 字符临时 key，并保存到本地文件。

推荐模块边界：

`agentd/`：

- Agent 主进程入口。
- 解析配置。
- 启动各子系统。
- 处理 shutdown。

`core/`：

- Agent 领域模型。
- 设备、会话、连接、状态机。
- 不直接依赖具体 WebSocket、tmux、auth-key、Keychain 实现。

`relay-client/`：

- 与 Relay 的出站连接。
- WebSocket、临时 key proof、重连、心跳。
- 不直接管理 Codex 进程。

`codex-runtime/`：

- Codex app-server adapter。
- Codex CLI 版本探测。
- app-server 启动、停止、健康检查。
- JSON-RPC 事件转换。

`pty-bridge/`：

- PTY 读写。
- terminal frame 编码。
- resize。
- snapshot。
- 慢客户端降级。

`tmux-manager/`：

- 创建、列出、attach、detach、关闭 `tmux` session。
- 从现有 `tmux` 恢复 session registry。
- 屏蔽 shell 命令细节。

`session-store/`：

- 本地 SQLite。
- 会话元数据。
- 终端快照索引。
- Agent 配置状态。

`auth-key/`：

- Mac Agent 启动时生成 32 字符临时 key。
- 保存 `session-key.json`。
- 控制目录 `0700` 和文件 `0600` 权限。
- 提供 HMAC proof 校验。
- 不向日志输出完整 key。

`keychain/`：

- Mac Keychain 封装。
- 保留给后续长期 secret 或企业凭证。
- 不向上层暴露明文长期凭证。

`config/`：

- 读取默认配置、用户配置和企业下发配置。
- 合并环境变量和配置文件。
- 对外提供类型安全配置对象。

`telemetry/`：

- logs、metrics、trace。
- 上报审计元数据。

`protocol/`：

- 从根目录 `protocol/` 生成或同步的 TypeScript 类型。
- 不手工维护业务 schema。

### mac TypeScript 工程要求

- 使用 Node.js LTS 作为运行时。
- 所有 Agent 业务逻辑使用 TypeScript。
- 允许使用必要的 Node native addon，例如 PTY、SQLite、Keychain bridge，但 native addon 必须封装在清晰模块后面。
- `node-pty` 可作为 PTY 主实现，所有 PTY 操作必须通过 `pty-bridge/`，业务模块不直接调用。
- `tmux` 操作必须通过 `tmux-manager/`，不能在业务代码中散落 shell 命令。
- 本地状态建议使用 SQLite，访问统一收敛在 `session-store/`。
- 当前 MVP 登录不使用长期凭证；临时 key 写入 `session-key.json`，文件权限必须为 `0600`。
- 后续长期凭证必须存入 macOS Keychain，不能写入明文配置文件。
- 打包时需要内嵌或固定 Node runtime，避免依赖用户机器上的全局 Node 版本。
- macOS 签名、公证、LaunchAgent 配置属于 `macos/` 和 `native/` 的职责，不进入 Agent 业务层。

### mac/macos

`mac/macos` 放 macOS 平台集成，不放 Agent 核心业务。

职责：

- LaunchAgent plist。
- 可选 Menu Bar 或轻量设置界面。
- 可选 LoginItem 注册。
- Entitlements。
- 签名、公证、打包脚本配置。
- 企业分发材料。

原则：

- 不在 `macos/` 中实现 Agent 业务逻辑。
- 如果必须写少量 Swift/Objective-C，只作为平台桥接或 UI shell。
- TypeScript Agent 是唯一业务真相。

### mac/native

`mac/native` 放 TypeScript 无法直接覆盖的极薄平台桥。

允许内容：

- Keychain native binding。
- Launch Services / LoginItem 辅助逻辑。
- 签名、公证、打包辅助。

不允许内容：

- 会话管理业务。
- Relay 协议业务。
- Codex runtime 业务。
- 终端 frame 处理业务。

## relay 目录

`relay/` 是公司内网中继服务，负责手机和 Mac Agent 之间的安全连接、路由、临时 key 鉴权和审计。

如果公司已有统一中继平台，本目录可以变成 adapter 或 mock 服务；如果本项目自建中继，则本目录是完整服务。

当前仓库先落地 TypeScript MVP：

```text
relay/
|-- server/
|   |-- README.md
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- main.ts
|   |   |-- config.ts
|   |   |-- relayServer.ts
|   |   |-- websocket.ts
```

后续如果公司决定用 Go/Rust 重写生产 Relay，可保留同样的协议边界。完整企业结构可演进为：

```text
relay/
|-- cmd/
|   |-- relay/
|   |   |-- main.go
|   |-- relay-admin/
|-- internal/
|   |-- auth/
|   |-- devices/
|   |-- bindings/
|   |-- sessions/
|   |-- routing/
|   |-- websocket/
|   |-- terminal/
|   |-- codex/
|   |-- audit/
|   |-- policy/
|   |-- notifications/
|   |-- persistence/
|   |-- telemetry/
|   |-- config/
|-- api/
|   |-- openapi/
|   |-- asyncapi/
|-- migrations/
|-- deployments/
|-- tests/
|   |-- integration/
|   |-- contract/
|-- generated/
|   |-- protocol/
```

### relay 内部边界

`auth/`：

- 临时 key challenge/proof。
- Relay nonce 生成。
- Mac Agent proof 校验转发。
- 失败次数限流。

`devices/`：

- Mac 设备注册。
- 在线状态。
- Agent 版本。
- 设备合规状态。

`bindings/`：

- MVP 不做长期用户与 Mac 绑定。
- 可预留后续设备绑定、委派访问和管理员撤销能力。

`routing/`：

- 手机连接和 Agent 连接的匹配。
- 消息转发。
- 在线路由表。

`websocket/`：

- WSS 连接管理。
- ping/pong。
- backpressure。
- 连接限流。

`terminal/`：

- TUI 数据面 relay。
- 不解析终端业务内容。
- 处理 frame、ack、snapshot。

`codex/`：

- 结构化 Codex 消息转发。
- 不直接连接 Codex app-server。
- 不承载 Codex 业务状态真相。

`audit/`：

- key 配对成功/失败、连接、断开、会话创建、会话关闭、approval 等元数据审计。

`policy/`：

- 访问策略。
- 高风险操作重新认证。
- 企业管控开关。

`notifications/`：

- APNs / FCM / 公司统一推送网关。
- 任务完成通知。
- 会话异常通知。

## protocol 目录

`protocol/` 是跨端协议契约中心。手机、Mac、Relay 都不应各自手写一份协议类型。

推荐结构：

```text
protocol/
|-- README.md
|-- version.json
|-- envelopes/
|   |-- message-envelope.schema.json
|   |-- error.schema.json
|-- terminal/
|   |-- terminal-frame.schema.json
|   |-- terminal-input.schema.json
|   |-- terminal-snapshot.schema.json
|   |-- terminal-resize.schema.json
|-- sessions/
|   |-- session.schema.json
|   |-- session-events.schema.json
|-- devices/
|   |-- device.schema.json
|   |-- device-binding.schema.json
|-- codex/
|   |-- codex-thread.schema.json
|   |-- codex-turn.schema.json
|   |-- codex-approval.schema.json
|   |-- codex-diff.schema.json
|-- auth/
|   |-- auth-events.schema.json
|-- openapi/
|   |-- relay-control.yaml
|-- asyncapi/
|   |-- relay-websocket.yaml
|-- fixtures/
|   |-- terminal/
|   |-- codex/
|   |-- sessions/
|-- generated/
|   |-- ts/
|   |-- go/
|   |-- rust/
```

原则：

- `protocol/` 是唯一 schema 源。
- `app/src/generated/protocol`、`mac/generated/protocol`、`relay/generated/protocol` 都从这里生成。
- `app/` 和 `mac/` 优先使用 TypeScript 生成物。
- `go/`、`rust/` 生成物只服务 Relay 或后续平台扩展，不是 App/Mac 主依赖。
- 生成物不要手工修改。
- 协议变更必须带 contract test。
- 协议字段只新增不随意改语义；破坏性变更要升级版本。

## packages 目录

`packages/` 只放 TypeScript 共享包，主要服务 App、Mac Agent 和未来 Web 管理台。

推荐结构：

```text
packages/
|-- protocol-ts/
|-- relay-client/
|-- terminal-core/
|-- mobile-ui/
|-- config/
|-- eslint-config/
|-- tsconfig/
```

说明：

- `protocol-ts/`：由 `protocol/` 生成后包装出的 TS SDK。
- `relay-client/`：可被 `app/` 和 `mac/` 复用的 Relay 客户端核心。
- `terminal-core/`：终端输入、快捷键、frame 合并等纯 TS 逻辑。
- `mobile-ui/`：React Native 通用 UI 组件，不放业务页面。
- `config/`：App 和 Mac 可共享的配置 schema，不放环境 secret。
- `eslint-config`、`tsconfig`：TypeScript 工程规范。

注意：

- Mac Agent 可以依赖 `protocol-ts`、`relay-client`、`terminal-core`、`config`。
- Mac Agent 不依赖 `mobile-ui`。
- Relay 如果使用 TypeScript，可以依赖 `packages/protocol-ts`；Go/Rust Relay 则从 `protocol/` 生成本语言类型。
- 跨语言共享走 `protocol/`，不是走 TS 包。

## infra 目录

`infra/` 放环境、部署、证书和观测配置。

推荐结构：

```text
infra/
|-- README.md
|-- local/
|   |-- docker-compose.yaml
|   |-- relay.env.example
|   |-- postgres/
|   |-- redis/
|-- k8s/
|   |-- relay/
|   |-- observability/
|-- terraform/
|-- certs/
|   |-- README.md
|   |-- dev/
|-- observability/
|   |-- dashboards/
|   |-- alerts/
|   |-- otel/
|-- mdm/
|   |-- mac-agent-profile-notes.md
```

原则：

- 不提交生产 secret。
- `certs/dev` 只允许开发证书说明或本地样例。
- 生产证书等敏感材料走公司密钥系统；当前 MVP 不需要 OIDC secret。
- MDM 相关只放说明和模板，不放真实企业敏感配置。

## scripts 目录

`scripts/` 放开发、生成、验证和打包脚本。

推荐结构：

```text
scripts/
|-- README.md
|-- dev/
|   |-- start-app.sh
|   |-- start-relay.sh
|   |-- start-mac-agent.sh
|-- generate/
|   |-- protocol.sh
|   |-- openapi.sh
|-- verify/
|   |-- lint.sh
|   |-- typecheck.sh
|   |-- test.sh
|   |-- contract.sh
|-- package/
|   |-- mac-agent.sh
|   |-- app.sh
```

原则：

- 脚本只编排命令，不隐藏复杂业务逻辑。
- 脚本应可在 CI 中运行。
- 不在脚本中写死个人路径。
- 需要公司环境的脚本提供 `.example` 配置。

## tests 目录

`tests/` 放跨端测试。单端单元测试放各端内部。

推荐结构：

```text
tests/
|-- README.md
|-- contract/
|   |-- protocol-compat/
|   |-- relay-agent/
|   |-- relay-app/
|-- e2e/
|   |-- local-tui/
|   |-- relay-flow/
|   |-- reconnect/
|   |-- multi-session/
|-- security/
|   |-- authz/
|   |-- key-proof/
|   |-- key-rotation/
|   |-- clipboard/
|-- fixtures/
|   |-- terminal-frames/
|   |-- codex-events/
```

跨端必测场景：

- 手机连接 Relay。
- Mac Agent 注册 Relay。
- App 使用正确临时 key 可以连接。
- App 使用错误临时 key 不能连接。
- 创建 Codex TUI 会话。
- 切换多个会话。
- 手机断线后 Mac 会话继续。
- 手机重连后恢复终端快照。
- Agent 重启后恢复 tmux 会话，并生成新的临时 key。
- Agent 重启后旧 key 不能继续访问。
- 慢连接不会导致内存无限增长。

## docs 目录

`docs/` 保存项目长期知识。

推荐继续补充：

```text
docs/
|-- engineering-requirements.md
|-- auth-key-design.md
|-- app-installation.md
|-- mobile-codex-tui-workbench-design.md
|-- mobile-codex-tui-technical-solution.md
|-- project-directory-structure.md
|-- protocol-design.md
|-- mac-agent-design.md
|-- relay-design.md
|-- app-design.md
|-- security-review-notes.md
|-- deployment-guide.md
|-- runbook.md
```

原则：

- 当前设计结论放在 docs 根目录。
- 历史探索或废弃方案放 `docs/archive/`。
- 安全审查、部署、运维单独成文。
- 协议变化需要同步更新 `protocol-design.md`。

## tools 目录

`tools/` 放辅助工具，不是产品运行时。

推荐结构：

```text
tools/
|-- protocol-lint/
|-- terminal-frame-viewer/
|-- relay-load-test/
|-- codex-event-recorder/
```

用途：

- 协议 lint。
- 终端 frame 回放。
- Relay 压测。
- Codex app-server 事件录制和脱敏回放。

## fixtures 目录

`fixtures/` 放可复用测试样例。

推荐结构：

```text
fixtures/
|-- terminal/
|   |-- simple-output.jsonl
|   |-- resize.jsonl
|   |-- slow-network.jsonl
|-- codex/
|   |-- turn-events.jsonl
|   |-- approval-request.json
|   |-- diff-event.json
|-- auth/
|   |-- oidc-user.json
|   |-- device-binding.json
```

原则：

- 只放脱敏样例。
- 不放真实终端日志。
- 不放真实临时 key、token 或其他凭证。

## 配置文件规划

根目录后续可以加入：

```text
package.json              # JS workspace 编排
pnpm-workspace.yaml       # app 与 packages 工作区
Makefile 或 justfile       # 跨语言任务入口
.editorconfig
.gitignore
.env.example
```

注意：

- 根目录配置只做编排，不承载单端业务逻辑。
- `app/` 有自己的 TypeScript 配置。
- `mac/agent` 有自己的 TypeScript 配置。
- `relay/` 有自己的 Go module 或 Rust workspace。
- 根目录 JS workspace 应覆盖 `app/`、`mac/agent`、`packages/`。
- Relay 如采用 Go/Rust，可保留独立构建入口，由根目录脚本编排。

## 依赖方向

推荐依赖方向：

```text
app       --> packages/protocol-ts
app       --> packages/relay-client
app       --> packages/terminal-core

mac       --> packages/protocol-ts
mac       --> packages/relay-client
mac       --> packages/terminal-core
relay     --> protocol/generated/go

app       --> relay API
mac       --> relay API
relay     --> protocol schemas

app       -X-> mac internal code
mac       -X-> app internal code
relay     -X-> app/mac internal code
```

核心原则：

- `app` 和 `mac` 不直接互相 import。
- `app` 和 `mac` 可以共享 `packages/` 中的纯 TypeScript SDK 与纯逻辑。
- `app` 不依赖 `mac/agent` 内部模块。
- `mac` 不依赖 `app/src` 内部模块。
- `relay` 不依赖 app/mac 内部实现。
- 三端通过 `protocol/` 和 Relay API 通信。
- 任何跨端字段变化先改 `protocol/`。

## MVP 最小目录

第一阶段不需要一次性创建所有目录。MVP 可以先落：

```text
OmniWork/
|-- app/
|-- mac/
|-- relay/
|-- protocol/
|-- docs/
|-- scripts/
|-- tests/
```

其中：

- `app/` 先实现 React Native 跨端 App + 原生终端快照页。
- `mac/` 先实现 TypeScript / Node.js Agent 初版。
- `relay/` 先实现 WSS 转发和 mock auth。
- `protocol/` 先定义 terminal/session/device 三组消息。
- `tests/` 先覆盖创建会话、输入、重连、多会话切换。

## 从 MVP 到企业版的演进

### MVP 阶段

目录重点：

```text
app/
mac/agent/
relay/
protocol/
tests/e2e/
```

目标：

- 打通手机到 Mac Codex TUI。
- 支持多会话。
- 支持断线重连。

### 企业化阶段

目录重点：

```text
mac/agent/
mac/macos/
relay/internal/auth/
relay/internal/audit/
relay/internal/policy/
infra/
tests/security/
```

目标：

- 临时 key 文件权限。
- key proof 失败限流。
- Relay 不记录完整 key。
- LaunchAgent。
- 审计。
- Keychain 仅作为后续长期凭证能力预留。

### 结构化 Codex 阶段

目录重点：

```text
mac/agent/src/codex-runtime/
app/src/features/codex-structured/
protocol/codex/
fixtures/codex/
```

目标：

- 接入 Codex app-server adapter。
- 手机端增加结构化 Codex UI。
- TUI 作为兼容通道保留。

## 命名约定

推荐命名：

- App 目录叫 `app/`，不是单独的 `web/`，强调 Android/iOS/Web 共用同一 React Native 工作台入口。
- Mac 端目录叫 `mac/`，不是 `desktop/`，避免误解为跨桌面远控。
- 中继目录叫 `relay/`，不是 `server/`，强调它只做中继、鉴权、路由和审计。
- 跨端契约叫 `protocol/`，不是 `shared/`，避免被塞进杂物。
- TypeScript 共享包叫 `packages/`，服务 `app/` 和 `mac/agent` 的 JS/TS 生态。

## 不建议的结构

不建议：

```text
src/
|-- app/
|-- mac/
|-- relay/
```

原因：

- 多语言工程放在一个 `src` 下会让构建、测试、打包边界变模糊。

不建议：

```text
client/
server/
```

原因：

- 本项目不是简单 C/S 架构，而是手机端、Mac Agent、Relay 三方系统。

不建议：

```text
shared/
```

原因：

- `shared` 容易变成没有边界的杂物目录。
- 跨端共享应优先走 `protocol/`。

不建议：

```text
remote-control/
```

原因：

- 会弱化本项目「Codex TUI 专用工作台」的合规边界。

## 目录治理规则

- 新增跨端字段，先改 `protocol/`。
- 新增手机业务能力，放 `app/src/features/`。
- 新增 Mac 本地能力，优先放 `mac/agent/src/` 的对应模块。
- 新增 Relay 能力，放 `relay/internal/` 的对应领域模块。
- 生成代码只放 `generated/`，不手改。
- 临时验证代码放 `prototypes/` 或 `tools/`，不能被生产路径依赖。
- 企业部署配置放 `infra/`，不混入业务代码。
- 真实 secret、临时 key、token、证书不进入仓库。

## 推荐落地顺序

1. 创建 `protocol/`，定义最小 envelope、session、terminal、device schema。
2. 创建 `relay/`，实现最小 WSS relay 和 mock auth。
3. 创建 `mac/agent/`，用 TypeScript / Node.js 打通 tmux/PTY。
4. 创建 `app/`，实现 React Native 跨端 App、设备页、会话页、原生终端快照页。
5. 补 `tests/e2e/`，覆盖创建、输入、切换、重连。
6. 企业化时补 `mac/macos/`、`infra/`、`relay/internal/auth`、`relay/internal/audit`。
7. 接入 Codex app-server 时补 `protocol/codex/` 和 `app/src/features/codex-structured/`。

## 最终建议

本项目应采用以下核心目录：

```text
app/       # Android/iOS/Web 共用的 React Native App
mac/       # TypeScript Mac Agent
relay/     # 公司内网中继
protocol/  # 跨端协议
packages/  # TS 共享包
infra/     # 部署与企业环境
tests/     # 跨端验证
docs/      # 长期设计文档
```

这个结构能保证 app 和 mac 都在同一工程下，同时保留 Relay、协议、安全和企业部署的清晰边界。MVP 可以从 `app/`、`mac/`、`relay/`、`protocol/` 四个核心目录开始，后续再补齐企业化和结构化 Codex 能力。
