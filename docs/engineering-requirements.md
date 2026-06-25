# 工程要求

关联文档：

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [project-directory-structure.md](./project-directory-structure.md)
- [auth-key-design.md](./auth-key-design.md)
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
- App 使用 桌面端 Agent 启动生成的 32 字符临时 key 完成连接鉴权。
- key 不得存入普通明文存储。
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
- 临时 key 文件存储。
- 电脑系统 Keychain adapter 只作为演进持久凭证能力预留。
- WebSocket Relay client。

本工程已补齐 `relay/server` 的 TypeScript MVP，用于 App 与 桌面端 Agent 的公司内网消息中继；正式生产可继续替换为公司统一 Relay 平台，但协议和鉴权流程保持一致。

Relay 安全约束（`relay/server`）：

- 监听非 loopback 地址并使用明文 `ws://` 时必须显式声明 `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true`。
- Relay 可同时承载 `e2e_required` 与 `plaintext_allowed` Agent；是否封装 `e2e.message` 由目标 Agent 在 `agent.hello` / `auth.ok` 中声明的 `business_security_mode` 决定。
- `wss://` 仍推荐用于降低网络侧元数据暴露；默认业务明文不得依赖 TLS 保护，必须封装在 `e2e.message` 中。只有 Agent 显式配置 `OMNIWORK_AGENT_REQUIRE_E2E=false` 时，才可走明文业务通道。
- `auth.proof` 失败按 `(device_id, remote_ip)` 维度做 token bucket 限流，参数由 `OMNIWORK_RELAY_AUTH_RATE_CAPACITY`（默认 5）、`OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC`（默认 1）、`OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS`（默认 60000）控制，超额触发 `auth.failed` 且 `reason=too_many_attempts`，详见 [relay/server/README.md](../relay/server/README.md)。

实现要求：

- Agent 业务逻辑必须写在 TypeScript 中。
- PTY 能力统一封装在 `pty-bridge` 模块。
- tmux 能力统一封装在 `tmux-manager` 模块。
- 终端启动入口是配置化 Terminal Provider；演进 Codex app-server 能力落地时统一封装在 AgentSurface 后端模块，不能混入 Terminal Provider。
- Relay 连接统一封装在 `relay-client` 模块。
- 本地会话状态统一封装在 `session-store` 模块。
- 临时 key 文件读写统一封装在 `auth-key` 模块。
- Keychain 操作保留为演进能力，MVP 不作为登录依赖。

电脑系统 集成要求：

- Agent 默认不监听局域网地址。
- Agent 只主动连接公司内网 Relay。
- Agent 每次启动必须生成新的 32 字符随机 key。
- 临时 key 必须写入 `~/Library/Application Support/OmniWork/agent/session-key.json`。
- key 文件权限必须为 `0600`，目录权限必须为 `0700`。
- 自启动使用 LaunchAgent / SMAppService 方向。
- 分发包需要固定 Node runtime，不能依赖用户机器上的全局 Node。
- 签名、公证、LaunchAgent、可选 Menu Bar 只作为平台集成，不承载 Agent 业务逻辑。

## 登录与鉴权要求

MVP 范围不使用 SSO、OIDC、持久设备绑定或 refresh token。

MVP 鉴权模型：

- 桌面端 Agent 是 key 来源。
- 桌面端 Agent 每次启动临时生成一个固定 32 字符长度的随机字符串作为 key。
- key 使用加密安全随机数生成器。
- key 保存到 电脑 本地文件。
- App 通过手动输入、扫码或演进本机展示方式获得 key。
- App 使用该 key 完成本次连接授权。
- 桌面端 Agent 重启后旧 key 失效，App 需要重新输入新 key。

推荐连接校验：

- Relay 下发 nonce。
- App 用 key 对 nonce 做 HMAC-SHA256。
- 桌面端 Agent 用本地 key 校验 proof。
- Relay 不保存 key 明文。

安全要求：

- 日志和审计只记录 `key_id`，不得记录完整 key。
- Relay 对认证失败做限流。
- App 认证失败后清理旧 key。
- key 文件不进入仓库、备份样例或测试夹具。

## 协议要求

跨端通信必须通过 `protocol/` 定义。

要求：

- 先定义 schema，再生成 TypeScript 类型。
- `app/` 和 `desktop/` 优先复用同一套 TypeScript 协议类型。
- Relay 如使用 Go/Rust，也从 `protocol/` 生成对应语言类型。
- 生成代码只放 `generated/`，不得手工修改。
- 协议破坏性变更必须升级版本并补 contract test。
- `packages/protocol-ts/src/schemas.ts` 提供 envelope、`auth.*`、`terminal.*`、`session.*` 等关键报文的 zod schema 作为运行时校验来源；常量（如 `PROTOCOL_VERSION`、`SUPPORTED_SESSION_STATUSES`、pairing link scheme/host）集中维护在 `packages/protocol-ts/src/constants.ts`。会话字段清单 `SESSION_FIELDS` / `SESSION_REQUIRED_FIELDS` 定义在 `index.ts`，与 `protocol/sessions/session.schema.json` 由 contract test 强制对账。
- `packages/protocol-ts/tests/contract.test.ts` 是协议契约测试，通过 `pnpm --filter @omniwork/protocol-ts test` 运行；新增/调整字段或取值集合时必须同步补充正反例。

## 传输与升级要求

业务消息默认走 Relay WS；P2P（WebRTC DataChannel）作为可选优选路径，由 Relay 协调升级、双端按需降级。详细架构以 [relay-architecture.md](./relay-architecture.md) 为单一来源。

能力关系上，P2P 传输能力已落地；MVP 范围是在既有 Relay / P2P 两条路径上补齐 App-Agent E2E 加密。E2E 完成后，P2P 仍只是路径优化，不单独承担业务安全边界。

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
- `pnpm verify:desktop-key`：Agent 临时 key 写入与权限校验。
- `pnpm verify:upgrade:simulator -- --relay ws://127.0.0.1:8787/relay/ws/mobile --device <id> --key <KEY> --key-id <KEY_ID>`：连接已启动的 Relay 与 桌面端 Agent，用 mobile simulator 跑通 propose → committed → DataChannel 验证链路。脚本入口 [scripts/verify/mobile-upgrade-simulator.mjs](../scripts/verify/mobile-upgrade-simulator.mjs)。
- `pnpm verify:security`：运行 `@omniwork/e2e-noise` 测试，覆盖 Noise 握手、加解密、seq 防重放和篡改检测。

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

- 桌面端 Agent 每次启动生成 32 字符临时 key。
- key 文件路径、权限和内容格式正确。
- App 使用正确 key 可连接。
- App 使用错误 key 不能连接。
- 桌面端 Agent 重启后旧 key 失效。
- Relay 不记录完整 key。
- LaunchAgent 自启动。
- 审计日志。
- Android/iOS 推送通知。
- 慢连接 backpressure。
