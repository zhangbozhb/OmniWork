# 项目目录结构规划

关联文档：

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [engineering-requirements.md](./engineering-requirements.md)
- [relay-architecture.md](./relay-architecture.md)
- [relay-architecture-implementation.md](./relay-architecture-implementation.md)
- [e2e-noise-roadmap.md](./e2e-noise-roadmap.md)
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)

## 目标

本项目采用 monorepo，把手机端 App、桌面端 Agent、公司内网 Relay、共享协议和部署材料放在同一个工程下。

目录规划需要满足：

- 手机端代码和 桌面端代码都在本工程内。
- 各端边界清晰，避免互相直接依赖内部实现。
- 协议契约集中管理，手机、电脑、Relay 只依赖生成物或稳定 SDK。
- 支持先做 MVP，再演进到企业正式部署。
- App 和 桌面端 Agent 均采用 TypeScript 技术栈。
- App 采用 React Native 技术栈，同时适配 Android、iOS 和 Web SPA；Web 不另起一套 React DOM UI。
- Public Web 采用独立静态站点，负责项目介绍、公开文档、下载和 `/app/` 入口，不承载产品操作。
- Relay 使用 TypeScript（见 `relay/server/`），可替换为 Go/Rust，但必须通过 `protocol/` 与 App/电脑 对齐。
- 不把本项目做成通用远控系统，目录命名也要体现 Codex TUI 工作台的窄能力边界。

## 顶层结构

仓库真实顶层结构：

```text
OmniWork/
|-- app/                     # React Native App，适配 Android / iOS / Web SPA
|-- site/                    # Astro 静态 Public Web，承载官网、公开文档与下载入口
|-- desktop/                     # TypeScript 电脑 本地 Agent 与 电脑系统 集成
|-- relay/                   # 公司内网中继服务
|-- protocol/                # 跨端协议 JSON Schema
|-- packages/                # TypeScript 共享包
|-- scripts/                 # 本地开发、生成、验证脚本
|-- docs/                    # 设计文档与运维说明
|-- AGENTS.md                # Agent 工作准则
|-- README.md                # 项目入口说明
|-- package.json             # 根 workspace 编排
|-- pnpm-workspace.yaml
|-- tsconfig.base.json
```

说明：

