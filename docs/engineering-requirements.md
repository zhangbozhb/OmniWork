# 工程要求

关联文档：

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [project-directory-structure.md](./project-directory-structure.md)
- [identity-auth-design.md](./identity-auth-design.md)
- [app-installation.md](./app-installation.md)
- [relay-architecture.md](./relay-architecture.md)
- [relay-architecture-implementation.md](./relay-architecture-implementation.md)

## 总体要求

本工程采用 monorepo，手机 App、桌面端 Agent、Relay、协议、共享 SDK、部署材料都在同一个仓库下维护。

核心工程约束：

- `app/` 是 Android/iOS 跨端移动 App。
- `desktop/` 是 TypeScript / Node.js 技术栈的 电脑 本地 Agent。
- `relay/` 是公司内网中继服务，可根据团队能力选择 Go、Rust 或 TypeScript。
- `protocol/` 是跨端协议契约唯一源头。
- `packages/` 存放可被 App 和 桌面端 Agent 复用的 TypeScript SDK 与纯逻辑。

## App 工程要求

`app/` 必须同时适配 Android 和 iOS，最终交付 APK 和 IPA 安装包；不得以网页、PWA 或浏览器入口作为主交付形态。

推荐技术栈：

- React Native。
- React Native CLI。
- TypeScript。
- React Native 主界面；TUI 兼容通道使用 Native WebView/xterm 终端视图。

安装交付要求：

- Android 使用 Gradle 产出可安装 APK。
- iOS 使用 Xcode / `xcodebuild` 产出可安装 IPA。
- 本地开发支持 `react-native run-android` 和 `react-native run-ios`。
- bundle id / package name 必须可通过环境变量覆盖。
- Relay 允许使用 `ws://` 或 `wss://`；业务安全边界必须是 App-Agent E2E 加密，Android 可允许明文传输以支持公网 IP Relay。

交互实现要求：

- 原始 Codex TUI 使用 Native WebView/xterm 终端视图渲染，WebView 只作为终端兼容渲染容器，不承载主界面。
- MVP 不引入 PWA 或网页壳。
- 如演进确实需要完整 ANSI 行为，再以可替换的原生 terminal renderer 的方式引入。
- 结构化 Codex UI 使用 React Native 原生组件实现。
- 快捷键、复制粘贴、横屏、缩放、输入法适配属于 App 的核心体验。
- 推送通知使用 APNs / FCM 或公司统一推送网关。

安全要求：

- MVP 范围不接入 SSO。
- App 和 Agent 首次使用时生成长期 Ed25519 身份，后续复用。
- App 私钥使用系统 Keychain/Keystore 或 WebCrypto 不可导出密钥存储。
- App ID 和 Device ID 必须由对应公钥派生并包含校验位。
- Desktop Agent 默认使用 `manual` 授权，未知 App 必须由本机管理员明确批准；
  显式 `automatic` 模式仍须先验证身份签名、连接绑定和 scope。
- App 不得加载远程网页作为主界面；移动端主交付必须是 React Native APK/IPA，native 体验优先于 Web 实验入口。
- 终端 WebView 只能加载本地打包的 xterm HTML/CSS/JS 资源，不得在运行时依赖 CDN 或远程网页。
- 终端剪贴板能力默认受限，OSC 52 等能力需要显式策略控制。

## 桌面端 Agent 工程要求

`desktop/` 必须采用 TypeScript / Node.js 技术栈。

推荐技术栈：

- Node.js LTS。
- TypeScript。
- tmux。
- 会话状态使用 SQLite，默认文件为 `sessions.sqlite`；旧 `sessions.json` 仅作为首次导入来源，显式传入 `.json` 存储路径时会自动映射到同名 `.sqlite`。
- 长期 Ed25519 身份存储；macOS Keychain 可用时优先使用，文件镜像权限为
  `0600`。
- 独立本地 Probe token 存储，不得复用身份私钥或 App-Agent 会话材料。
- WebSocket Relay client。

本工程已补齐 `relay/server` 的 TypeScript MVP，用于 App 与 桌面端 Agent 的公司内网消息中继；正式生产可继续替换为公司统一 Relay 平台，但协议和鉴权流程保持一致。

Relay 安全约束（`relay/server`）：

- 监听非 loopback 地址并使用明文 `ws://` 时必须显式声明 `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true`。
- `wss://` 仍推荐用于降低网络侧元数据暴露；业务安全边界固定由
  App-Agent E2E 维护，协议不提供业务明文模式。
- Relay 只校验身份、挑战、连接状态和路由，不持有 App/Agent 私钥，不解密
  `e2e.message`。
- `auth.proof` 失败按 `(device_id, remote_ip)` 维度做 token bucket 限流，参数由 `OMNIWORK_RELAY_AUTH_RATE_CAPACITY`（默认 5）、`OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC`（默认 2）、`OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS`（默认 120000）控制，超额触发 `auth.failed` 且 `reason=too_many_attempts`，详见 [relay/server/README.md](../relay/server/README.md)。

实现要求：

