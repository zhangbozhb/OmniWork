# Relay 架构实施状态

关联文档：

- [relay-architecture.md](./relay-architecture.md)
- [identity-auth-design.md](./identity-auth-design.md)
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)
- [engineering-requirements.md](./engineering-requirements.md)

## 1. 架构基线

- Relay 负责 WebSocket 接入、身份准入、挑战绑定、限流、连接路由、P2P
  升级协调和可观测性。
- Relay 不持有 App 或 Agent 私钥，不批准 App，不解密业务 payload。
- App-Agent 业务安全固定由协议 v2 E2E 会话提供。
- Relay path 与 P2P path 复用同一 App-Agent E2E 会话。
- 同一个 Agent 可同时服务多个 App；身份、认证、E2E 和 P2P 状态都按
  `app_connection_id` 隔离。

## 2. 身份与准入

### Agent

1. Agent 发送签名 `agent.auth.init`。
2. Relay 校验派生 `device_id`、登记公钥、时间窗口和签名。
3. Relay 返回绑定当前连接的无状态 challenge。
4. Agent 在 `agent.hello.relay_auth` 中签名 challenge。
5. Relay 验证后执行 Agent 授权策略：
   - 默认 `manual`：未知 device ID 进入 Relay Admin 待批准列表。
   - `automatic`：device ID 与来源 IP 均未封禁时自动批准并持久化。
6. 身份和授权均通过后分配 `agent_connection_id`。

同一 `device_id` 只保留一个在线 Agent；新连接会关闭旧 Agent 及其关联 App
连接。Agent 授权由 Relay Admin 管理，与 Agent Admin 中的 App 授权相互独立。

### App

1. App 的 `mobile.connect` 携带目标 Agent ID、App 公共身份和 App 元数据。
2. Relay 定位在线 Agent，将其登记公钥写入 `auth.challenge`。
3. App 校验 Agent ID 与该公钥绑定，再签名 `auth.proof`；Relay 验签后转发为
   `auth.verify`。
4. Agent 在默认 `manual` 模式下对未知 App 返回 `auth.pending`，等待本机
   管理员批准；显式 `automatic` 模式在签名和 scope 校验后直接持久化信任。
5. Agent 返回签名 `auth.ok` 后，Relay 才将 App 标记为已认证。
6. App 与 Agent 完成签名 X25519 握手后进入 `e2e_ready`。

Relay `email_link` 模式额外校验用户对目标 Agent 的所有权；该控制面校验不改变
App-Agent E2E 信任边界。

## 3. 连接状态

Relay 连接状态：

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

- App 只有收到有效 `auth.ok` 后才能进入 `relay_pairing_verified`。
- `e2e.handshake.*`、`e2e.ready`、`e2e.message` 都绑定
  `app_connection_id`。
- `e2e.message` 只允许在对应 App-Agent pair ready 后转发。
- 原始业务 envelope 即使来自已认证连接也不会被 Agent 执行。
- Agent 可使用 `relay.app.deliver` 将协议错误返回到产生原请求的 App；目标由
  Relay 保存的短时 `relay_context_id` 决定。

## 4. 配置

- `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS` 只控制非 loopback 地址是否允许
  `ws://`。它不允许业务消息绕过 E2E。
- `wss://` 推荐用于减少网络元数据暴露，但不是业务安全边界。
- 协议 v2 没有全局或 per-Agent 的业务明文开关。
- Relay 对 `auth.proof` 按 `(device_id, public_remote_ip)` 限流。

## 5. P2P

- Relay 只协调 WebRTC 升级，不持有 `RTCPeerConnection`。
- 自动 propose 粒度为 `(device_id, app_connection_id)`，且只在对应 E2E
  pair ready 后触发。
- `tunnel.upgrade.propose` 是 Relay 定向控制消息。
- offer、answer、candidate、committed、downgrade 只在已认证且 E2E ready
  的连接间路由。
- P2P DataChannel 的加密业务统一走可靠有序 `control` 通道，保持 E2E 全局
  sequence 的顺序。
- `auto` 模式允许 P2P 失败后回到 Relay，但业务仍为同一 E2E 密文。
- `prefer_p2p` 模式失败时关闭业务 session，不把业务发送到 Relay。

详细多 App 传输状态见
[p2p-per-app-connection.md](./p2p-per-app-connection.md)。

## 6. 已落地模块

- 协议：v2 schema、Ed25519 身份、目标配对链接、签名认证、签名 X25519 E2E。
- Relay：Agent/App 准入、无状态 challenge、限流、定向认证桥接、E2E 状态
  路由，以及人工/自动 Agent 授权。
- Agent：长期身份、可信 App 存储、本机批准/拒绝/撤销、按 App E2E peer。
- App：长期身份、目标配对/分享链接、`auth.pending` 状态、Agent 签名校验。
- P2P：per-App coordinator、严格模式、退避、metrics、网络恢复。

## 7. 不变量

- 不新增共享 App-Agent 密钥。
- 不新增业务明文模式或降级。
- 不让 Relay 代替 Agent 批准 App。
- 不记录私钥、Probe token、E2E 会话密钥或业务明文。
- 所有身份签名必须使用域分离并绑定双方身份与连接上下文。
- 所有业务消息只能从已验证 E2E 会话解密后的 `InnerEnvelope` 进入业务分发。

## 8. 验证

```sh
pnpm --filter @omni-work/protocol-ts test
pnpm --filter @omni-work/e2e-noise test
pnpm --filter @omni-work/relay-server test
pnpm --filter @omni-work/desktop-agent test
pnpm --filter @omni-work/app test
pnpm typecheck
```

人工联调还需验证：

- `manual` 模式下未知 App 显示 `auth.pending`，本机批准前不能进入业务态。
- 拒绝、超时和撤销均使 App 连接失败。
- Relay 篡改身份、握手或 ciphertext 时校验失败。
- 重放或乱序 `e2e.message` 时接收端拒绝。
- 多个 App 的认证、E2E 和 P2P 状态互不影响。
