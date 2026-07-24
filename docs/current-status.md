# 当前实现状态

本文只记录仓库当前代码和测试能够证明的能力。设计目标与后续规划不能覆盖本文；发生冲突时，以代码、测试和运行配置为准。

## 当前版本与交付

- 仓库版本：`0.1.1`。
- 已配置并验证 npm 发布：`@omni-work/desktop-agent`、`@omni-work/relay-server`、`@omni-work/web-app` 及共享协议、传输、安全和 hook 包。
- Desktop Agent 与 Relay Server 要求 Node.js `>=22.6.0`；Desktop Agent 还要求本机安装 `tmux`。
- Android、iOS 和 Web 客户端均可从源码构建。仓库内当前没有能够证明已上架 App Store 或已上传 GitHub Release 的移动端安装包，因此公开站点不得把占位链接写成可用下载。

## App / Web

- React Native CLI 代码同时覆盖 iOS、Android 和 `react-native-web`。
- 支持手动、二维码和配对链接导入；Web 不扫描二维码。
- 以 Workspace 组织 Sessions、Git 和 Files，支持受限 UTF-8 文本编辑、写入冲突检测、只读 Git status/diff。
- 支持配置化 Terminal Provider、tmux 会话创建/重命名/关闭及 xterm 终端交互。
- 支持 Codex `app_server` 结构化会话的基础对话与活动时间线；审批回答、完整 diff 详情等能力尚未接入。
- 支持 Agent 消息收件箱、已读/已处理状态和通知偏好；平台原生 Push gateway 尚未接入。
- 支持中英文界面、终端字号和 Relay/P2P 连接偏好。
- Native App 支持手势应用锁与自动锁定；Web 不持久化应用锁配置。

## Desktop Agent

- 每次启动生成 32 字符临时 key，用于 App-Agent 配对 proof 和 Noise PSK。
- 支持 YAML 配置、Relay 重连、tmux 会话、Workspace 发现、文件/Git 请求和终端 snapshot/stream。
- Terminal Provider 默认包含 Codex、Claude、Gemini、Trae 和 Trae CN，也可通过配置添加其他 CLI provider。
- Codex 可通过 `@openai/codex-sdk` 驱动基础结构化会话。
- Codex、Claude Code、Trae 和 Trae CN 已接入本机 hook Probe；OpenCode、Gemini 的 Probe 仍是扩展方向。
- Probe 事件可进入本地 SQLite inbox，并向在线 App 发送 E2E `agent.message`；系统 Push 尚未实现。

## Relay 与传输

- 支持临时 key challenge/proof、失败限流、WebSocket keepalive、按 App connection 隔离的 Noise E2E 会话。
- 支持 Relay path 与 WebRTC P2P 升级、三种传输偏好、严格 P2P、降级/退避和 metrics。
- 可选 `email_link` 用户登录、设备登记/撤销及 Ed25519 Agent 设备身份；默认 `auth.mode=none`。
- Admin API、Admin Web、metrics 和 debug 接口属于受控运维面，不属于 Public Web。
- 默认业务模式要求 E2E；只有 Agent 显式配置 `requireE2e: false` 时才允许兼容明文业务模式。

## 验证入口

```sh
pnpm typecheck
pnpm test
pnpm verify:npm-packages
pnpm verify:package-boundaries
pnpm site:build
pnpm verify:app:targets
```

原生 bundle/build 与 P2P simulator 还依赖对应平台工具链或正在运行的 Relay/Agent，不能仅凭静态仓库状态视为已完成发布验收。