- `app/`、`site/`、`desktop/`、`relay/` 是当前可运行产品/交付面。
- `site/` 是公开 Web 层，占用生产 `/`、`/docs/`、`/download/`、`/changelog/`；现有产品 Web SPA 仍由 `app/` 构建并部署到 `/app/`。
- `protocol/` 是跨端契约的唯一源头。
- `packages/` 只放 TypeScript 共享库，不放后端业务。
- `scripts/` 放跨端开发与验证脚本（详见 [scripts 目录](#scripts-目录)）。
- 各端单元测试放在各端目录内（`app/`、`desktop/agent/tests/`、`relay/server/tests/`、`packages/*/tests/`）。

> 规划中尚未落地的目录：`infra/`（部署/证书/观测）、`tests/`（跨端 e2e）、`tools/`（一次性辅助）、`fixtures/`（脱敏样例）。这些目录按企业化需求创建，避免空目录。

## 工程技术栈约束

已确认的工程约束：

- `app/` 使用 React Native + TypeScript，移动端产出 Android APK 和 iOS IPA，Web 端产出静态 SPA。
- `app/` 必须共享同一套业务代码适配 Android、iOS 和 Web。
- `app/` 推荐采用 React Native CLI；Web 通过 `react-native-web` 接入，不独立重写 UI。
- `desktop/` 使用 TypeScript / Node.js 技术栈实现 Agent 主体。
- `desktop/` 不采用 Rust/Swift 作为业务主实现；如需 电脑系统 原生能力，只作为最薄的平台桥接层。
- `protocol/` 优先生成 TypeScript 类型，供 `app/` 和 `desktop/` 共同复用（TS 主体在 `packages/protocol-ts/`）。
- Relay 是否使用 TypeScript 不强制，但不得绕过 `protocol/` 自行定义消息格式。
- App-Agent 业务消息采用 E2E encrypted-only 模型；Noise 加解密能力在 `packages/e2e-noise/`，Relay 不作为业务明文安全边界。

技术栈：

| 模块 | 主技术栈 | 说明 |
| --- | --- | --- |
| `app/` | React Native CLI + TypeScript + react-native-web | 同一套代码交付 Android/iOS APK/IPA 和 Web SPA；终端区域以 xterm Web/native WebView 视图为主 |
| `site/` | Astro 静态站点 | 交付 Public Web：首页、公开文档、下载页、发布记录；通过静态 `downloads.json` 指向 App Store 与 GitHub Releases |
| `desktop/agent` | Node.js LTS + TypeScript | 管理 Relay 连接、tmux、PTY、Codex/Claude/Gemini 终端 provider、本地状态 |
| `relay/server` | Node.js LTS + TypeScript | MVP 实现；可替换为 Go/Rust |
| `protocol/` | JSON Schema（auth/envelopes/sessions/terminal） | 跨端协议契约的可机读真相 |
| `packages/protocol-ts` | TypeScript + zod | 协议类型与运行时校验、E2E / 升级链路类型 |
| `packages/e2e-noise` | TypeScript | App-Agent Noise E2E 握手、加解密、seq 防重放与篡改检测 |

## app 目录

`app/` 是 React Native App，负责 Android/iOS/Web 上的配对、设备选择、会话列表、TUI 渲染、文件浏览与受控文本编辑、git 状态查看与输入体验。Web 端是单页面程序，不实现摄像头扫码。

真实结构：

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
|-- .env.example
|-- web/
|   |-- index.html
|-- assets/
|   |-- icon.png
|-- scripts/
|   |-- buildIosRelease.mjs
|   |-- ensureIosPods.mjs
|   |-- generateCodeMirrorWebViewAssets.mjs
|   |-- generateXtermWebViewAssets.mjs
|-- tests/
|-- src/
|   |-- main.tsx
|   |-- app/
|   |   |-- App.tsx
|   |   |-- appConfig.ts
|   |   |-- appModel.ts           # App 纯业务工具：pairing/session upsert、状态文案、标题辅助
|   |   |-- appTransport.ts       # App 传输装配：Relay/P2P wiring 与网络变化订阅
|   |   |-- appTypes.ts           # App 顶层视图、连接状态与传输适配类型
|   |-- editor/                  # CodeMirror Web / Native WebView 编辑器
|   |-- features/
|   |   |-- app-lock/            # App 锁定、手势密码与自动锁定规则
|   |   |-- auth/                # hmacSha256 + keyProof + 类型
|   |   |-- sessions/            # sessionCapabilities / sessionMessages
|   |   |-- terminal/            # terminalLayout / terminalMessages
|   |   |-- workspaces/          # workspaceMessages + editableFiles
|   |-- i18n/                    # App/Web 共用多语言初始化、语言枚举与资源
|   |-- lib/
|   |   |-- relay-client/        # mobileRelaySession.ts
|   |   |-- transport/           # SessionTransport / UpgradeCoordinator / WebRTC peer adapter（native/web 双实现）
|   |-- platform/
|   |   |-- app-lock-storage/    # App lock 持久化平台分包
|   |   |-- linking/             # appLinking 平台分包
|   |   |-- owner-auth/          # 设备所有者认证平台分包
|   |   |-- secure-storage/      # securePairingStore 平台分包
|   |-- screens/
|   |   |-- devices/             # DeviceListScreen
|   |   |-- pairing/             # PairingScreen + PairingQrScannerModal（native/web）
|   |   |-- security/            # AppLockIntro / GestureSetup / GestureUnlock / SecuritySettings
|   |   |-- sessions/            # SessionListScreen
|   |   |-- settings/            # SettingsScreen + ConnectionPreferenceScreen
|   |   |-- terminal/            # TerminalScreen
|   |   |-- workspaces/          # FileBrowserScreen + FileEditorScreen + GitStatusScreen
|   |-- terminal/                # NativeTerminalView + terminalText
|   |-- ui/                      # 通用组件（KeyboardAwareScrollView / components / icons / theme / confirm）
|-- ios/
|-- android/
```

### app 内部边界

`screens/`：

- 移动端导航级页面，包含 `devices` / `pairing` / `security` / `sessions` / `settings` / `terminal` / `workspaces`。
- 不直接实现复杂业务逻辑；组合 `features/` 与 `lib/`。
- `workspaces/GitStatusScreen` 采用 Git Overview + Review 分层：概览页展示分支、摘要与变更文件，Review 视图按 scope 与文件阅读 diff，避免在概览页底部堆叠完整 diff。

`features/`：

- 按业务能力拆分。
- 每个 feature 内部可以有自己的 state、消息编解码、hooks、组件。
- 不跨 feature 深层引用，只通过公开入口引用。

`editor/`：

- 维护 CodeMirror 编辑器的 Web / Native WebView 分包与离线 WebView 资产。
- 支撑文件预览进入编辑、dirty 状态、改动行号、按需 diff、保存前冲突检测所需的内容读取。
- Native WebView 资产由 `app/scripts/generateCodeMirrorWebViewAssets.mjs` 从本地依赖生成，不运行时加载远程脚本。

`i18n/`：

- 维护 App/Web 共用的多语言资源、语言枚举与 i18next 初始化。
- 用户可见 UI 文案优先通过翻译 key 管理；协议字段、日志和调试信息不纳入 UI 多语言资源。
- 语言偏好保存为当前设备/浏览器本地设置，不作为跨设备账号配置。

`lib/relay-client/`：

- 封装手机到 Relay 的连接（`mobileRelaySession.ts`）。
- 负责 WebSocket、重连、seq/ack、鉴权 challenge/proof、错误恢复。
- 页面与 feature 不直接使用裸 WebSocket。

`lib/transport/`：

- 关键升级链路在 App 端的实装：`sessionTransport.ts`、`upgradeCoordinator.ts`、`webRtcPeerAdapter.{native,web}.ts`、`relayPath.ts`、`index.ts`。
- 详见 [relay-architecture.md](./relay-architecture.md)；Web 端通过浏览器原生 WebRTC API 参与升级，缺少 API 时按连接模式回退或失败。

`platform/`：

- Android/iOS/Web 的平台能力适配（QR 扫码 linking、安全存储、App lock 存储、设备所有者认证）。
- 业务层只依赖 `platform` 暴露的统一接口，不直接依赖 Keychain 或浏览器 API。
- 通过 `*.native.ts` / `*.web.ts` 平台分包实现差异。

`terminal/`：

- 承载Native WebView/xterm 终端兼容视图；WebView 只作为终端渲染容器，不承载主界面。
- 处理终端文本归一化、ANSI 控制序列清理、横向/纵向滚动。
- 终端 HTML/CSS/JS 资源必须由 `app/scripts/generateXtermWebViewAssets.mjs` 从已安装的 `@xterm/*` 依赖生成并本地打包，不运行时加载 CDN 或远程网页；App 主交付仍是 React Native APK/IPA，native 体验优先于 Web 实验入口。

`ui/`：

- 通用 UI 组件（含 confirm 弹窗、KeyboardAwareScrollView、theme、icons）。
- 不放业务页面。

> 暂未实装但仍属规划：`screens/login`（MVP 通过配对码登录，未独立 login 屏）、结构化 Codex UI 运行时接入（协议层已有 `codex.*` 消息类型，等接入 Codex app-server 后再补 UI 与运行时适配）、`features/notifications` / `features/audit` / `lib/storage` / `lib/telemetry` / `lib/feature-flags` / `src/styles` / `src/generated/protocol`。当前仓库中若存在空占位目录，不代表能力已经落地；实现事实以有代码文件和协议处理链路为准。

### app 跨端要求

- Android、iOS 和 Web 必须共享同一套业务代码。
- 允许保留 `ios/`、`android/` 原生目录，但原生代码只处理通知、证书、设备信息等平台边界。
- Web 端只能新增入口、构建配置和必要平台适配，不复制整套页面。
- 平台差异优先放在 `src/platform/` 或局部 `.native.tsx` / `.web.tsx` 组件中。
- 不再新增 `src/native/` 作为业务依赖目录。
- 终端渲染默认使用 xterm Web/native WebView 视图；React Native 快照视图只作为兼容 fallback。
- 推送通知（规划）使用 APNs / FCM 或公司统一推送网关，不使用 Web Push 作为交付链路。
- 移动端安全存储使用平台安全存储能力，不能使用普通明文 AsyncStorage 存临时 key。
- Web 端不使用扫码能力，配对通过手动输入或 URL 导入完成。
- 文件编辑仅面向 `SUPPORTED_TEXT_FILE_EXTENSIONS` 中声明的 UTF-8 文本文件，保存必须携带打开时的 `contentHash` 作为 `baseHash`，由 桌面端 Agent 做冲突检测。

## desktop 目录

`desktop/` 是 TypeScript 技术栈的 电脑 本地 Agent，负责连接 Relay、管理 runtime（Codex/Claude/Gemini）、管理 tmux/PTY 会话、保存本地状态、提供文件与 git 视图、处理直连升级与生成临时 key。

真实结构：

```text
desktop/
|-- agent/
|   |-- README.md
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- main.ts
|   |   |-- agentd/              # startAgent 主入口
|   |   |-- core/                # agentService / sessionManager / sessionRequestHandler / resourceRequestHandler / terminalFramePusher
|   |   |-- relay-client/        # agentRelayClient
|   |   |-- transport/           # SessionTransport / UpgradeCoordinator / WebRtcPeerAdapter / relayPath
|   |   |-- terminal-provider/   # terminalProviderRegistry（Codex/Claude/Gemini 终端 provider 抽象）
|   |   |-- pty-bridge/          # terminalBridge
|   |   |-- tmux-manager/        # tmuxManager
|   |   |-- session-store/       # sessionStore（SQLite sessions.sqlite）
|   |   |-- workspace/           # workspaceManager
|   |   |-- files/               # fileService
|   |   |-- git/                 # gitService
|   |   |-- pairing/             # pairingQr
|   |   |-- auth-key/            # authKey（生成/持久化 32 字符 key）
|   |   |-- keychain/            # keychain（电脑系统 Keychain 桥）
|   |   |-- telemetry/           # logger
|   |   |-- config/              # 配置加载
|   |   |-- protocol/            # 与 packages/protocol-ts 的桥接出口
|   |-- tests/
|   |   |-- transport/           # sessionTransport / upgradeCoordinator
|   |   |-- auth-key.test.ts
```

> `desktop/macos/`（LaunchAgent / 签名 / 公证 / Menu Bar）、`desktop/native/`（Keychain / Launch Services native binding）、`desktop/resources/`、`desktop/generated/` 等企业化能力未实装，按需补齐。

### desktop/agent

`desktop/agent` 是生产 Agent 的主体，使用 TypeScript / Node.js 实现。

职责：

- 连接公司内网 Relay。
- 注册设备。
- 维护心跳。
- 管理本地会话。
- 启动和监督终端 provider（Codex / Claude / Gemini）。
- 管理 `tmux` session。
- 管理 PTY 输入输出。
- 处理 backpressure、snapshot、重连。
- 保存本地状态（默认文件存储于 `~/Library/Application Support/OmniWork/agent/`）。
- 每次启动若无持久化 key 则生成 32 字符临时 key，并保存到本地文件。
- 处理 `tunnel.upgrade.*` 协议族，按需把会话从 Relay 升级到 P2P。
- 提供文件与 git 浏览能力（`files/` `git/`）。

模块边界：

`agentd/`：Agent 主进程入口（`startAgent.ts`），解析配置、启动各子系统、处理 shutdown。

`core/`：Agent 领域模型。`agentService` 负责生命周期与协议分发，`sessionManager` 负责 session 持久化与 tmux 生命周期，`sessionRequestHandler` 负责 session list/create/rename/attach/close/kill 请求处理，`resourceRequestHandler` 负责 workspace/files/git 查询处理，`terminalFramePusher` 负责终端帧推流、去重、订阅者与背压队列，`authReplayCache` 负责鉴权 nonce replay 缓存。

`relay-client/`：与 Relay 的出站连接，WebSocket、临时 key proof、重连、心跳。不直接管理终端 provider 进程。

`transport/`：升级核心。包含

- `sessionTransport.ts`：在 relay/p2p 双通道之间切换。
- `upgradeCoordinator.ts`：升级状态机。
- `webRtcPeerAdapter.ts`：基于 `@roamhq/wrtc` 的 PeerConnection 封装，含 default 解包以兼容 Node ESM。
- `relayPath.ts`、`index.ts`：通用 path 抽象与导出。

`terminal-provider/`：终端 provider 适配（`terminalProviderRegistry.ts`），支持 Codex / Claude / Gemini 三种 CLI provider；通过 `OMNIWORK_TERMINAL_PROVIDERS` 与 `OMNIWORK_{CODEX,CLAUDE,GEMINI}_COMMAND` 选择具体命令。

`pty-bridge/`：PTY 读写、terminal frame 编码、resize、snapshot、慢客户端降级。

`tmux-manager/`：创建、列出、attach、detach、关闭 `tmux` session；从现有 `tmux` 恢复 session registry。

`session-store/`：本地会话状态持久化（默认 SQLite `sessions.sqlite`；旧 `sessions.json` 仅作为首次导入来源）。

`workspace/` / `files/` / `git/`：手机端 workspace/files/git 协议消息的 Agent 端实现。

`pairing/`：生成 `omniwork://pair?...` 链接与 ASCII QR 码。

`auth-key/`：32 字符 key 生成、`session-key.json` 持久化、目录 `0700` 文件 `0600` 权限、HMAC proof 校验。日志不输出完整 key。

`keychain/`：电脑 Keychain 封装，保留给演进持久 secret 或企业凭证。

`config/`：读取默认配置、用户配置、环境变量；对外提供类型安全配置对象。

`telemetry/`：logger（日志命名空间 `omniwork-agent`、`omniwork-upgrade`），结构化日志 `ts` 使用本地时区偏移，协议/业务时间字段仍保持 UTC ISO。

`protocol/`：转出 `packages/protocol-ts` 中需要在 Agent 内部使用的类型，避免业务代码到处 import 长相对路径。

### desktop TypeScript 工程要求

- 使用 Node.js LTS 作为运行时。
- 所有 Agent 业务逻辑使用 TypeScript（基于 `node --experimental-strip-types` 直接运行 `.ts`）。
- 允许使用必要的 Node native addon（PTY、WebRTC native、Keychain bridge），但 native addon 必须封装在清晰模块后面。
- PTY 输入/快照能力通过 `pty-bridge/` 调用 `tmux-manager/` 完成；如演进引入 `node-pty`，也必须封装在 `pty-bridge/`，业务模块不直接调用 native addon。
- `tmux` 操作必须通过 `tmux-manager/`，不能在业务代码中散落 shell 命令。
- MVP 登录不使用持久凭证；临时 key 写入 `session-key.json`，文件权限必须为 `0600`。
- 演进持久凭证必须存入 电脑系统 Keychain，不能写入明文配置文件。
- WebRTC 使用 `@roamhq/wrtc`；动态 import 时需做 `default` 解包以兼容 Node ESM 包装。
- 打包时需要内嵌或固定 Node runtime，避免依赖用户机器上的全局 Node 版本。
- 电脑系统 签名、公证、LaunchAgent 配置属于规划中的 `macos/` 与 `native/`，不进入 Agent 业务层。

## relay 目录

`relay/` 是公司内网中继服务，负责手机和 桌面端 Agent 之间的安全连接、路由、临时 key 鉴权、P2P 升级编排和审计。

TypeScript MVP：

```text
relay/
|-- server/
|   |-- README.md
|   |-- package.json
|   |-- tsconfig.json
|   |-- admin-web/
|   |   |-- index.html
|   |   |-- login.html
|   |   |-- world-land-110m.geojson
|   |-- src/
|   |   |-- main.ts
|   |   |-- adminAuth.ts
|   |   |-- adminControlStore.ts
|   |   |-- adminPage.ts
|   |   |-- config.ts            # 含 OMNIWORK_UPGRADE_* 等环境变量解析
|   |   |-- relayAdminController.ts
|   |   |-- relayE2EController.ts
|   |   |-- relayLog.ts
|   |   |-- relayServer.ts       # WS 路由 + auth + 升级消息分发 + /healthz /readyz /metrics /debug/upgrade
|   |   |-- relayStateStore.ts   # Relay 控制面状态：设备 / Agent / App / 链接 / 流量计数
|   |   |-- relayTypes.ts
|   |   |-- tokenBucket.ts
|   |   |-- websocket.ts
|   |   |-- upgrade/
|   |   |   |-- orchestrator.ts  # rollout / blocklist / 退避 / metrics
|   |-- tests/
|   |   |-- upgrade/
|   |   |   |-- orchestrator.test.ts
```

> `@omniwork/relay-server` 的 `test` 脚本已执行 `adminAuth`、`adminControlStore`、`upgrade/orchestrator`、`relayServer` 单测，并在最后运行 `src/main.ts --check` 做配置自检。

演进若公司决定用 Go/Rust 重写生产 Relay，可保留同样的协议边界，目录可演进为：

```text
relay/
|-- cmd/
|   |-- relay/
|-- internal/
|   |-- auth/
|   |-- devices/
|   |-- bindings/
|   |-- sessions/
|   |-- routing/
|   |-- websocket/
|   |-- upgrade/
|   |-- terminal/
|   |-- audit/
|   |-- policy/
|   |-- notifications/
|   |-- telemetry/
|   |-- config/
|-- api/
|-- migrations/
|-- deployments/
|-- tests/
```

### relay 内部边界（MVP 与可选形态共用）

`auth/`：临时 key challenge/proof，nonce 生成，proof 校验转发，失败次数限流。

`devices/`：电脑 设备注册、在线状态、Agent 版本、设备合规状态。

`bindings/`：MVP 不做持久用户与 电脑 绑定；预留演进设备绑定、委派访问与撤销能力。

`routing/`：手机连接和 Agent 连接的匹配，消息转发，在线路由表。

`websocket/`：WSS 连接管理，ping/pong，backpressure，连接限流。

`upgrade/`（已落地）：编排 `tunnel.upgrade.{propose,offer,answer,candidate,committed,downgrade}`，按 `OMNIWORK_UPGRADE_ROLLOUT` 灰度、`OMNIWORK_UPGRADE_DEVICE_BLOCKLIST` 拒绝列表、退避策略与 `/metrics` 指标。详见 [relay-architecture.md](./relay-architecture.md)。

`terminal/`：TUI 数据面 relay，不解析终端业务内容，处理 frame、ack、snapshot。

`audit/`：key 配对成功/失败、连接、断开、会话创建、会话关闭、approval 等元数据审计（规划中）。

`policy/`：访问策略、高风险操作重新认证、企业管控开关（规划中）。

`notifications/`：APNs / FCM / 公司统一推送网关（规划中）。

## protocol 目录

`protocol/` 是跨端协议契约中心。手机、电脑、Relay 都不应各自手写一份协议类型。

真实 schema：

```text
protocol/
|-- auth/
|   |-- auth-proof.schema.json
|-- envelopes/
|   |-- message-envelope.schema.json
|-- sessions/
|   |-- session.schema.json
|-- terminal/
|   |-- terminal-input.schema.json
```

> 实际承载消息类型的"主协议体"位于 `packages/protocol-ts/src/`（`index.ts`、`schemas.ts`、`constants.ts`、`transport.ts`、`webrtc.ts`），同时通过 `tests/contract.test.ts` 维护 schema 与 TS 类型的一致性。`protocol/` 中的 JSON Schema 是给跨语言使用者（含可选 Go/Rust Relay）的机器可读真相。

可选扩展（按需补齐）：

- `protocol/version.json`：协议版本号。
- `protocol/devices/`、`protocol/codex/`、`protocol/sessions/session-events.schema.json`：补齐设备绑定、Codex 结构化、会话事件等领域。
- `protocol/openapi/`、`protocol/asyncapi/`：Relay 控制面与 WS 异步 API 文档。
- `protocol/fixtures/`：脱敏样例。
- `protocol/generated/{ts,go,rust}/`：跨语言生成物。

原则：

- `protocol/` 是唯一 schema 源（机器可读契约）。
- App / 电脑 优先使用 `packages/protocol-ts` 中的类型；该包的 `tests/contract.test.ts` 验证与 `protocol/*.schema.json` 一致。
- Go/Rust 生成物只服务 Relay 或演进平台扩展，不是 App/电脑 主依赖。
- 生成物不要手工修改。
- 协议变更必须带 contract test。
- 协议字段只新增不随意改语义；破坏性变更要升级版本。

## packages 目录

`packages/` 只放 TypeScript 共享包，主要服务 App、桌面端 Agent 和可选 Web 管理台。

真实结构：

```text
packages/
|-- protocol-ts/
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- index.ts             # MessageType 枚举、Envelope、TerminalProvider 等
|   |   |-- constants.ts
|   |   |-- schemas.ts           # zod 校验 + 与 JSON Schema 对齐
|   |   |-- transport.ts         # transport.ping/pong 等传输层消息
|   |   |-- webrtc.ts            # tunnel.upgrade.* 与 IceServerConfig
|   |-- tests/
|   |   |-- contract.test.ts
|-- e2e-noise/
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- index.ts             # Noise 握手、加解密、seq 防重放
|   |-- tests/
|   |   |-- noise.test.ts
|-- relay-client/
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- index.ts             # 可被 App/电脑 复用的 Relay 客户端核心
|-- terminal-core/
|   |-- package.json
|   |-- tsconfig.json
|   |-- src/
|   |   |-- index.ts             # 终端输入、快捷键、frame 合并等纯 TS 逻辑
```

说明：

- `protocol-ts/`：跨端协议的 TypeScript 类型与 zod 运行时校验，包括 E2E、升级链路的 `tunnel.upgrade.*` / `transport.*`。运行 `pnpm --filter @omniwork/protocol-ts test` 校验契约。
- `e2e-noise/`：App-Agent Noise E2E 握手、加解密、seq 防重放和篡改检测。运行 `pnpm --filter @omniwork/e2e-noise test` 校验安全基础能力。
- `relay-client/`：可被 `app/` 和 `desktop/` 复用的 Relay 客户端核心。
- `terminal-core/`：终端输入、快捷键、frame 合并等纯 TS 逻辑。

依赖原则：

- 桌面端 Agent 依赖 `protocol-ts`、`e2e-noise`、`relay-client`、`terminal-core`。
- App 依赖 `protocol-ts`、`e2e-noise`、`relay-client`、`terminal-core`。
- Relay（TS）依赖 `protocol-ts`；Go/Rust Relay 则从 `protocol/` 生成本语言类型。
- 跨语言共享走 `protocol/`，不是走 TS 包。

> 暂未规划入仓库的共享包：`mobile-ui`（RN 通用 UI 组件）、`config`、`eslint-config`、`tsconfig`。不预先创建，避免过度抽象。

## scripts 目录

`scripts/` 放跨端开发与验证脚本。真实结构：

```text
scripts/
|-- verify/
|   |-- app-key-proof.test.mjs       # App 端 HMAC proof 单元验证
|   |-- desktop-agent-key.sh             # Agent key 文件权限/格式自检
|   |-- mobile-upgrade-simulator.mjs # 模拟手机端跑通 P2P 升级全流程
|   |-- package-boundaries.mjs       # package 边界自检
|-- deploy/
|   |-- buildWebDeploy.mjs           # Web SPA 部署目录准备
```

根 `package.json` 中暴露的相关 npm scripts：

- `verify:app-auth`、`verify:app:targets`、`verify:app:web`、`verify:app:bundle:ios`、`verify:app:bundle:android`
- `verify:relay`
- `verify:desktop-key`
- `verify:upgrade:simulator`
- `verify:package-boundaries`
- `verify:security`
- `deploy:web:build`、`deploy:web:prepare`

> P2P 升级 e2e 验证脚本是 mobile simulator：需要先启动真实 Relay 与 桌面端 Agent，再运行 `pnpm verify:upgrade:simulator -- --relay ws://127.0.0.1:8787/relay/ws/mobile --device <id> --key <KEY> --key-id <KEY_ID>`。安全基础验证运行 `pnpm verify:security`，等价于 `@omniwork/e2e-noise` 测试。

可补：

```text
scripts/
|-- dev/                # start-app / start-relay / start-desktop-agent 一键脚本
|-- generate/           # protocol / openapi codegen
|-- package/            # desktop-agent / app 打包脚本
```

原则：

- 脚本只编排命令，不隐藏复杂业务逻辑。
- 脚本应可在 CI 中运行。
- 不在脚本中写死个人路径。
- 需要公司环境的脚本提供 `.example` 配置。

## docs 目录

`docs/` 保存项目知识。已存在的文档：

```text
docs/
|-- README.md                              # 文档入口与推荐阅读顺序
|-- engineering-requirements.md
|-- auth-key-design.md
|-- app-installation.md
|-- deployment-web-server.md
|-- e2e-noise-roadmap.md
|-- mobile-file-editing.md
|-- mobile-codex-tui-workbench-design.md
|-- mobile-codex-tui-technical-solution.md
|-- p2p-per-app-connection.md
|-- relay-architecture.md
|-- relay-architecture-implementation.md
|-- project-directory-structure.md
```

原则：

- 设计结论放在 docs 根目录。
- 历史探索或废弃方案应直接移除，避免继续影响架构判断。
- 协议变化需要同步更新 `packages/protocol-ts` 与（如有）`relay-architecture.md`、`auth-key-design.md`。
- 任何代码改动都必须同步检查并更新相关文档。

## 规划中目录

以下顶层目录在企业化能力按需补齐，不预先创建：

- `infra/`：环境、部署、证书、观测配置（`local/`、`k8s/`、`terraform/`、`certs/`、`observability/`、`mdm/`）。
- `tests/`：跨端 e2e 与安全测试（`contract/`、`e2e/`、`security/`、`fixtures/`）。
- `tools/`：协议 lint、终端 frame 回放、Relay 压测、Codex 事件录制等一次性辅助工具。
- `fixtures/`：脱敏样例（terminal/codex/auth）。

跨端必测场景（规划纳入 `tests/e2e/` 与 `tests/security/`）：

- 手机连接 Relay。
- 桌面端 Agent 注册 Relay。
- App 使用正确临时 key 可以连接。
- App 使用错误临时 key 不能连接。
- 创建 Codex/Claude/Gemini TUI 会话。
- 切换多个会话。
- 手机断线后 电脑 会话继续。
- 手机重连后恢复终端快照。
- Agent 重启后恢复 tmux 会话，并且持久化的 key 仍然可用。
- 慢连接不会导致内存无限增长。
- P2P 升级在 rollout 灰度、blocklist 命中、ICE 失败、健康降级、重协商等路径下行为符合预期。

## 配置文件规划

根目录已有：

```text
package.json              # JS workspace 编排（含 verify:* 脚本）
pnpm-workspace.yaml       # 覆盖 app / desktop/agent / relay/* / packages/*
tsconfig.base.json        # 共享 tsconfig
AGENTS.md                 # Agent 工作准则
README.md
```

演进按需补：`Makefile` 或 `justfile`、`.editorconfig`、`.env.example`。

注意：

- 根目录配置只做编排，不承载单端业务逻辑。
- `app/` 有自己的 TypeScript 配置。
- `desktop/agent` 有自己的 TypeScript 配置。
- `relay/server` 有自己的 TypeScript 配置；如改用 Go/Rust 重写，可保留独立构建入口由根脚本编排。

## 依赖方向

实际依赖方向：

```text
app       --> packages/protocol-ts
app       --> packages/e2e-noise
app       --> packages/relay-client
app       --> packages/terminal-core

desktop       --> packages/protocol-ts
desktop       --> packages/e2e-noise
desktop       --> packages/relay-client
desktop       --> packages/terminal-core

relay     --> packages/protocol-ts        # TS 实现
relay     --> protocol/*.schema.json      # 跨语言契约（可选 Go/Rust）

app       --> relay API
desktop       --> relay API
relay     --> protocol schemas

app       -X-> desktop internal code
desktop       -X-> app internal code
relay     -X-> app/desktop internal code
```

核心原则：

- `app` 和 `mac` 不直接互相 import。
- `app` 和 `mac` 可以共享 `packages/` 中的纯 TypeScript SDK 与纯逻辑。
- `app` 不依赖 `desktop/agent` 内部模块。
- `mac` 不依赖 `app/src` 内部模块。
- `relay` 不依赖 app/desktop 内部实现。
- 三端通过 `protocol/` 与 Relay API 通信。
- 任何跨端字段变化先改 `packages/protocol-ts` 与（如有）`protocol/*.schema.json`。

## MVP 最小目录

MVP 不需要一次性创建所有目录。MVP 覆盖：

```text
OmniWork/
|-- app/
|-- desktop/
|-- relay/
|-- protocol/
|-- packages/
|-- scripts/
|-- docs/
```

其中：

- `app/` 已实现 React Native 跨端 App + Native WebView/xterm 终端页 + 文件/git 视图 + 配对扫码。
- `desktop/agent` 已实现 TypeScript / Node.js Agent，含 runtime 抽象、tmux/PTY、文件/git、auth-key、P2P 升级。
- `relay/server` 已实现 WSS 转发 + auth + P2P 升级编排 + `/metrics` `/debug/upgrade`。
- `protocol/` + `packages/protocol-ts` 维护 envelope、auth、E2E、session、terminal、Codex 与升级链路消息。
- `packages/e2e-noise` 维护 App-Agent Noise E2E 握手、加解密、seq 防重放与篡改检测。

## 从 MVP 到企业版的演进

### 已落地能力（MVP + P2P 升级）

目录重点：

```text
app/src/{app,features,lib,platform,screens,terminal,ui}/
desktop/agent/src/{agentd,core,relay-client,transport,runtime,pty-bridge,tmux-manager,session-store,workspace,files,git,pairing,auth-key,keychain,telemetry,config,protocol}/
relay/server/src/{relayServer.ts,upgrade/orchestrator.ts}
packages/{protocol-ts,relay-client,terminal-core}
```

目标已达成：

- 打通手机到 电脑 Codex/Claude/Gemini TUI。
- 支持多会话与文件/git 浏览。
- 支持断线重连。
- 支持 Relay → P2P 直连升级、灰度、退避与降级。

### 企业化能力

目录重点（待补）：

```text
desktop/macos/
desktop/native/
relay/internal/{auth,audit,policy,notifications}
infra/
tests/security/
```

目标：

- 临时 key 文件权限的端到端审计。
- key proof 失败限流的红线测试。
- Relay 不记录完整 key。
- LaunchAgent / 公证 / 签名。
- 审计与告警。
- Keychain 持久凭证能力。

### 结构化 Codex 能力

目录重点（待补）：

```text
desktop/agent/src/agent-surface/codex/
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
- 桌面端目录叫 `desktop/`，不再局限于 电脑，以支持未来更多平台。
- 中继目录叫 `relay/`，不是 `server/`，强调它只做中继、鉴权、路由和审计。
- 跨端契约叫 `protocol/`，不是 `shared/`，避免被塞进杂物。
- TypeScript 共享包叫 `packages/`，服务 `app/` 和 `desktop/agent` 的 JS/TS 生态。

## 不建议的结构

不建议：

```text
src/
|-- app/
|-- desktop/
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

- 本项目不是简单 C/S 架构，而是手机端、桌面端 Agent、Relay 三方系统。

不建议：

```text
shared/
```

原因：

- `shared` 容易变成没有边界的杂物目录。
- 跨端共享应优先走 `protocol/` 与 `packages/`。

不建议：

```text
remote-control/
```

原因：

- 会弱化本项目「Codex TUI 专用工作台」的合规边界。

## 目录治理规则

- 新增跨端字段，先改 `packages/protocol-ts` 与（如属于跨语言契约）`protocol/*.schema.json`。
- 新增手机业务能力，放 `app/src/features/` 或新增 `app/src/screens/`。
- 新增 电脑 本地能力，优先放 `desktop/agent/src/` 的对应模块。
- 新增 Relay 能力，放 `relay/server/src/` 对应文件，可选 Go/Rust 重写时按 `relay/internal/` 切分领域。
- 生成代码（如codegen 产物）只放 `generated/`，不手改。
- 临时验证代码放 `scripts/verify/` 或规划中的 `tools/`，不能被生产路径依赖。
- 真实 secret、临时 key、token、证书不进入仓库。
- 任何代码改动都必须同步检查并更新相关文档（见 `AGENTS.md`）。

## 推荐落地顺序

1. 维护 `protocol/` 与 `packages/protocol-ts`，所有协议变更先在这里落地。
2. 维护 `relay/server/`，对齐 `OMNIWORK_UPGRADE_*` 等环境变量与 `/metrics` `/debug/upgrade` 调试面。
3. 维护 `desktop/agent/src/transport/`，与 App 端 `app/src/lib/transport/` 保持对称（升级状态机、降级路径）。
4. 业务能力新增按"protocol-ts → desktop/agent → app"依赖顺序落地，避免单端漂移。
5. 企业化能力补 `desktop/macos/`、`desktop/native/`、`infra/`、`tests/`。
6. 接入 Codex app-server 时补 `protocol/codex/`、`desktop/agent/src/agent-surface/codex/`、`app/src/features/codex-structured/`。

## 最终建议

本项目核心目录：

```text
app/       # Android/iOS/Web 共用的 React Native App
desktop/       # TypeScript 桌面端 Agent
relay/     # 公司内网中继（含 P2P 升级编排）
protocol/  # 跨端 JSON Schema 契约
packages/  # TS 共享包（protocol-ts / relay-client / terminal-core）
scripts/   # 验证与开发脚本
docs/      # 项目设计文档
```

这个结构能保证 app 和 desktop 都在同一工程下，同时保留 Relay、协议、安全和企业部署的清晰边界。演进按"规划中目录"小节按需补齐，避免预先创建空目录。
