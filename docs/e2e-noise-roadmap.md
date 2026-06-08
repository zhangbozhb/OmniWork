# E2E Noise 落地计划

本文记录E2E 安全改造的实施基线。P2P 传输能力已经落地；
MVP 范围是在既有 relay path 与 p2p path 之上补齐 App-Agent E2E 加密。
默认采用 encrypted-only 业务模型；本地可信调试可由 Agent 启动配置显式切换为
`plaintext_allowed`，其他端通过协议字段适配，不做自动降级。

## 前置状态

- P2P 升级能力已作为传输优化实现，包含 `tunnel.upgrade.*`、`SessionTransport`、`UpgradeCoordinator` 和 Relay 编排能力。
- Noise E2E 不替代 P2P，也不要求删除 P2P；它覆盖 relay path 和 p2p path 的业务 payload 安全。
- E2E 完成后，路径选择仍由现有 transport preference、灰度、退避和降级逻辑控制。
- 本文只描述 E2E retrofit 的落地，不重新规划 P2P 传输能力。

## 安全状态

- 代码已接入 App-Agent Noise E2E：App 在 `auth.ok` 后发起握手，Agent 只执行解密后的 `InnerEnvelope`，业务响应也会封装为 `e2e.message`。
- 同一个 Agent 已支持多个 App 同时连接；每个 App 使用 `app_info.instance_id` / `app_info.runtime_id` 标识应用实例与运行实例，并使用 Relay 分配的 `app_connection_id` 建立独立 E2E session。
- `packages/e2e-noise` 已覆盖 NNpsk0 握手、ChaCha20-Poly1305 加解密、`seq` 防重放、篡改检测和 key mismatch 测试。
- `auth.proof` 仍用于 Relay 接入校验和失败限流；签名输入绑定 `nonce`、`app_info.instance_id`、`app_info.runtime_id`，Agent 额外记录已处理 nonce，拒绝同一 `key_id + nonce` 的 `auth.verify` 重放。
- P2P per App connection 已完成基础收口：Relay 只对 E2E ready 的 App 连接触发 propose，升级控制信令按 `app_connection_id` 绑定并由 Relay 透传；业务 payload 仍复用 App-Agent E2E 通道。

## 设计基线

- `ws://` 和 `wss://` 都只是传输；业务安全边界是 App-Agent E2E。
- Relay 不可信，只负责外层路由、状态校验、限流和升级协调。
- P2P 是传输路径优化，不能单独作为业务安全边界。
- 默认模式下所有业务消息必须封装为 `e2e.message`，Relay 不转发明文 `session.*`、
  `terminal.*`、`workspace.*`、`files.*`、`git.*`、`codex.*`。`tunnel.upgrade.*`
  是 P2P 控制面信令，只允许在对应 App-Agent E2E pair ready 后按 `app_connection_id` 透传。
- Agent 可通过 `OMNIWORK_AGENT_REQUIRE_E2E=false` 显式声明
  `business_security_mode=plaintext_allowed`；同一 Relay 可同时承载
  `e2e_required` 与 `plaintext_allowed` Agent，并按目标 Agent 模式路由。
- v1 固定使用 `Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s`。
- `app_connection_id` 由 Relay mobile connection id 规范化，参与 Noise prologue 和 E2E message AAD。
- 外层协议、E2E 协议、内层业务协议均显式携带版本号。

## 已落地能力

### 协议 v1 地基

- `packages/protocol-ts` 已新增 E2E v1 常量、能力名、TypeScript 类型。
- `schemas.ts` 已新增 `agent.hello`、`mobile.connect`、`e2e.*`、
  `protocol.error`、`InnerEnvelope` 的运行时 schema。
- `AgentHelloPayload` 和 `AuthOkPayload` 已声明 `business_security_mode`，缺省按
  `e2e_required` 兼容旧端，并用 `e2e.required` 表达本次连接是否强制 E2E。

### Relay encrypted-only 状态机

- Relay 配置保留 `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS`，`OMNIWORK_RELAY_REQUIRE_E2E`
  仅作为旧配置兼容项；业务是否加密由 Agent `business_security_mode` 决定。
- 非 loopback 明文 `ws://` 必须显式允许；Relay 不再用全局 E2E 开关阻断
  `plaintext_allowed` Agent。
- Relay 已新增连接状态：`relay_pairing_verified`、`e2e_handshaking`、
  `e2e_ready`。
- Relay 对 `e2e_required` Agent 拒绝外层明文业务消息，并返回
  `protocol.error/plaintext_business_rejected`。
- Relay path 已按 `app_connection_id` 定向转发多 App E2E 消息，Agent 响应不再广播给所有 App。

### Noise 基础库

- 已新增 `packages/e2e-noise`。
- 已使用 `@noble/curves`、`@noble/hashes`、`@noble/ciphers` 实现跨端密码学基础。
- 已实现 PSK 派生、NNpsk0 握手、transport 加解密、seq/replay 校验。

### Agent E2E 接入

- Agent 已处理 `e2e.handshake.init` 并返回 `e2e.handshake.reply` / `e2e.ready`。
- Agent 已按 `app_connection_id` 维护多个独立 E2E session。
- Agent 默认只从解密后的 `InnerEnvelope` 分发业务消息；显式 plaintext 模式下
  接受带 `app_connection_id` 的已鉴权外层业务消息。
- Agent 默认拒绝所有外层明文业务命令。
- 请求响应类消息定向返回来源 App，终端帧按订阅 App 推送，共享 session 状态才广播。

### App E2E 接入

- App 已在 `auth.ok` 后发起 Noise 握手。
- `e2e_ready` 前业务消息入队，`e2e_ready` 后统一加密发送。
- Noise 失败时关闭 session，不降级明文。

## 待收口能力

### P2P 路径安全收口

- Relay path 和 p2p path 复用同一个 App-Agent E2E session。
- P2P 切换不重新暴露业务明文，也不新增明文 fallback。
- `tunnel.upgrade.propose` 是 Relay 定向升级提示；offer / answer / candidate / committed / downgrade 是 P2P 控制面信令，只在 E2E pair ready 后由 Relay 按 `app_connection_id` 透传。
- P2P 升级失败只影响路径选择，不影响业务 payload 的 E2E 安全。
- P2P 多 App 实现边界记录在 `p2p-per-app-connection.md`。
