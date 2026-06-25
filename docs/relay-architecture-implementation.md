# Relay 架构实施状态

文档版本：2.0
关联文档：

- [relay-architecture.md](./relay-architecture.md)：Relay、P2P 升级和运行期行为的最终参考。
- [e2e-noise-roadmap.md](./e2e-noise-roadmap.md)：App-Agent E2E 加密的设计基线与落地状态。
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)：多 App 并发后的 P2P per App connection 设计与实现边界。
- [engineering-requirements.md](./engineering-requirements.md)：工程约束与安全要求。
- [auth-key-design.md](./auth-key-design.md)：临时 key、pairing 和 `auth.proof` 设计。

## 1. 文档定位

本文不再维护过程型总体计划，也不保留废弃公网隧道、历史 spike、旧 P2P 迁移计划等过程信息。

本文只记录Relay 架构的实施状态和演进边界，用于回答：

- Relay 代码应当满足哪些架构约束。
- 哪些能力已经落地，哪些能力仍在推进。
- P2P 与 E2E 加密在实施顺序上的关系。
- 演进修改 Relay、App、Agent、protocol 时需要保持哪些不变量。

详细协议设计以 `relay-architecture.md` 和 `e2e-noise-roadmap.md` 为准；本文不重复完整协议字段。

## 2. 架构基线

### 2.0 演进顺序

项目按以下能力顺序演进 P2P 与 E2E 加密：

1. **先落 P2P 传输能力**：先完成 App-Agent 经 Relay 协调升级到 WebRTC DataChannel 的路径优化，解决连接路径、降级、灰度、退避、metrics 等传输问题。
2. **再补 E2E 安全层**：在已存在的 relay path 与 p2p path 之上引入 Noise E2E，使两条传输路径都只承载密文业务消息。
3. **最终统一安全模型**：无论业务消息走 Relay 还是 P2P，都必须使用同一套 App-Agent E2E session；P2P 只影响路径和性能，不单独承担业务安全边界。

因此，本文中的 E2E 约束描述的是安全改造后的目标态；P2P 相关模块和文档仍保留，因为它们是已经落地的传输基础。

### 2.1 信任边界

- Relay 默认不可信，只负责连接、路由、限流、升级协调和可观测性。
- `ws://` 和 `wss://` 都只是传输方式；业务安全边界是 App-Agent E2E。
- `wss://` 仍推荐用于降低网络侧元数据暴露，但不能作为业务明文保护机制。
- Relay 不保存 pairing key，不解密业务 payload，不执行业务授权决策。

### 2.2 连接路径

```text
App <-- ws/wss --> Relay <-- ws/wss --> Agent
  \                                           /
   \====== App-Agent E2E encrypted path =====/
```

- Relay 只接受 `/relay/ws/mobile` 和 `/relay/ws/agent` WebSocket endpoint。
- App 通过 `mobile.connect` 进入 Relay 接入流程。
- Agent 通过 `agent.hello` 注册 `device_id`、`agent_instance_id`、`key_id`、协议版本和能力。
- `auth.proof` 只用于 Relay 接入校验和限流，不代表业务通道可用。
- 默认业务消息由 App/Agent 在 E2E ready 后通过 `e2e.message` 传输；
  Relay 不解析业务 payload，也不维护业务明文策略。
- 同一个 Agent 支持多个 App 同时连接；每个 App 连接使用 Relay 分配的
  `app_connection_id` 建立独立 E2E session。

### 2.3 P2P 升级

- P2P 是传输优化，不是唯一安全边界。
- P2P 能力已先于 Noise E2E 落地，包括 `SessionTransport`、`WebRtcPeerAdapter`、`UpgradeCoordinator` 与 `RelayUpgradeOrchestrator`。
- Relay 可协调 WebRTC DataChannel 升级，但 Relay 不持有 `RTCPeerConnection`。
- P2P 数据路径继续复用同一套 E2E session；除 Relay 定向 propose 提示外，P2P signaling 通过 E2E 控制消息传递。
- P2P 失败只能影响可用性或路径选择，不能导致明文业务 fallback。

## 3. 已落地状态

### 3.1 协议 v1 基础

- `MessageEnvelope` 已具备外层 `v` 字段。
- `AgentHelloPayload` 和 `MobileConnectPayload` 已声明：
  - `protocol.current`
  - `protocol.min_supported`
  - `e2e.required=true`
  - E2E 版本和 Noise suite 支持列表
- 已新增 E2E v1 消息类型：
  - `e2e.handshake.init`
  - `e2e.handshake.reply`
  - `e2e.ready`
  - `e2e.message`
  - `e2e.failed`
  - `e2e.rekey.*`
  - `e2e.close`
- 已新增 `protocol.error`，用于 Relay 返回协议状态错误。
- 已新增 `InnerEnvelope`，作为 E2E 密文内的业务消息 envelope。

### 3.2 Relay 配置

- `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS`：非 loopback 明文 `ws://` 必须显式允许。
- `OMNIWORK_RELAY_REQUIRE_E2E`：仅作为旧配置兼容项保留；Relay 可同时承载
  `e2e_required` 与 `plaintext_allowed` Agent，业务是否加密由 Agent 声明决定。
- 旧的 TLS 终止确认配置已废弃，不再作为安全边界配置。

### 3.3 Relay 状态机

Relay 连接状态包括：

```text
socket_connected
registered_agent
mobile_connected
relay_pairing_verified
e2e_handshaking
e2e_ready
closed
```

