# 身份认证设计

关联文档：

- [engineering-requirements.md](./engineering-requirements.md)
- [relay-architecture.md](./relay-architecture.md)
- [p2p-per-app-connection.md](./p2p-per-app-connection.md)

## 结论

OmniWork 使用统一的非对称身份体系：

- Agent 与 App 首次运行时各自生成长期 Ed25519 密钥对，后续复用。
- `device_id` 与 `app_id` 只由对应公钥派生，不依赖主机名、IP、账户或
  Relay 分配值。
- App-Agent 之间不存在共享配对密钥。
- 新 Agent 默认必须由 Relay 管理员批准；Relay 也可显式配置自动授权。
- Desktop Agent 默认要求本机管理员明确批准未知 App，也可显式配置自动批准。
- 双方认证通过后，使用带长期身份签名的临时 X25519 握手建立 E2E 会话。
- Relay 只做身份准入、挑战绑定、路由和限流，不持有任一端私钥，也不解密
  业务消息。

这是协议 v2 的唯一实现，不提供旧认证方案或业务明文模式的迁移与兼容分支。

## 长期身份

身份算法固定为 Ed25519。身份记录包含：

```json
{
  "version": 1,
  "role": "agent",
  "algorithm": "Ed25519",
  "id": "DEV1-......",
  "publicKey": "<base64url raw public key>",
  "privateKey": "<base64url raw private key>",
  "createdAt": "<ISO timestamp>"
}
```

Agent 使用 `role=agent` 和 `DEV1` 前缀；App 使用 `role=app` 和 `APP1`
前缀。

ID 派生规则：

1. 对域分离字符串、角色、算法和原始公钥做 SHA-256。
2. 取前 160 bit 作为主体，以 Crockford Base32 编码。
3. 对前缀和主体再次做域分离 SHA-256，取 20 bit 校验位。
4. 每 6 个字符一组，用短横线展示。

公钥和角色相同则 ID 稳定；校验位只用于发现录入错误，身份真实性仍由签名
验证。

网络协议只接受带标准分组的大写 ID；用户输入在签名前规范化。授权、封禁和
路由使用同一规范 ID，不能通过小写或去分隔符改变授权主体。

## 本地存储

Agent：

- 默认文件：
  `~/Library/Application Support/OmniWork/agent/identity-v2.json`
- 目录权限 `0700`，文件权限 `0600`。
- macOS 登录 Keychain 安全可用时优先读取并写入同一身份。
- 文件存在但内容损坏时拒绝启动，不静默生成新身份。

Native App：

- 使用系统 Keychain/Keystore 封装保存身份材料，不在 UI 或日志中暴露私钥。

Web App：

- 使用 WebCrypto 生成不可导出的 Ed25519 私钥。
- 使用 IndexedDB 保存 `CryptoKey`。

App 的连接和设置页共享同一次身份初始化。显式重置等待正在进行的初始化完成，
之后的读取等待重置结果；初始化失败允许重试。Web 多标签页首次创建时，在
IndexedDB 写事务内复查已有身份，使用已经提交的记录，避免互相覆盖。
设置页只展示可公开核对的 `APP1-...` ID，不展示私钥。

Agent 的本地 Probe 使用独立随机 bearer token，保存在
`probe-token.json`。Probe token 不参与 App-Agent 或 Agent-Relay 认证。

## Relay 设备登记

启用 Relay `email_link` 模式时：

1. Agent 创建或读取长期身份。
2. 用户在 Relay 登录页创建短时 enrollment token。
3. Agent 向 `POST /auth/devices` 提交 token、派生 `device_id` 和公钥。
4. Relay 验证 ID 与公钥匹配后登记。

相同用户、公钥和 device ID 的重复登记是幂等的；已撤销设备可使用该用户新建的
enrollment token 恢复，仍受设备数量限制和 Relay 管理员封禁约束。其他用户不能
接管已有 device ID。设备更新和一次性 enrollment token 消费在同一事务内提交。

Relay 不生成或改写设备 ID。

## Agent-Relay 认证

1. Agent 发送 `agent.auth.init`，签名绑定 `device_id`、公钥和时间戳。
2. Relay 校验登记状态、公钥绑定、签名和时间窗口。
3. Relay 返回带连接 ID、过期时间和随机数的无状态 challenge。
4. Agent 在 `agent.hello.relay_auth` 中签名 challenge。
5. Relay 验证 proof 后执行 Agent 授权策略：
   - `manual`（默认）：已批准 device ID 继续；未知 Agent 进入 Relay Admin
     待授权列表。列表和详情展示 Relay 观测的公网 IP，以及 Agent 上报的系统
     类型和 `uname`，并支持在详情中批准或拒绝。Relay 随后以
     `4402 / agent_approval_required` 断开连接并等待 Agent 重试。
   - `automatic`：当 device ID 和 Relay 可见来源 IP 均不在封禁名单时，持久化
     授权并继续。
6. 身份和授权均通过后，Relay 返回 `auth.ok(agent_connection_id)`。

challenge 的 HMAC 只由 Relay 用于保护自身无状态数据，不是 App-Agent 共享
秘密。

Agent 授权记录持久化在 Relay `admin-controls.sqlite`。设备禁用和 IP ban
始终优先于已授权记录；删除人工授权会断开当前 Agent，后续连接重新进入待批准
状态。启用 `email_link` 时，用户设备登记/归属仍是额外前置条件，自动授权不
绕过该检查。

