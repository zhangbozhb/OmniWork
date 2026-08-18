# 交付学习闭环

本文维护 OmniWork 交付学习能力的目标、边界、实施节点和验证状态。
实现事实仍以代码、测试和 [current-status.md](./current-status.md) 为准。

## 目标卡

- 主目标：将 Agent 的用户输入、执行过程、模型输出、交付产物和用户反馈转化为可追溯、可验证、可受控复用的项目经验。
- 成功判据：能够稳定组装交付 Episode；用户可标记交付结果；经验均可追溯到证据；经验先经审核和 Shadow 验证再生效；启用后能够量化返工变化。
- 当前基线：Probe、AgentSurface、Git diff 和 Review 批注已有独立记录链路，但缺少统一观察账本、交付关联、结果标签和经验生命周期。
- 范围：Desktop Agent 本地数据与分析、App 反馈和经验管理、项目级检索、效果评估。
- 不做事项：首期不自动修改 Skill、不做云端汇总、不做模型微调、不允许分析器执行工具。
- 关键约束：本地优先、项目隔离、敏感内容脱敏、人工审核、可停用和可删除。
- 停止条件：所有必需节点完成并通过验证；或验证证明收益不足并回退未生效能力。

## 运行模型

```text
Observation
  -> Delivery Episode
  -> Outcome
  -> Experience Candidate
  -> Review
  -> Shadow
  -> Active
  -> Evaluation / Deprecation
```

`Stop`、消息已读和消息已处理都不代表交付成功。交付结果优先使用用户明确反馈，其次使用测试、Review 修订和后续返工等可验证信号。

## 实施节点

| 节点 | 输出 | 状态 | 验收 |
| --- | --- | --- | --- |
| L1 统一观察账本 | `agent_observations`、Probe/Surface 写入、fallback records 导入 | 已完成 | 去重、关联、项目范围与导入测试通过 |
| L2 Episode Builder | Delivery Episode 与事件关联 | 已完成 | 结构化会话组装率达到试点门槛 |
| L3 Outcome Feedback | 接受、需修改、失败、放弃及自动验证信号 | 已完成 | 明确反馈可持久化且不误用已读状态 |
| L4 Experience Candidate | 原子经验候选、证据、反例与人工审核 | 已完成 | 候选可追溯、默认项目级且未经审核不生效 |
| L5 Shadow Retrieval | 项目检索、冲突过滤、Shadow 命中与认可反馈 | 已实现，采集中 | 至少 10 条反馈且相关率不低于 70% |
| L6 Controlled Activation | 有界 Prompt 注入与应用记录 | 已实现，默认关闭 | 可停用、预算有上限、无跨项目污染 |
| L7 Evaluation and Evolution | 效果对比、衰减、淘汰、跨项目晋升资格 | 已实现，待真实样本 | 能比较交付结果并回退无效经验 |

同一时间默认只推进一个节点。新发现若不阻塞当前节点，记录为后续节点输入，不扩张当前实现范围。

## 验证记录

