# 临时 Key 鉴权设计

关联文档：

- [engineering-requirements.md](./engineering-requirements.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [project-directory-structure.md](./project-directory-structure.md)

## 结论

MVP 范围不接入 SSO，不做企业身份体系，不做持久设备绑定。

MVP 鉴权采用临时共享 key：

- 桌面端 Agent 每次启动时生成一个新的 32 字符随机字符串。
- 该 key 保存到 电脑 本地文件。
- 手机 App 通过手动输入、扫码或演进的本机展示方式获得该 key。
- App 使用该 key 与 桌面端 Agent 建立本次连接授权。
- 桌面端 Agent 重启后 key 失效，需要重新获取新的 key。

## Key 生成规则

要求：

- 长度固定为 32 个字符。
- 必须使用加密安全随机数生成器。
- 推荐字符集：Base64URL 字符集，即 `A-Z`、`a-z`、`0-9`、`_`、`-`。
- 推荐生成方式：生成 24 bytes 随机数，再做 base64url 无 padding 编码，结果正好 32 字符。
- 不使用时间戳、用户名、设备名、UUID 截断等可预测材料。

示例：

```text
q8LDuJppTK3BU9X3et9bF3gAej-vbLQS
```

## 电脑 本地文件

推荐保存位置：

```text
~/Library/Application Support/OmniWork/agent/session-key.json
```

目录权限：

```text
~/Library/Application Support/OmniWork/agent
mode: 0700
```

文件权限：

```text
session-key.json
mode: 0600
```

文件内容：

```json
{
  "version": 1,
  "key": "q8LDuJppTK3BU9X3et9bF3gAej-vbLQS",
  "key_id": "sha256:8f2b7d62d9b0",
  "created_at": "<ISO_TIMESTAMP>",
  "agent_instance_id": "agent_20260512000001_a1b2c3d4",
  "relay_url": "wss://relay.company.example/relay/ws/agent"
}
```

说明：

- `key` 是本次 Agent 启动生成的临时共享 key。
- `key_id` 是 key 的短 hash 标识（取 `sha256(key)` 前 12 位 hex），只用于日志和排查，不可作为认证凭证。
- `agent_instance_id` 随 Agent 启动生成，格式 `agent_<YYYYMMDDhhmmss>_<8 位 hex>`（实现见 [authKey.ts](../desktop/agent/src/auth-key/authKey.ts)），用于区分同一台 电脑 的不同运行实例。
- 文件只保存在本机，不提交仓库，不同步到云盘。

## App 获取 Key

MVP 支持：

- 用户在 电脑 上打开 key 文件后手动复制到 App。
- 桌面端 Agent 在本机终端输出一次 key。
- 可提供 Menu Bar 或本地页面展示二维码。

当前二维码协议不兼容旧明文 pairing link。App 端分享二维码和 桌面端 Agent 终端二维码统一使用加密二维码：

- 二维码只包含加密后的 pairing payload、来源、生成时间、过期时间和加密参数。
- 来源字段取值为 `ios`、`android` 或 `agent`。
- 生成端同时生成 4 位随机数字密码；密码不写入二维码，需要用户另行输入或告知扫码方。
- 扫码端先识别 `kind=pairing_qr_encrypted`，再要求用户输入 4 位密码解密。
- 解密成功后使用扫码设备本地时间校验 `exp`，过期二维码拒绝导入。
- 加密实现为 `SHA-256(password + salt)` 派生密钥 + `ChaCha20-Poly1305` 认证加密，协议实现见 [pairingCrypto.ts](../packages/protocol-ts/src/pairingCrypto.ts)。二维码是短时临时凭证，4 位密码不使用慢 KDF，避免在移动端 JS 线程阻塞扫码体验。
- 纯离线场景无法防止用户修改本地时间或在有效期内转发二维码，当前实现仅提供离线加密、防篡改和本地过期校验。

App 侧要求：

- key 不进入普通明文持久存储。
- 如果为了重连临时保存，必须使用 iOS Keychain / Android Keystore / 安全存储封装。
- 当 桌面端 Agent 重启导致认证失败时，App 清理旧 key 并提示重新输入。

App 收到 `auth.failed` 后的具体清理动作（由 `app/src/app/App.tsx` 实现）：

- 立即调用 `relay.close()` 关闭本次会话连接，避免空跑或重复重连。
- 将本地缓存的 sessions、workspaces、terminal frame、provider 列表等会话级状态全部清空，避免误用旧 桌面端 Agent 的数据。
- **保留** 已保存的 pairing 条目本身：将 `connectionStatus` 置为 `failed` 并把失败原因透出到 `connectionMessage` / `pairingError`；用户可在 Device Center 中显式 Edit（修正 key）或 Delete 该设备。
  - 之所以不再自动从 `securePairingStore` 删除该 pairing，是因为 web 端 RN `Alert.alert` 是 no-op：旧实现会把"鉴权失败"显式打回 Pairing 页并默默删除条目，体验上像"保存失败、设备被静默删除"。实现保留条目，让错误对用户可见、可操作。
- 视图保持在 `devices`；如果用户当时正在 `pairing` 页编辑该 pairing，则保留 `editingPairing` 让其继续修改。

## Relay 鉴权流程

Relay 不作为身份系统，只作为连接中继。

推荐握手：

```mermaid
sequenceDiagram
  participant A as App
  participant R as Relay
  participant M as 桌面端 Agent

  M->>R: agent.hello(device_id, agent_instance_id, key_id)
  A->>R: mobile.connect(device_id, key_id)
  R->>A: auth.challenge(nonce)
  A->>R: auth.proof(HMAC_SHA256(key, nonce))
  R->>M: auth.verify(nonce, proof)
  M->>M: 使用本地 key 校验 proof
  M-->>R: auth.ok
  R-->>A: connected
```

原则：

- App 不应把 key 明文发给 Relay。
- Relay 不保存 key 明文。
- 桌面端 Agent 是 key 校验真相源。
- 握手成功后，Relay 只维护内存态连接授权。
- 连接断开后可以重新 challenge。
- 桌面端 Agent 重启后 `agent_instance_id` 和 key 都变化，旧连接失效。

## 消息头和协议字段

推荐新增消息：

```text
auth.challenge
auth.proof
auth.ok
auth.failed
agent.hello
mobile.connect
```

`auth.proof` payload 的字段定义以 [protocol/auth/auth-proof.schema.json](../protocol/auth/auth-proof.schema.json) 为唯一来源，运行时校验由 [packages/protocol-ts/src/schemas.ts](../packages/protocol-ts/src/schemas.ts) 落地。示例：

```json
{
  "key_id": "sha256:8f2b7d62d9b0",
  "nonce": "nonce_0123456789ab",
  "proof": "base64url(hmac_sha256(key, nonce))",
  "connection_id": "conn_..."
}
```

`auth.failed` 常见原因：

```text
key_mismatch
agent_restarted
key_expired
device_not_online
too_many_attempts
malformed_proof
```

## 安全限制

必须实现：

- key 每次 桌面端 Agent 启动重新生成。
- key 文件权限为 `0600`。
- key 所在目录权限为 `0700`。
- Relay 对失败次数限流（仅对失败的 `auth.proof` 计数：relay 端 `malformed_proof` / agent 端返回 `auth.failed` 两个真实失败分支才 consume token；合法 `auth.proof` → `auth.ok` 不消耗桶，避免频繁重连或切换 `transport_preference` 被误封禁）。
- App 认证失败后不无限重试。
- 日志中永远不打印完整 key。
- 审计中只记录 `key_id`，不记录 `key`。

不做：

- 不接入 SSO。
- 不做持久设备绑定。
- 不做 refresh token。
- 不做永久登录态。
- 不把 key 当作持久账户密码。

## 可演进

如需要企业化，可以从该 key 方案平滑演进：

- 临时 key 继续作为本机配对 fallback。
- Relay 增加公司身份体系。
- 桌面端 Agent 增加持久设备凭证。
- App 增加企业登录态。
- 管理员增加设备撤销和审计策略。

MVP 范围以上能力不进入 MVP。