关键规则：

- mobile 只有完成 `auth.ok` 后才进入 `relay_pairing_verified`。
- mobile 只有在 `relay_pairing_verified` 状态下才能发起 `e2e.handshake.init`。
- `e2e.message` 只允许在 `e2e_ready` 状态转发。
- E2E 握手、ready、message 都按 `app_connection_id` 绑定和定向路由。
- Agent 侧同一 WebSocket 连接上可以维护多个 App 的 E2E peer state。
- 外层业务 envelope 的加密策略由 App/Agent 负责；Relay 仅按认证连接与
  `app_connection_id` 路由。
- Agent 如需让 Relay 回源投递错误，使用 `relay.app.deliver` 提交 Relay
  颁发的 `relay_context_id` 与 `protocol.error` 内容；Relay 根据此前转发 App
  请求时保存的上下文决定目标 App，并绑定到接收原请求的 Agent 连接。
- P2P 自动 propose 已恢复为 per App connection 触发；Relay 只对已 E2E ready 的 App 连接下发 propose。

### 3.4 文档清理

- 已移除废弃的第三方隧道方案文档。
- 主线文档不再引用第三方隧道服务或旧公网隧道路径。
- 本文统一表述为：部署方提供稳定公网入口，业务安全由 App-Agent E2E 负责。

### 3.5 P2P 传输能力

- P2P 升级协议族 `tunnel.upgrade.*` 已存在。
- App 与 Agent 已具备 P2P peer 抽象和升级协调状态机。
- Relay 已具备 P2P propose、灰度、退避、metrics 与 debug 触发能力；升级粒度为 `(device_id, app_connection_id)`。
- 这些能力是 E2E 改造的前置传输基础，不应在 E2E 改造中回退或删除。

## 4. 演进边界

### 4.1 P2P 控制面收口

P2P 已经作为传输能力落地；E2E 改造对 P2P 控制面做了如下收口：

- relay path 和 p2p path 使用统一 E2E 安全模型。
- `tunnel.upgrade.propose` 仅作为 Relay 定向升级提示；offer / answer / candidate / committed / downgrade 属于 P2P 控制面信令，只在对应 App-Agent E2E pair ready 后由 Relay 按 `app_connection_id` 透传，不承载业务 payload。
- Relay 自动 propose 只在对应 App 的 E2E pair ready 后触发。
- `/debug/upgrade` 必须显式传入 `app_connection_id`，并要求对应 E2E pair ready。
- 路径切换不能引入明文业务 fallback。
- strict P2P 失败应关闭 session 或明确提示用户，不静默退回明文 relay。

### 4.2 演进协议演进

- v1 使用 `Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s` 和 pairing key 派生 PSK。
- 可演进到带持久设备身份的 Noise pattern，例如 `XXpsk3`。
- 多 App Relay path 已按 `app_connection_id` 维护独立 E2E session。
- P2P DataChannel 按 `app_connection_id` 承载对应 App 的 E2E 密文，不能新增明文旁路。

## 5. 实施不变量

演进任何改动都必须保持：

- 不新增明文业务 fallback。
- 不把 Relay 当作可信业务执行方。
- 不让 Relay 保存或打印完整 key、Noise PSK、E2E session key、业务明文。
- 不恢复废弃第三方隧道方案或相关 runbook。
- 所有新增协议消息必须带版本号或版本化 capability。
- 业务消息只能出现在 E2E 解密后的 `InnerEnvelope` 中。
- 文档变更必须同步检查 `relay-architecture.md`、`e2e-noise-roadmap.md` 和本文。

## 6. 验收口径

MVP 范围的基础验收：

```sh
pnpm --filter @omniwork/protocol-ts test
pnpm --filter @omniwork/protocol-ts typecheck
pnpm --filter @omniwork/relay-server typecheck
pnpm --filter @omniwork/desktop-agent typecheck
pnpm --filter @omniwork/app typecheck
pnpm verify:relay
```

E2E 接入完成后的安全验收还应包括：

- `ws://` 下 App-Agent 能完成 Noise handshake。
- Relay 日志和内存中不可见业务明文。
- Relay 伪造外层 `terminal.input` 时 Agent 不执行。
- Relay 伪造外层 offer / answer / candidate / committed / downgrade 时 App/Agent 不执行；Relay propose 仅作为定向升级提示。
- `/debug/upgrade` 在 encrypted-only 默认配置下必须指定 `app_connection_id` 且要求 E2E pair ready。
- Relay 篡改 handshake 或 ciphertext 时连接失败。
- Relay 重放旧 `e2e.message` 时接收端拒绝。
- 多个 App 同时连接同一 Agent 时，任一 App 的握手、消息和重放检测不影响其他 App。
- App/Agent 协议版本或 Noise suite 不兼容时明确失败，不降级明文。

## 7. 状态摘要

- 协议 v1、E2E 类型和 schema：已落地。
- Relay `ws://` + `REQUIRE_E2E` 配置：已落地。
- Relay encrypted-only 状态机：已落地。
- P2P 传输升级能力：已落地。
- Noise 加解密库：已落地。
- Agent E2E 解密分发：已落地。
- App E2E 加密发送：已落地。
- Relay path 多 App E2E：已落地。
- P2P 自动 propose：已按 per App connection 恢复。
- P2P DataChannel 统一 E2E 承载：已按 `app_connection_id` 基础收口。