- Agent 业务逻辑必须写在 TypeScript 中。
- PTY 能力统一封装在 `pty-bridge` 模块。
- tmux 能力统一封装在 `tmux-manager` 模块。
- 终端启动入口是配置化 Terminal Provider；演进 Codex app-server 能力落地时统一封装在 AgentSurface 后端模块，不能混入 Terminal Provider。
- Relay 连接统一封装在 `relay-client` 模块。
- 本地会话状态统一封装在 `session-store` 模块。
- Agent 身份文件读写统一封装在 `config/deviceIdentity.ts`。
- App 信任记录统一封装在 `config/trustedAppStore.ts`。
- Probe token 读写统一封装在 `config/probeToken.ts`。

电脑系统 集成要求：

- Agent 默认不监听局域网地址。
- Agent 只主动连接公司内网 Relay。
- Agent 首次启动生成 Ed25519 身份，后续启动必须复用。
- 默认身份文件为
  `~/Library/Application Support/OmniWork/agent/identity-v2.json`。
- 身份文件权限必须为 `0600`，目录权限必须为 `0700`；损坏时拒绝启动，
  不得静默轮换身份。
- 自启动使用 LaunchAgent / SMAppService 方向。
- 分发包需要固定 Node runtime，不能依赖用户机器上的全局 Node。
- 签名、公证、LaunchAgent、可选 Menu Bar 只作为平台集成，不承载 Agent 业务逻辑。

## 登录与鉴权要求

MVP 范围不使用 SSO、OIDC 或 refresh token。鉴权模型：

- Agent 与 App 分别持有长期 Ed25519 身份。
- Relay 设备登记接收 Agent 派生 ID 与公钥，不生成设备 ID。
- Relay 对 Agent 提供 `manual` / `automatic` 两种授权模式，默认
  `manual`；人工模式必须由 Relay Admin 批准新 device ID，自动模式仅在
  device ID 和来源 IP 均未封禁时自动批准。
- Agent 授权记录必须持久化；设备禁用与 IP ban 始终优先。
- Agent 配对二维码与 App 分享二维码只携带 Relay URL、目标 Agent device ID
  和可选显示名称，不携带公钥或授权凭证。
- App 在 `mobile.connect` 中自动携带自己的 App ID、公钥和设备/App 元数据；
  Relay 在 `auth.challenge` 中返回在线 Agent 的登记公钥。
- App 对 `auth.proof` 签名；Agent 对 `auth.ok` 签名，双方校验 ID 与公钥
  绑定。
- Desktop Agent 对未知 App 提供 `manual` / `automatic` 两种授权模式，默认
  `manual`；人工模式进入 `auth.pending` 并等待本机管理员批准，自动模式只能在
  App 身份签名、连接绑定和 scope 校验通过后持久化信任并建立连接。
- 批准记录按 App ID、公钥和 scope 持久化；撤销后立即终止在线连接。
- 双向认证完成后，以签名临时 X25519 + HKDF-SHA256 建立
  ChaCha20-Poly1305 会话。
- 所有业务消息封装在 `e2e.message` 中，不得降级。

安全要求：

- 日志和审计只记录身份 ID、连接 ID 和失败原因，不得记录私钥、
  Probe token 或业务明文。
- Relay 对认证失败做限流。
- 身份丢失等同于新设备，必须重新登记或批准。

## 协议要求

跨端通信必须由 `packages/protocol-ts` 定义；`protocol/` 同步维护需要提供给
跨语言实现的 JSON Schema 子集。

要求：

- 先在 `packages/protocol-ts` 定义 TypeScript 类型和 zod 运行时 schema。
- `app/`、`desktop/agent` 与当前 TypeScript Relay 复用同一套协议类型。
- `protocol/` 已覆盖的 envelope、auth、session 与 terminal 契约必须同步；Relay
  如改用 Go/Rust，可从该 JSON Schema 子集生成对应语言类型。
- 生成代码只放 `generated/`，不得手工修改。
- 协议破坏性变更必须升级版本并补 contract test。
- `packages/protocol-ts/src/schemas.ts` 提供 envelope、`auth.*`、`terminal.*`、`session.*` 等关键报文的 zod schema 作为运行时校验来源；消息类型按 connection、E2E、session、workspace、terminal、agent、transport 领域集中在 `messageTypes.ts`，TypeScript 联合类型和 zod enum 必须从该注册表派生。常量（如 `PROTOCOL_VERSION`、`SUPPORTED_SESSION_STATUSES`、pairing link scheme/host）集中维护在 `packages/protocol-ts/src/constants.ts`。会话字段清单 `SESSION_FIELDS` / `SESSION_REQUIRED_FIELDS` 定义在 `index.ts`，与 `protocol/sessions/session.schema.json` 由 contract test 强制对账。
- `packages/protocol-ts/tests/contract.test.ts` 是协议契约测试，通过 `pnpm --filter @omni-work/protocol-ts test` 运行；新增/调整字段或取值集合时必须同步补充正反例。

## 传输与升级要求

