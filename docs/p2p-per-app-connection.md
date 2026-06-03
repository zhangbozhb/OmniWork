# P2P Per App Connection 设计

本文记录多 App 并发后的 P2P per App connection 设计与实现边界。
P2P 升级粒度已从 `device_id` 下沉到 `(device_id, app_connection_id)`。

## 背景

- 同一个 Agent 可以同时服务多个 App 连接。
- 每个 App 连接都有独立的 `app_connection_id`、Noise E2E session 和 seq。
- P2P 是传输优化，不是业务安全边界。
- DataChannel 只按 `app_connection_id` 承载对应 App 连接的 E2E 密文。

## 目标

- P2P 升级粒度从 `device_id` 下沉到 `(device_id, app_connection_id)`。
- App A 的 P2P 状态不影响 App B。
- App A 的 DataChannel 不能承载 App B 的业务密文。
- P2P 成功、失败、降级只改变该 App 连接的路径选择，不改变 E2E session。

## 协议边界

- `tunnel.upgrade.*` 必须携带 `app_connection_id`。
- Relay 以 mobile WebSocket connection id 作为 canonical `app_connection_id`。
- `tunnel.upgrade.propose` 由 Relay 按已 ready 的 App 连接定向下发，只作为 P2P 升级提示。
- offer / answer / candidate / committed / downgrade 属于 P2P 控制面信令，只在对应 App-Agent E2E pair ready 后由 Relay 按 `app_connection_id` 透传；业务 payload 仍通过 App-Agent E2E 封装传递。
- Mobile -> Agent 与 Agent -> Mobile 的升级控制消息都必须绑定同一个 `app_connection_id`。

## Relay 改造

- `RelayUpgradeOrchestrator` 的 timer、in-flight、active 和 backoff 均按
  `deviceId + appConnectionId` 管理。
- `notifyMobileAuthenticated` 只为对应 mobile connection 调度 propose。
- `/debug/upgrade` 必须显式传入 `app_connection_id`，不能默认选第一个 mobile。
- Relay 只在对应 App 的 E2E pair ready 后触发 propose。

## Agent 改造

- `UpgradeCoordinator` 从单实例改为按 `app_connection_id` 管理。
- `AgentSessionTransport` 按 `e2e.message.payload.app_connection_id` 选择对应 DataChannel。
- Agent 发送业务消息时继续使用对应 App 的 `E2ENoiseSession` 加密。
- DataChannel 建立成功后，只替换对应 App 的传输路径。

## App 改造

- App 单连接模型可保持不变。
- App 使用 `auth.ok.connection_id` 作为 `app_connection_id`。
- App 的 P2P coordinator 只处理自身 `app_connection_id` 的 upgrade 控制消息。
- 收到其他 `app_connection_id` 的 upgrade 控制消息必须丢弃。

## 验收

- 两个 App 同连一个 Agent，App A P2P 成功不影响 App B relay path。
- App A P2P 降级不导致 App B 降级。
- Relay 错路由 App A 的 P2P 控制消息到 App B 时，App B 拒绝。
- DataChannel 上重放、篡改、错 `app_connection_id` 的 `e2e.message` 均无法解密。
- 关闭 App A 后只清理 App A 的 P2P 状态和订阅，不影响 App B。