Agent-Relay 授权与 App-Agent 授权是两层独立控制：

- Relay Admin 决定某个 Agent device ID 是否允许接入 Relay。
- Agent Admin 决定某个 App ID 是否允许控制该 Agent。

## App 目标链接与批准

Agent 生成的配对二维码和 App 生成的分享二维码使用同一种目标链接，只包含：

- Relay App WebSocket URL。
- Agent `device_id`。
- 可选显示名称。

App 也允许直接手动输入上述目标信息。手动录入、粘贴链接和扫码使用同一校验
规则，得到相同的本地目标配置。

链接不是凭证，不包含 Agent 公钥、App 身份、共享密钥或授权票据。App 在首次
使用时生成并持久化自己的 Ed25519 身份；每次连接都自动补充 App ID、公钥与
设备/App 元数据。默认 `manual` 模式下，未知或已撤销的 App 仍必须由 Agent
本机管理员批准。

Web 端持久化的目标配置只包含 Relay URL、Agent device ID 和可选显示名称。
`email_link` 登录产生的 Relay session token 只保存在当前浏览器标签页的
`sessionStorage`，随标签页会话清除，不写入 `localStorage`；服务端 token 按自身
有效期或撤销状态失效。Native 端继续使用
平台安全存储保存完整配对配置。

无 Relay 登录 cookie 的 App 从该 Relay 的 `/auth/` 获取独立私密 session token。
先填写或扫码导入目标，再输入 token；扫码先填入表单供核对。手动、链接、扫码及
模式切换都按 Relay origin 清理旧 token，提交时再核对来源，避免发送给其他 Relay。

连接流程：

1. App 发送包含目标 Agent ID、App ID、公钥和 App 元数据的
   `mobile.connect`。
2. Relay 根据目标 ID 定位在线 Agent，把该连接登记的 Agent 公钥放入
   `auth.challenge`，并绑定两端连接 ID。
3. App 验证该公钥能派生出目标 `device_id`，再对 challenge、双方身份、App
   元数据、请求 scope 和时间戳签名，发送 `auth.proof`。
4. Relay 验签并转发 `auth.verify`。
5. 已信任 App 直接进入授权；未知或已撤销 App 根据 Desktop Agent 的
   `appAuthorization.mode` 处理：
   - `manual`（默认）：进入 `auth.pending`，由用户在 Agent Admin 本机页面
     批准或拒绝。待批准项按 App ID 去重，列表展示名称、设备类型和 Relay
     观测 IP；点击可查看 App/设备身份、申请 scope 与时间，并在详情内处理。
     单次待批准请求有效期为 2 分钟，超时返回 `approval_timeout`；App 可重连
     后重新申请。
   - `automatic`：身份签名和 scope 校验通过后立即持久化信任并授权。
6. Agent 返回签名 `auth.ok`，绑定双方身份、连接 ID、scope 和 nonce。
7. App 验证 Agent 签名后才开始 E2E 握手。

可信 App 记录保存在 `trusted-apps-v2.json`，包含 App ID、公钥、scope、状态和
审批时间。撤销会持久化状态、通知在线 App `auth.failed(revoked)`，并立即清理
对应 E2E/P2P 连接状态。Agent Admin 也支持移除设备：删除可信记录及其本机连接
观测，同时断开在线 App。被撤销或移除的 App 再次连接时都会重新进入本机批准
流程；如果 `appAuthorization.mode=automatic`，则会在下一次有效连接时重新自动
批准。

## E2E 会话

App 与 Agent 各自生成临时 X25519 密钥：

- App 使用长期 Ed25519 私钥签名握手 init。
- Agent 验证 App 身份和签名后，使用长期 Ed25519 私钥签名 reply。
- 签名覆盖双方 ID、公钥、Relay 连接 ID、handshake ID、临时公钥和协议版本。
- X25519 共享秘密经 HKDF-SHA256 派生双向会话密钥。
- 业务消息使用 ChaCha20-Poly1305，并通过单调序列号拒绝重放和乱序。

所有业务消息必须封装为 `e2e.message`。Relay/P2P 只是传输路径，切换路径不
改变身份或会话安全边界。

Agent 在 ready 或密文校验失败后通知 App `e2e.failed`，撤销该连接的认证状态并
清理 E2E/P2P。App 收到当前连接的 `e2e.failed`，或 ready、握手签名、密文校验失败时，关闭
会话并通知界面失败，同时清理密钥、心跳和待发送队列。连接关闭后，未完成的
签名与 P2P 协商结果不得恢复连接状态。Agent 和 App 两端的在途 peer 创建、
offer/answer 在撤销或关闭后失效；迟到 peer 立即关闭，旧回调不能影响新协商。
Direct only 必须同时满足 E2E 和 P2P
就绪才显示在线；失败后的迟到 ready 不能覆盖失败状态。

## 日志与恢复

- 不记录私钥、Probe token、签名原文或业务明文。
- 可记录 ID、连接 ID、审批结果和失败原因。
- Agent 或 App 身份文件丢失等同于新身份，需要重新登记或重新批准。
- 连接断开后使用长期身份重新挑战；不复用旧 E2E 会话密钥。
- 心跳超时只标记观测状态；原连接收到合法 E2E 流量可恢复活跃。显式 goodbye、
  撤销和 Relay 断开会清除连接信任，迟到流量不能恢复它们。
