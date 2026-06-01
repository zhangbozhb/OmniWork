# OmniWork 文档入口

本目录保存项目知识。阅读时优先以代码和下列“实现事实”文档为准；规划文档与设计方案用于理解背景，不应覆盖已经落地的实现事实。

## 推荐阅读顺序

1. [project-directory-structure.md](./project-directory-structure.md)：目录结构、模块边界、依赖方向与 MVP 状态。
2. [engineering-requirements.md](./engineering-requirements.md)：工程、安全、协议、传输与验证要求。
3. [relay-architecture.md](./relay-architecture.md)：Relay、P2P、E2E、metrics 与调试 runbook 的架构事实。
4. [app-installation.md](./app-installation.md)：Android / iOS / Web 构建、签名、安装与环境变量。

## 实现事实

- [project-directory-structure.md](./project-directory-structure.md)：仓库结构、包边界、脚本、MVP 覆盖。
- [engineering-requirements.md](./engineering-requirements.md)：工程约束、协议要求、验证要求。
- [relay-architecture-implementation.md](./relay-architecture-implementation.md)：Relay / P2P / E2E 实现状态与不变量。
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)：多 App 连接下的 per-App P2P 升级粒度。
- [e2e-noise-roadmap.md](./e2e-noise-roadmap.md)：E2E Noise 基线、落地状态和安全边界。

## 安全与交付

- [auth-key-design.md](./auth-key-design.md)：临时 key 生成、文件权限、Relay proof 流程与失败处理。
- [app-installation.md](./app-installation.md)：APK / IPA / Web SPA 构建、签名、安装前检查。

## 方案背景

- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)：产品设计、MVP 目标、非目标和验收口径。
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)：技术方案、风险与演进方向。

## 维护规则

- 代码改动后同步检查相关文档，避免实现与文档漂移。
- 已落地能力优先更新“实现事实”文档，再更新背景方案。
- 废弃或规划性内容应明确标注，不得写成实现。
- 具体 Agent 工作准则见仓库根目录 [AGENTS.md](../AGENTS.md)。