- L1：Desktop Agent 类型检查通过；Desktop Agent 完整测试 121/121 通过。
- L1 未覆盖：跨设备稳定项目身份、历史 `agent_surface_events` 回填和原始 payload 保留策略，分别留给后续项目身份、迁移和治理节点。
- L2：Prompt 开启 Episode；只有 hook Stop、结构化 turn result/complete 或进程退出等强信号关闭 Episode。助手消息完成和工具失败不会误判为交付结束；事件修订与重放保持幂等。
- L2：Desktop Agent 完整测试 128/128 通过。使用 19 个现有 fallback JSONL 文件在临时库回放 2016 条 observation，组装 996 个 Episode；995 个含目标，750 个含最终回复并进入 `delivered`，167 个 `abandoned`，79 个保持 `working`。
- L2 未覆盖：用户是否接受交付、Review 修订和测试结果属于 L3 Outcome，不从 `Stop` 或 `delivered` 推断。
- L3：新增 E2E `agent.delivery` 协议，支持 Episode 同步、完成推送、Outcome 设置、幂等回执和绑定错误；`status` 继续表示 Agent 执行状态，`outcome` 独立表示用户的 `accepted`、`revision_requested` 或 `abandoned`。
- L3：Desktop Agent 以 `delivery_episode_outcomes` 追加表审计每次结果动作，并用 `outcome_source` 区分显式用户反馈和 Git Review 推断；重复 action 幂等，冲突 action 拒绝，迟到动作不覆盖较新结果，显式用户 Outcome 不会被后续自动信号覆盖。
- L3：专用 Git Review 发送链路携带 `git_review` 来源，对同 Surface 最近一个未评价 delivered Episode 记录 `review_revision_requested`，并保守推断 `revision_requested`。该推断可被后续用户 Outcome 覆盖，但不会生成经验候选。
- L3：结构化命令事件中的测试命令会写入 `delivery_episode_signals`，区分 `test_passed/test_failed` 并关联原 Observation；测试通过只作为验证证据，不自动等同用户接受。Agent 会话页展示 Outcome 来源和验证信号。
- L3：旧版已有 Outcome 在迁移时回填为 `user` 来源；协议测试 62/62、Desktop Agent 测试 162/162、App 测试 43/43 通过，正式 SQLite 已创建信号表和来源列。
- L3 未覆盖：通用构建结果和外部 CI/代码托管 Review 尚无标准化输入；它们不能仅凭命令文本自动推断用户接受。
- L4：只有带备注的 `revision_requested` Outcome 才生成 `user_correction` 候选；任务目标作为 trigger，用户修改要求作为 guidance。候选按项目和规范化文本指纹去重，支持与反例 Episode 分开保存。
- L4：候选证据随 Outcome 重算；反馈撤回会移除未审核候选，已批准且失去全部证据的候选自动转为 `deprecated`。来源指纹保证候选经人工编辑后，Outcome 重放不会生成重复候选。
- L4：新增 E2E `agent.experience` 同步、实时更新、移除、审核和错误协议。Agent 会话页可编辑 trigger/guidance，并批准或拒绝；审核动作追加审计、幂等且校验项目绑定。
- L4：启动时会从已有 Outcome 回填候选。协议测试 62/62、Desktop Agent 测试 138/138、App 测试 40/40 通过。
- L4 未覆盖：当前支持证据只来自明确用户纠正，反例模型已落地但尚待 L5/L7 从 Shadow 命中和后续交付结果写入。
- L5：每个新 Prompt 在 Episode 建立后运行本地词法检索，只比较 trigger；最多返回 3 条 `approved/shadow` 项目候选。候选必须有支持证据且支持数大于反例数，拒绝、废弃、跨项目和证据失衡候选不会命中。
- L5：Shadow run 关联 Episode，只保存 Prompt SHA-256、候选快照、分数和 `exact_trigger/token_overlap` 理由；空命中也会记录并推送，确保 App 不继续展示上一轮结果。检索结果不进入 Provider Prompt。
- L5：E2E `agent.experience` 支持 run 同步、实时结果和“相关/不相关”反馈；反馈动作追加审计、幂等且迟到反馈不覆盖较新结果。App 会话页展示最新 run、匹配分数、理由和 session 统计。
- L5：激活门槛固定为至少 10 条已评价 match 且相关率不低于 70%。协议测试 62/62、Desktop Agent 测试 143/143、App 测试 41/41 通过；英文精确/弱匹配、CJK 词项、跨项目、证据冲突、拒绝回退和反馈统计均有测试。
- L5 未覆盖：当前还没有真实用户 Shadow 反馈，因此 `activation_ready` 不应视为已达到；L6 可以实现受控注入机制，但必须保持关闭直到该门槛由真实数据满足。
- L6：项目设置区分 `requested_enabled` 和 `effective_enabled`；启用动作必须同时满足显式用户开关和实时 Shadow 门槛，关闭动作始终允许。相关率下降、候选拒绝/废弃或证据失衡会立即阻止后续应用。
- L6：每次最多应用 2 条当前项目候选，经验块 UTF-8 大小不超过 4096 bytes；trigger/guidance 经过 XML 文本转义，超预算候选跳过。原始 Prompt 先进入 Observation/Episode/Shadow，只有 Provider 提交副本会被增强。
- L6：`experience_applications` 只保存 run、episode、project、候选 ID、原始/增强 Prompt 哈希和注入字节数，不复制 Prompt 正文。候选首次应用后进入 `active`，仍可被人工拒绝；每次应用通过 E2E `application_recorded` 推送 App。
- L6：Agent 会话页显示项目开关、门槛状态、反馈统计、2 条/4 KiB 预算和当前交付应用记录；未达门槛时 Switch 不可开启，已请求开启时始终可关闭。
- L6：协议测试 62/62、Desktop Agent 测试 149/149、App 测试 42/42 通过；默认关闭、门槛拒绝、实时门槛回落、显式关闭、项目过滤、预算、转义、应用审计、active 回退和原始 Prompt 顺序均有测试。
- L6 未覆盖：尚无真实项目达到 10 条/70% 门槛，因此没有把合成测试结果解释为真实收益；真实应用效果由 L7 在门槛满足后比较。
- L7：应用 Episode 的明确 Outcome 会写入 `experience_application_evaluations`；`accepted` 形成支持证据，`revision_requested/abandoned` 形成反例。Outcome 修订会更新同一评估和证据，不重复计数，启动时会回填已有应用结果。
- L7：active 候选出现第一个反例立即转为 `paused`；反例至少 2 个且不少于支持证据时转为 `deprecated`。正向结果不会自动恢复候选；暂停后的恢复要求人工操作，且支持证据必须多于反例。
- L7：App 可暂停、恢复或废弃经验，动作追加审计并校验项目范围。180 天没有新证据的 `approved/shadow/active` 经验在 Agent 启动时自动暂停并记录 `stale_evidence`，不会自动删除。
- L7：项目效果卡分别统计已应用与未应用 Episode 的接受率、样本数和差值，并显示最近一次应用结果。该统计是观察性对比，任务构成和时间窗口未控制时不得解释为因果收益。
- L7：相同 trigger/guidance 在至少两个本地项目中独立通过审核且无反例时，生成本地晋升资格；不会自动复制经验、改变 scope 或跨项目注入。
- L7：协议测试 62/62、Desktop Agent 测试 162/162、App 测试 43/43 通过；Outcome 主链路归因、正负证据、自动暂停/废弃、人工恢复门槛、历史回填、基线对比、180 天衰减、跨项目资格、自动信号边界和 schema 迁移均有测试。
- L7：Web 开发 bundle 已在独立浏览器标签完成冷加载检查，Pair Desktop 页面正常渲染，无 runtime error、错误覆盖层或失败资源请求；控制台仅有既有的 React Native Web `shadow*` 弃用警告。
- L7：Desktop Agent 已重启到新实现，正式 `sessions.sqlite` 已创建全部 learning 表；首次启动回放 19 个 fallback 文件中的 2016 条记录。运行态检查时账本含 2040 条 Observation 和 1006 个 Episode，管理端返回 HTTP 200 且 Relay 已重新连接。
- Learning schema 已一次性切换为显式 v1：切换前备份正式 SQLite，集中补齐旧列、回填历史 Outcome 来源、执行完整性检查并写入 `omniwork_learning_schema`。正式库切换前后均为 2152 条 Observation、1070 个 Episode，业务样本计数无变化，备份权限为 `0600`。
- 切换完成后，各 Store 中分散的建表、`PRAGMA table_info`、`ALTER TABLE`、启动时历史回填，以及一次性旧 schema 迁移脚本和命令均已移除。新库只初始化当前 schema；已有未版本化或非 v1 库会明确拒绝启动，不再保留旧版本兼容分支。
- L7 未覆盖：正式库仍没有 Outcome、经验候选、Shadow 反馈、应用或评估样本；因此当前只证明机制、迁移与运行约束，不声明真实相关率或质量收益。

