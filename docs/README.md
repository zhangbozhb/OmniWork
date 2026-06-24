# OmniWork 文档入口

本目录保存项目知识。阅读时优先以代码和下列“实现事实”文档为准；规划文档与设计方案用于理解背景，不应覆盖已经落地的实现事实。

## 推荐阅读顺序

1. [project-directory-structure.md](./project-directory-structure.md)：目录结构、模块边界、依赖方向与 MVP 状态。
2. [engineering-requirements.md](./engineering-requirements.md)：工程、安全、协议、传输与验证要求。
3. [relay-architecture.md](./relay-architecture.md)：Relay、P2P、E2E、metrics 与调试 runbook 的架构事实。
4. [mobile-file-editing.md](./mobile-file-editing.md)：移动端文件编辑边界、CodeMirror 实现与 `files.write` 协议。
5. [app-installation.md](./app-installation.md)：Android / iOS / Web 构建、签名、安装与环境变量。
6. [deployment-web-server.md](./deployment-web-server.md)：生产 Web 路径、Nginx 反代、admin web 启用策略。
7. [release-downloads.md](./release-downloads.md)：GitHub Release 资产命名、校验文件和下载页清单更新。

## 实现事实

- [project-directory-structure.md](./project-directory-structure.md)：仓库结构、包边界、脚本、MVP 覆盖。
- [engineering-requirements.md](./engineering-requirements.md)：工程约束、协议要求、验证要求。
- [relay-architecture-implementation.md](./relay-architecture-implementation.md)：Relay / P2P / E2E 实现状态与不变量。
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)：多 App 连接下的 per-App P2P 升级粒度。
- [e2e-noise-roadmap.md](./e2e-noise-roadmap.md)：E2E Noise 基线、落地状态和安全边界。
- [mobile-file-editing.md](./mobile-file-editing.md)：移动端文件编辑实现、冲突检测与安全边界。

## 安全与交付

- [auth-key-design.md](./auth-key-design.md)：临时 key 生成、文件权限、Relay proof 流程与失败处理。
- [app-installation.md](./app-installation.md)：APK / IPA / Web SPA 构建、签名、安装前检查。
- [release-downloads.md](./release-downloads.md)：下载资产命名、SHA256 校验与 `downloads.json` 自动更新。
- [deployment-web-server.md](./deployment-web-server.md)：Nginx 静态站点、Relay 反代、Admin Web 生产/开发策略。

## 方案背景

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)：产品设计、MVP 目标、非目标和验收口径。
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)：技术方案、风险与演进方向。
- [agent-probe-sink-design.md](./agent-probe-sink-design.md)：Codex、Claude Code 等 coding agent 的 Probe/Sink 消息感知、过滤与多端投递设计。

## 长期架构边界

后续功能建设统一按以下模型理解，避免把 tmux、Codex、workspace 和 session 混成同一层概念：

- `Workspace`：工作目录 / repo / 项目上下文，不代表具体交互形态。
- `WorkSession`：一次可恢复的工作单元，关联一个 workspace，可挂载多个 surface。
- `Surface`：用户交互入口，例如 `TerminalSurface`、`AgentSurface`、文件和 diff surface。
- `RuntimeBinding`：surface 背后的本机实现绑定，例如 tmux session、PTY、Codex app-server thread、Claude Code 协议实例。

`tmux`、PTY、shell，以及运行在 tmux 中的 Codex / Claude Code TUI 都属于终端类 surface。只有存在 app-server 或等价结构化协议绑定时，才创建 Agent 类 surface。Agent 类 surface 不替代终端类 surface；结构化通道失效时应降级回终端类 surface。

## 维护规则

- 代码改动后同步检查相关文档，避免实现与文档漂移。
- 已落地能力优先更新“实现事实”文档，再更新背景方案。
- 废弃或规划性内容应明确标注，不得写成实现。
- 具体 Agent 工作准则见仓库根目录 [AGENTS.md](../AGENTS.md)。
