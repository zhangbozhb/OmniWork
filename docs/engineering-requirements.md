# 工程要求

关联文档：

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [project-directory-structure.md](./project-directory-structure.md)
- [auth-key-design.md](./auth-key-design.md)
- [app-installation.md](./app-installation.md)

## 总体要求

本工程采用 monorepo，手机 App、Mac Agent、Relay、协议、共享 SDK、部署材料都在同一个仓库下维护。

核心工程约束：

- `app/` 是 Android/iOS 跨端移动 App。
- `mac/` 是 TypeScript / Node.js 技术栈的 Mac 本地 Agent。
- `relay/` 是公司内网中继服务，可根据团队能力选择 Go、Rust 或 TypeScript。
- `protocol/` 是跨端协议契约唯一源头。
- `packages/` 存放可被 App 和 Mac Agent 复用的 TypeScript SDK 与纯逻辑。

## App 工程要求

`app/` 必须同时适配 Android 和 iOS，最终交付 APK 和 IPA 安装包；不得以网页、PWA 或浏览器入口作为主交付形态。

推荐技术栈：

- React Native。
- React Native CLI。
- TypeScript。
- React Native 原生终端快照视图。

安装交付要求：

- Android 使用 Gradle 产出可安装 APK。
- iOS 使用 Xcode / `xcodebuild` 产出可安装 IPA。
- 本地开发支持 `react-native run-android` 和 `react-native run-ios`。
- bundle id / package name 必须可通过环境变量覆盖。
- 默认要求 Relay 使用 `wss://`，Android 禁止明文流量。

交互实现要求：

- 原始 Codex TUI 快照先使用 React Native 原生组件渲染。
- MVP 不引入 PWA 或网页壳。
- 如后续确实需要完整 ANSI 行为，再以可替换的原生 terminal renderer 的方式引入。
- 结构化 Codex UI 使用 React Native 原生组件实现。
- 快捷键、复制粘贴、横屏、缩放、输入法适配属于 App 的核心体验。
- 推送通知使用 APNs / FCM 或公司统一推送网关。

安全要求：

- 当前阶段不接入 SSO。
- App 使用 Mac Agent 当前启动生成的 32 字符临时 key 完成连接鉴权。
- key 不得存入普通明文存储。
- App 不得加载远程网页作为主界面。
- 当前路线不使用 WebView 承载终端或主界面。
- 终端剪贴板能力默认受限，OSC 52 等能力需要显式策略控制。

## Mac Agent 工程要求

`mac/` 必须采用 TypeScript / Node.js 技术栈。

推荐技术栈：

- Node.js LTS。
- TypeScript。
- node-pty。
- tmux。
- SQLite。
- 临时 key 文件存储。
- macOS Keychain adapter 只作为后续长期凭证能力预留。
- WebSocket Relay client。

当前工程已补齐 `relay/server` 的 TypeScript MVP，用于 App 与 Mac Agent 的公司内网消息中继；正式生产可继续替换为公司统一 Relay 平台，但协议和鉴权流程保持一致。

实现要求：

- Agent 业务逻辑必须写在 TypeScript 中。
- PTY 能力统一封装在 `pty-bridge` 模块。
- tmux 能力统一封装在 `tmux-manager` 模块。
- Codex app-server 能力统一封装在 `codex-runtime` 模块。
- Relay 连接统一封装在 `relay-client` 模块。
- 本地会话状态统一封装在 `session-store` 模块。
- 临时 key 文件读写统一封装在 `auth-key` 模块。
- Keychain 操作保留为后续能力，当前 MVP 不作为登录依赖。

macOS 集成要求：

- Agent 默认不监听局域网地址。
- Agent 只主动连接公司内网 Relay。
- Agent 每次启动必须生成新的 32 字符随机 key。
- 临时 key 必须写入 `~/Library/Application Support/OmniWork/agent/session-key.json`。
- key 文件权限必须为 `0600`，目录权限必须为 `0700`。
- 自启动使用 LaunchAgent / SMAppService 方向。
- 分发包需要固定 Node runtime，不能依赖用户机器上的全局 Node。
- 签名、公证、LaunchAgent、可选 Menu Bar 只作为平台集成，不承载 Agent 业务逻辑。

## 登录与鉴权要求

当前阶段不使用 SSO、OIDC、长期设备绑定或 refresh token。

MVP 鉴权模型：

- Mac Agent 是 key 来源。
- Mac Agent 每次启动临时生成一个固定 32 字符长度的随机字符串作为 key。
- key 使用加密安全随机数生成器。
- key 保存到 Mac 本地文件。
- App 通过手动输入、扫码或后续本机展示方式获得 key。
- App 使用该 key 完成本次连接授权。
- Mac Agent 重启后旧 key 失效，App 需要重新输入新 key。

推荐连接校验：

- Relay 下发 nonce。
- App 用 key 对 nonce 做 HMAC-SHA256。
- Mac Agent 用本地 key 校验 proof。
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
- `app/` 和 `mac/` 优先复用同一套 TypeScript 协议类型。
- Relay 如使用 Go/Rust，也从 `protocol/` 生成对应语言类型。
- 生成代码只放 `generated/`，不得手工修改。
- 协议破坏性变更必须升级版本并补 contract test。

## 共享包要求

`packages/` 只放纯 TypeScript 共享能力。

允许：

- `protocol-ts`。
- `relay-client`。
- `terminal-core`。
- `config`。
- `mobile-ui`。

限制：

- `mac/agent` 可以依赖 `protocol-ts`、`relay-client`、`terminal-core`、`config`。
- `mac/agent` 不依赖 `mobile-ui`。
- `app/` 不依赖 `mac/agent` 内部模块。
- `mac/` 不依赖 `app/src` 内部模块。
- Relay 不依赖 App/Mac 内部实现。

## 验证要求

MVP 阶段至少验证：

- Android App 可连接 Relay。
- iOS App 可连接 Relay。
- Mac Agent 可连接 Relay。
- Mac Agent 可创建 `tmux + codex` 会话。
- App 可查看原始 TUI。
- App 可输入文字、回车、方向键、`Esc`、`Tab`、`Ctrl+C`。
- App 可切换至少 3 个 TUI 会话。
- App 断开后 Mac 会话继续运行。
- App 重连后恢复终端快照。
- Agent 重启后恢复已有 tmux 会话。

企业化阶段至少验证：

- Mac Agent 每次启动生成 32 字符临时 key。
- key 文件路径、权限和内容格式正确。
- App 使用正确 key 可连接。
- App 使用错误 key 不能连接。
- Mac Agent 重启后旧 key 失效。
- Relay 不记录完整 key。
- LaunchAgent 自启动。
- 审计日志。
- Android/iOS 推送通知。
- 慢连接 backpressure。
