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
- 以 Workspace 组织 Sessions、Git 和 Files，支持受限 UTF-8 文本编辑、写入冲突检测、Git status/diff，以及文件级 stage/unstage。Git 写操作使用严格 E2E 协议和服务端固定参数，只修改 index；discard、commit、push 与 worktree 删除尚未开放。
- 支持配置化 Terminal Provider、tmux 会话创建/重命名/关闭及 xterm 终端交互。
- Git Workspace 创建 Session 时可选择从当前 `HEAD` 创建 Agent 管理的隔离 worktree。Desktop Agent 将 worktree 与 Session 创建作为一个请求处理，并按 `create_action_id` 合并进程内重复请求；如果 worktree 已创建但 Runtime 启动失败，会保留 worktree 并允许同名重试复用，不自动执行删除。
- 创建 session 时会在 Desktop Agent 上递归创建不存在的指定目录；目录创建或访问失败时整次 session 创建失败。
- 支持 Codex、Claude Code 和 TraeX 的结构化会话、增量对话与活动时间线。Desktop Agent 会将 Surface 事件持久化到 SQLite，App 在获取 Session 列表后按 cursor 增量同步，断线重连可恢复已持久化事件。
- 支持结构化命令、文件变更、权限审批和 Agent 提问。Pending Interaction 持久化到 SQLite，App 重连后可恢复；首个有效回答生效，重复 action 幂等返回，冲突回答不覆盖。Desktop Agent 重启后会将遗留 Pending 标记为过期，不会伪恢复已经丢失的 Provider 原生请求句柄。
- Agent Composer 支持从 Session 所属 Workspace 浏览并附加最多 10 个文本文件。App 只发送文件引用，Desktop Agent 在提交 Provider 前重新校验 Session/Workspace、realpath、UTF-8、可选 hash 和 256 KiB 总上下文上限，再注入只读文件快照。
- 支持 Agent 消息收件箱、已读/已处理状态和通知偏好。Pending Interaction 会生成去重且不包含命令正文的高优先级消息，App 连接或重连时同步 Desktop SQLite inbox，并在 Workbench 投影“等待审批/等待输入”状态；平台原生 Push gateway 尚未接入。
- 支持中英文界面、终端字号和 Relay/P2P 连接偏好。
- Git Review 支持对 Diff 行添加 App 本地批注，并将同一轮批注合并发送给同 Workspace 的结构化 Agent；HEAD 变化后旧批注会被标记为过期并禁止发送。
- Native App 支持手势应用锁与自动锁定；Web 不持久化应用锁配置。

## Desktop Agent

- 使用用户配置的合法 32 字符 key，未配置时每次启动自动生成，用于
  App-Agent 配对 proof 和 Noise PSK。
- 支持 YAML 配置、Relay 重连、tmux 会话、Workspace 发现、文件/Git 请求和终端 snapshot/stream。
- Terminal Provider 默认包含 Codex、Claude、Gemini 和 TraeX，也可通过配置添加其他 CLI provider；`trae`、`trae-cn` 专指 IDE Probe provider。
- TraeX/`traecli` 与 Trae IDE 复用 `~/.trae/skills`，但 Hook 配置隔离：分别使用 `~/.trae/cli/hooks.json` 与 `~/.trae/hooks.json`；Trae-CN 使用 `~/.trae-cn/hooks.json`。
- 结构化 AgentSurface 由 Desktop Agent 本地 stdio runner 驱动：Codex / TraeX 使用 app-server JSONL，Claude Code 使用双向 stream-json。
- 保留 `@openai/codex-sdk` 与原 Codex SDK adapter 作为未来显式兜底；当前不会在 app-server 失败时自动切换，避免隐藏协议故障。
- Codex、Claude Code、Trae 和 Trae CN 已接入本机 hook Probe；OpenCode、Gemini 的 Probe 仍是扩展方向。
- Probe 事件可进入本地 SQLite inbox，并向在线 App 发送 E2E `agent.message`；系统 Push 尚未实现。
- Desktop Agent 将归一化 Probe 事件和结构化 AgentSurface 事件写入本地 `agent_observations` 账本，保留来源、关联键、session/surface 和可用的项目范围信息；Trae records 导入同时扫描 provider 默认目录和 OmniWork fallback 目录，并通过 importer index v2 一次性重放旧记录。
- 当前本机 Desktop Agent 已加载 learning schema 并完成首次 fallback 回放；正式迁移前后均包含 2152 条 Observation 和 1070 个 Episode，升级后重启已继续写入新 Observation/Episode。Outcome、经验候选、Shadow、应用和评估仍无真实样本。
- Learning 本地表已切换为显式 schema v1。正式库切换前创建独立 `0600` SQLite 备份，切换后通过完整性和行数校验；当前表结构统一由 `learningSchema.ts` 维护。Store 不再执行 `PRAGMA table_info`、`ALTER TABLE` 或历史 Outcome 回填，代码库也不再提供旧 schema 迁移入口；非 v1 既有库会明确拒绝启动。
- 用户 Prompt 会开启本地 Delivery Episode，后续 Observation 按 session/surface 归并；只有 hook Stop、结构化 turn complete/result 或进程退出等强信号关闭 Episode。`delivered` 仅表示 Agent 已交付，不表示用户接受。
- E2E `agent.delivery` 支持 Episode 同步、完成推送和用户 Outcome 回执；App 的 Agent 会话页可对最新 delivered Episode 标记接受、需要修改或放弃并附带备注。Outcome 在本地追加审计、标注来源且与执行状态分离。
- 专用 Git Review Prompt 会对同 Surface 最近一个未评价交付记录修订信号并保守推断 `revision_requested`，但显式用户 Outcome 始终优先。结构化测试命令会记录通过/失败信号；测试通过不会自动判为接受。来源和信号均在 Agent 会话页可见。
- 只有来自显式用户反馈、带备注的“需要修改”Outcome 会在本地提炼为项目级 `user_correction` 经验候选；Git Review 推断不会自动生成经验。候选按 trigger/guidance 指纹去重并关联支持/反例 Episode。E2E `agent.experience` 支持候选同步、实时更新和人工审核；Agent 会话页可编辑候选后批准或拒绝。
- 新 Prompt 会对同项目已批准候选执行本地 Shadow 检索，记录关联 Episode 的 run、Prompt 哈希、最多 3 条命中、分数和匹配理由，但不会修改 Provider Prompt。App 可将命中标为相关或不相关，并查看 session 反馈统计。受控激活要求至少 10 条已评价命中且相关率不低于 70%；当前尚无真实反馈，Prompt 注入保持关闭。
- [delivery-learning.md](./delivery-learning.md) 的“真实验证 Runbook”规定了重新配对、候选建立、Shadow 采样、门槛判断、应用评估和立即回退顺序；禁止用历史回填或合成反馈满足真实门槛。
- 项目达到 Shadow 门槛后，用户可通过 Agent 会话页显式启用受控经验注入。实际生效会在每次 Prompt 前重新检查门槛和候选状态，最多应用 2 条、经验块不超过 4 KiB；应用记录只保存哈希、候选引用和字节数。当前项目没有真实门槛样本，默认状态仍为关闭。
- 应用 Episode 的接受、需要修改和放弃会归因为正向或反例证据；App 展示已应用与未应用交付的接受率和样本数。负向结果可自动暂停或废弃 active 经验，用户也可手动暂停、恢复和废弃；180 天无新证据会自动暂停。跨项目一致经验只产生本地晋升资格，不自动共享或全局生效。

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
