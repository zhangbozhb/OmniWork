# E2E Noise 落地计划

本文记录当前 E2E 安全改造的实施基线。P2P 传输能力已经先行落地；
当前阶段是在既有 relay path 与 p2p path 之上补齐 App-Agent E2E 加密。
系统尚未上线，因此 v1 直接采用 encrypted-only 业务模型，不保留明文业务兼容路径。

## 前置状态

- P2P 升级能力已作为传输优化先行实现，包含 `tunnel.upgrade.*`、`SessionTransport`、`UpgradeCoordinator` 和 Relay 编排能力。
- Noise E2E 不替代 P2P，也不要求删除 P2P；它覆盖 relay path 和 p2p path 的业务 payload 安全。
- E2E 完成后，路径选择仍由现有 transport preference、灰度、退避和降级逻辑控制。
- 本文只描述 E2E retrofit 的落地，不重新规划 P2P 传输能力。

## 设计基线

- `ws://` 和 `wss://` 都只是传输；业务安全边界是 App-Agent E2E。
- Relay 不可信，只负责外层路由、状态校验、限流和升级协调。
- P2P 是传输路径优化，不能单独作为业务安全边界。
- 所有业务消息必须封装为 `e2e.message`，Relay 不转发明文 `session.*`、
  `terminal.*`、`workspace.*`、`files.*`、`git.*`、`codex.*`。
- v1 固定使用 `Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s`。
- 外层协议、E2E 协议、内层业务协议均显式携带版本号。

## 已推进阶段

### 阶段 1：协议 v1 地基

- `packages/protocol-ts` 已新增 E2E v1 常量、能力名、TypeScript 类型。
- `schemas.ts` 已新增 `agent.hello`、`mobile.connect`、`e2e.*`、
  `protocol.error`、`InnerEnvelope` 的运行时 schema。
- `AgentHelloPayload` 和 `MobileConnectPayload` 已声明 `protocol` 与
  `e2e.required=true`。

### 阶段 2：Relay encrypted-only 状态机

- Relay 配置改为 `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS` 与
  `OMNIWORK_RELAY_REQUIRE_E2E`。
- 非 loopback 明文 `ws://` 必须显式允许，且 `REQUIRE_E2E=false` 会拒绝启动。
- Relay 已新增连接状态：`relay_pairing_verified`、`e2e_handshaking`、
  `e2e_ready`。
- Relay 已拒绝外层明文业务消息，并返回
  `protocol.error/plaintext_business_rejected`。

> 说明：该阶段是在 P2P 已存在的基础上增加安全门禁。接入 App/Agent Noise 前，
> 业务链路可能处于“安全门禁已开启、E2E 加解密待补齐”的过渡状态。

## 下一阶段

### 阶段 3：Noise 基础库

- 新增 `packages/e2e-noise`。
- 推荐依赖：`@noble/curves`、`@noble/hashes`、`@noble/ciphers`。
- 实现 PSK 派生、NNpsk0 握手、transport 加解密、seq/replay 校验。

### 阶段 4：Agent E2E 接入

- Agent 处理 `e2e.handshake.init` 并返回 `e2e.handshake.reply`。
- Agent 只从解密后的 `InnerEnvelope` 分发业务消息。
- Agent 拒绝所有外层明文业务命令。

### 阶段 5：App E2E 接入

- App 在 `auth.ok` 后发起 Noise 握手。
- `e2e_ready` 前业务消息入队，`e2e_ready` 后统一加密发送。
- Noise 失败时关闭 session，不降级明文。

### 阶段 6：P2P 路径安全收口

- relay path 和 p2p path 复用同一个 E2E session。
- P2P 切换不重新暴露业务明文，也不新增明文 fallback。
- `tunnel.upgrade.*` 控制面纳入 E2E 认证或密文控制消息。
- P2P 升级失败只影响路径选择，不影响业务 payload 的 E2E 安全。
