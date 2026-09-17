# E2E 会话安全实施记录

> 文件名保留用于兼容历史引用。当前实现不再使用 Noise NNpsk0 或共享 PSK；
> `packages/e2e-noise` 现实现身份签名的临时 X25519 会话协议。

关联文档：

- [identity-auth-design.md](./identity-auth-design.md)
- [relay-architecture-implementation.md](./relay-architecture-implementation.md)
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)

## 当前状态

App-Agent 业务安全已经落地：

- 协议 v2 固定要求 E2E，不提供业务明文模式或自动降级。
- App 与 Agent 在双向身份认证后建立独立的签名 X25519 会话。
- 每个 App WebSocket 使用 Relay 分配的 `app_connection_id` 绑定独立 E2E
  session。
- Relay path 与 P2P path 复用同一个 E2E session，切换路径不改变安全边界。
- Agent 只执行成功解密并通过序列校验的 `InnerEnvelope`。
- 业务响应统一封装为 `e2e.message`，Relay 不解析业务 payload。

## 密码学协议

长期身份使用 Ed25519，单次会话使用临时 X25519：

1. App 生成临时 X25519 密钥，并以长期 App 私钥签名握手 init。
2. Agent 校验 App ID、公钥与签名，生成自己的临时 X25519 密钥。
3. Agent 以长期 Agent 私钥签名 reply。
4. 双方对 X25519 共享秘密执行 HKDF-SHA256，派生双向独立会话密钥。
5. 业务消息使用 ChaCha20-Poly1305。
6. 单调序列号进入认证上下文，用于拒绝重放和乱序。

签名输入绑定：

- Agent device ID、Agent 公钥。
- App ID、App 公钥。
- Agent/App connection ID。
- handshake ID。
- 双方临时公钥。
- 外层、内层和 E2E 协议版本。

因此 Relay 无法替换身份、临时密钥或连接上下文而不使签名校验失败。

## 传输边界

- `ws://` 与 `wss://` 都只是传输；生产环境仍推荐 `wss://` 降低元数据暴露。
- WebRTC P2P 是路径优化，不是业务安全边界。
- Relay 只保存连接拓扑、E2E ready 状态和短时定向上下文。
- `tunnel.upgrade.*` 属于 P2P 控制面信令，只在对应 App-Agent E2E pair ready
  后按 `app_connection_id` 路由。
- P2P 失败可按传输偏好回到 Relay；业务 payload 始终保持同一 E2E 密文。
- 严格 P2P 模式失败时关闭业务 session，不以明文或未认证通道继续。

## 已落地模块

### 协议

- `packages/protocol-ts` 定义强制 E2E capability、签名 X25519 suite、
  `e2e.handshake.*`、`e2e.ready`、`e2e.message` 和 `InnerEnvelope` schema。
- E2E 报文绑定 `device_id`、`app_id`、连接 ID、handshake ID 和协议版本。

### 密码学包

- `packages/e2e-noise` 提供发起方与响应方握手、会话派生、加解密和重放保护。
- 使用 `@noble/curves`、`@noble/hashes` 与 `@noble/ciphers`，支持 Node、
  React Native 与 Web。
- 测试覆盖双向签名、身份替换、签名篡改、连接绑定、密文篡改、重放和乱序。

### Relay

- 连接状态包含 `relay_pairing_verified`、`e2e_handshaking` 和 `e2e_ready`。
- E2E handshake 与密文消息按 `app_connection_id` 定向路由。
- Relay 不持有 E2E 会话密钥，也不接受已认证连接直接发送外层业务命令。

### Agent

- Agent 按 App connection 维护独立 E2E peer。
- 只有可信 App 完成签名认证后才能开始握手。
- E2E ready 前不执行业务消息；解密、认证或重放校验失败会清理会话。

### App

- App 在验证签名 `auth.ok` 后发起 E2E 握手。
- E2E ready 前的业务消息入队，ready 后统一加密发送。
- Agent reply 必须与 Relay challenge 中已验证的 Agent 公钥一致。

## 已退役机制

以下旧设计只属于历史，不得作为 fallback 恢复：

- `Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s`。
- 从共享配对 Key 派生 PSK。
- `business_security_mode=plaintext_allowed`。
- `OMNIWORK_AGENT_REQUIRE_E2E=false` 或 Relay 业务明文开关。
- E2E 握手失败后降级为明文业务 envelope。

包名 `e2e-noise` 为兼容已发布 npm 包与现有 import 路径保留，不代表当前仍使用
Noise NNpsk0 握手。

## 验证入口

```sh
pnpm verify:identity-auth
pnpm --filter @omni-work/e2e-noise test
pnpm verify:security
pnpm test
pnpm verify:app:targets
```

运行中的 Relay 与 Agent 可进一步使用：

```sh
pnpm verify:upgrade:simulator -- --pairing 'omniwork://pair?...'
pnpm verify:upgrade:simulator -- --relay <ws-url> --device <DEV1-id>
```

该模拟器使用独立 App 身份，仍需在 Agent Admin 中批准；它验证签名认证、E2E
握手与 P2P 路径，而不是使用链接内凭证。