## 真实验证 Runbook

1. **恢复连接**：确认本机 Agent Admin 显示 `Relay connected`，使用本次 Agent 启动生成的新临时 key 重新配对 App。Agent 重启后旧 key 不再有效；不得把 key、配对链接或数据库复制到项目仓库。
2. **建立第一条候选**：在真实项目完成一次实际交付，将确实需要返工的 delivered Episode 标记为“需要修改”并填写聚焦的修改要求。确认候选带有相同项目的 supporting Episode 后，人工编辑并批准；不得为凑样本回填历史 Episode 或提交虚构 Outcome。
3. **采集 Shadow**：继续执行真实任务。只对当前 Prompt 实际出现的 Shadow match 评价“相关/不相关”，空命中不计入分母；同一 match 的修订只保留最新反馈。采样期间保持项目经验开关关闭。
4. **检查门槛**：累计至少 10 条已评价 match 后，以 App 显示的 `reviewed_matches`、`relevant_matches` 和 `relevance_rate` 为准。只有 `reviewed_matches >= 10` 且 `relevance_rate >= 70%` 时，才允许用户显式开启当前项目；项目之间不得合并样本。
5. **采集应用结果**：启用后继续使用真实任务，并为有 application 记录的 Episode 提交明确 Outcome。同步保留未应用 Episode 作为观察性 baseline；不得为了提高接受率删除、改写或跳过负向结果。
6. **评估与治理**：记录 assisted/baseline 样本数、各自接受率和差值，同时报告任务构成与时间窗口。首次明确负向应用结果应使 active 经验暂停；两个以上反例且反例不少于支持证据时应废弃。没有足够样本时只报告计数，不下收益结论。
7. **立即回退**：出现范围污染、错误建议或相关率跌破门槛时，先关闭项目经验开关，再暂停或废弃相关候选。关闭动作不受门槛限制，原始 Prompt、Observation、Episode 和审计记录必须保留。

每次验证记录至少包含：项目 ID、采样时间窗、候选 ID、已评价/相关/不相关数、是否达到门槛、application 数、assisted/baseline Outcome 分布、暂停/废弃动作及原因。当前正式库基线为上述各项业务样本均为 0。

## 数据边界

- 原始 Observation 保存在 Desktop Agent 本地 SQLite 或 provider 本地 records 中。
- `project_id` 首期由规范化 workspace 路径生成，仅用于本机项目隔离；跨设备稳定项目身份在后续节点单独设计。
- Probe 与 Surface 可以是同一事实的不同表示，通过 `correlation_key` 关联，不在采集阶段丢弃来源信息。
- 经验只保存必要的抽象结论和证据引用，不复制密钥、隐私信息或大段源码。
- Shadow run 不保存 Prompt 正文，只保存哈希并通过 `episode_id` 追溯原交付。
- Active application 不保存增强 Prompt 正文，只保存原始/增强哈希、候选引用和预算用量。

## 生效门槛

- 经验候选不得自动生效。
- Shadow 命中经过人工认可后，才能进入项目级受控注入。
- 项目经验只有在多个独立项目中重复验证且无明显反例时，才能申请晋升全局。
- 任一经验出现明确用户纠正、交付退化或范围冲突时，应降级、暂停或废弃。
- 跨项目验证只产生晋升资格；任何全局化仍需单独人工决策，不自动共享项目内容。