业务消息默认走 Relay WS；P2P（WebRTC DataChannel）作为可选优选路径，由 Relay 协调升级、双端按需降级。详细架构以 [relay-architecture.md](./relay-architecture.md) 为单一来源。

能力关系上，P2P 传输与 App-Agent E2E 均已落地；Relay / P2P 两条路径复用
同一签名 X25519 会话。P2P 只负责路径优化，不单独承担业务安全边界。

App 与 Desktop 的平台 adapter 必须复用 `@omni-work/protocol-ts` 导出的升级状态转移、严格控制消息判定和传输健康策略；平台层只维护 Relay/WebRTC 接线、后台生命周期等运行时差异，不得复制阈值或另行定义升级状态迁移。

依赖与运行时：

- 桌面端 Agent：`@roamhq/wrtc`（Node 端 WebRTC 实现）；运行时为 Node.js 24 + `--experimental-strip-types`。
- App（React Native）：`react-native-webrtc`；iOS 需 `pod install`，Android 需 `INTERNET` 权限。
- App（react-native-web）：使用浏览器原生 `RTCPeerConnection`；若 WebRTC API 缺失，`peerFactory` 返回 null 并按连接模式回退或失败。

Relay 升级控制面环境变量（默认值与含义见 [relay/server/README.md](../relay/server/README.md) 与 [relay-architecture.md §5](./relay-architecture.md)）：

- `OMNIWORK_UPGRADE_ENABLED`
- `OMNIWORK_UPGRADE_ROLLOUT`
- `OMNIWORK_UPGRADE_DEVICE_BLOCKLIST`
- `OMNIWORK_UPGRADE_ICE_SERVERS_JSON`
- `OMNIWORK_UPGRADE_PROPOSE_DELAY_MS`
- `OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF`：是否尊重 App `mobile.connect.transport_preference`；默认 `true`，运维回滚为 `false`。详见 [relay-architecture.md §6.1](./relay-architecture.md)。

客户端可观测开关：

- `OMNIWORK_LOG_TRANSPORT=1`：双端打印 transport 详细事件（path_change / ping_timeout / pong_received / downgrade / upgrade_*）。

验证脚本：

- `pnpm verify:relay`：Relay 配置自检。
- `pnpm verify:identity-auth`：验证目标链接不携带身份凭证、角色 ID 从公钥派生，以及 App proof 绑定双方身份和 App 元数据。
- `pnpm verify:agent-authorization`：验证默认人工授权、自动授权、批准持久化，以及 device/IP 封禁优先级。
- `pnpm verify:upgrade:simulator -- --pairing 'omniwork://pair?...'`：连接已启动的 Relay 与 Desktop Agent，用模拟 App 身份跑通本机批准、双向签名认证、签名 X25519 E2E 握手和 P2P 验证链路。也可使用 `--relay <ws-url> --device <DEV1-id>` 手动指定同一目标；`email_link` Relay 可追加 `--session-token <token>`。脚本入口 [scripts/verify/mobile-upgrade-simulator.mjs](../scripts/verify/mobile-upgrade-simulator.mjs)。
- `pnpm verify:security`：依次运行身份认证定向验证、`@omni-work/e2e-noise` 会话安全测试和发布签名 fail-closed 测试。

## 共享包要求

`packages/` 只放纯 TypeScript 共享能力。

允许：

- `protocol-ts`。
- `e2e-noise`。
- `relay-client`。
- `terminal-core`。
- `config`。
- `mobile-ui`。

限制：

- `desktop/agent` 可以依赖 `protocol-ts`、`e2e-noise`、`relay-client`、`terminal-core`、`config`。
- `app/` 可以依赖 `protocol-ts`、`e2e-noise`、`relay-client`、`terminal-core`、`mobile-ui`。
- `desktop/agent` 不依赖 `mobile-ui`。
- `app/` 不依赖 `desktop/agent` 内部模块。
- `desktop/` 不依赖 `app/src` 内部模块。
- Relay 不依赖 App/Desktop 内部实现。

## 验证要求

MVP 范围至少验证：

- Android App 可连接 Relay。
- iOS App 可连接 Relay。
- 桌面端 Agent 可连接 Relay。
- 桌面端 Agent 可创建 `tmux + codex` 会话。
- App 可查看原始 TUI。
- App 可输入文字、回车、方向键、`Esc`、`Tab`、`Ctrl+C`。
- App 可切换至少 3 个 TUI 会话。
- App 断开后 电脑 会话继续运行。
- App 重连后恢复终端快照。
- Agent 重启后恢复已有 tmux 会话。

企业化能力至少验证：

- Agent/App 首次使用时生成长期身份，后续启动复用。
- 身份文件路径、权限和内容格式正确。
- 未批准 App 不能建立业务连接，批准后可以重连。
- App 或 Agent 身份签名错误时连接失败。
- 撤销 App 后在线连接立即失效。
- Relay 不记录或持有私钥。
- LaunchAgent 自启动。
- 审计日志。
- Android/iOS 推送通知。
- 慢连接 backpressure。
