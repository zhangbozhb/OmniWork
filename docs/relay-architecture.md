# Relay 架构

文档版本：1.0（终版）
最后更新：2026-05-22
关联文档：

- [relay-architecture-implementation.md](./relay-architecture-implementation.md)：当前实施状态与后续演进边界
- [engineering-requirements.md](./engineering-requirements.md)
- [auth-key-design.md](./auth-key-design.md)

本篇是 OmniWork 中继与 P2P 升级链路的最终参考。所有客户端、Relay 与运维的预期行为都以本文为准。

实现顺序说明：P2P 传输升级能力已先行落地；当前安全改造是在既有 relay path 与 p2p path 之上补齐 App-Agent E2E 加密。本文描述最终目标态：路径可在 Relay 与 P2P 间切换，但业务 payload 安全统一由 E2E 保障。

## 1. 总体形态

```text
+----------+      WebSocket / wss      +-------------+      WebSocket / wss      +-----------+
|   App    | <-----------------------> |    Relay    | <-----------------------> |   Agent   |
| (RN/Web) |   default business path   |  (公网入口)   |   default business path   |  (macOS)  |
+----------+                           +-------------+                           +-----------+
     ^                                                                                  ^
     |                       WebRTC DataChannel (优选业务路径)                            |
     +----------------------------------------------------------------------------------+
                              (可选，由 Relay 协调升级；失败自动降级)
```

- **Relay**：始终在线、公网可达，承载 WS 业务中继与升级控制面（SDP/ICE 透传）。本身不再持有任何 `RTCPeerConnection`。
- **Agent**：macOS Node 进程，使用 `@roamhq/wrtc` 充当 P2P answerer。
- **App**：React Native（`react-native-webrtc`）/ Web（仅 relay path），充当 P2P offerer。
- **业务协议**（`session.*`、`terminal.*`、`auth.*`、`workspace.*`、`files.*`、`git.*`、`agent.heartbeat`）由 E2E 内层 envelope 承载；路径切换由传输层吸收。完整消息族以 [packages/protocol-ts/src/index.ts](../packages/protocol-ts/src/index.ts) 为单一来源，对应 JSON Schema 见 [protocol/](../protocol/)。

## 2. 关键抽象

| 抽象 | 位置 | 职责 |
|---|---|---|
| `SessionTransport` | `mac/agent/src/transport/`、`app/src/lib/transport/` | 业务模块面对的统一接口；`send` / `onMessage` / `switchPath` / `onPathChange` / `onEvent` |
| `WebRtcPeerAdapter` | 同上 | 跨平台 WebRTC peer 抽象；Agent 用 `@roamhq/wrtc`，App 用 `react-native-webrtc`，Web 返回 null |
| `UpgradeCoordinator` | 同上 | 客户端升级状态机（idle → proposed → negotiating → committing → upgraded） |
| `RelayUpgradeOrchestrator` | `relay/server/src/upgrade/orchestrator.ts` | Relay 端：触发条件、灰度、退避、metrics、控制消息透传 |

## 3. 升级流程

### 3.1 触发

- 目标态：App 通过 `mobile.connect` + `auth.proof` 完成 Relay 接入鉴权后，必须继续完成 App-Agent E2E 握手；Relay 只在 mobile 进入 `e2e_ready` 后调用 `notifyMobileAuthenticated`。
- 演进说明：P2P 触发能力已先于 E2E 落地；E2E 接入期间需要把原先“auth 后可 propose”的触发点收口到 `e2e_ready` 后。
- 经过 `OMNIWORK_UPGRADE_PROPOSE_DELAY_MS`（默认 3000ms）稳定窗口后，若 device 未被 enabled / blocklist / 灰度 / 退避 拒绝，则 Relay 同时向 App（`role: offerer`）和 Agent（`role: answerer`）发送 `tunnel.upgrade.propose`。

### 3.2 协商

```text
App                       Relay                       Agent
 |  propose(offerer) <------|------> propose(answerer)  |
 |--- tunnel.upgrade.offer ------------------------------>|
 |<-- tunnel.upgrade.answer ------------------------------|
 |<== tunnel.upgrade.candidate (双向多次) ===============>|
 |   (ICE 连通后双方 DataChannel.onopen)
 |--- tunnel.upgrade.committed ------------------------->|
 |<-- tunnel.upgrade.committed --------------------------|
 |   双端 SessionTransport.switchPath('p2p')             |
```

- Relay 不解析 SDP/ICE 内容；仅按 `device_id` 路由 + 记录 `upgrade_id` 用于审计。
- 业务消息切换：`switchPath` 内部 quiesce → drain（等 `DRAIN_DELAY_MS` 即可，因为业务消息是带 `request_id` 的幂等请求） → resume；切换瞬间 `send` 入队，不丢失。

### 3.3 升级期约束

- 同一时刻同一 device 只能存在一个 upgrade（再次 propose 将被 coordinator 忽略）。
- 客户端单次 upgrade 总超时（默认 10s，可配 `timeoutMs`）；超时即 `downgrade("timeout")`。
- `peerFactory` 返回 null（如 Web 平台 / wrtc 加载失败） → 立即 `downgrade("peer_unavailable")`。

## 4. 降级触发清单

任何一项满足都会触发 `SessionTransport.switchPath('relay')` + 发送 `tunnel.upgrade.downgrade`：

| 触发源 | 条件 | reason |
|---|---|---|
| 应用层心跳 | `transport.pong` 连续超时 ≥ 3 次（间隔 5s，单次超时 1s） | `pong_timeout` |
| DataChannel 背压 | `bufferedAmount > 1MB` 持续 ≥ 5s（每 1s 采样） | `buffered_overflow` |
| ICE 状态 | `disconnected` 持续 ≥ 3s | `ice_disconnected` |
| ICE 状态 | `failed` | `ice_failed` |
| App 生命周期 | `AppState` ≠ `active`（进入 background / inactive） | `app_background` |
| 客户端协商 | 升级总超时 | `timeout` |
| 客户端协商 | `peerFactory` 返回 null | `peer_unavailable` |
| 任意端业务异常 | 调用 `forceDowngrade(reason)` | 自定义 |
| 客户端主动关闭 | App `transport.close()` 时 `currentPath==='p2p'`（如切换 `transport_preference`、退出账号） | `client_closing` |

降级后 Relay 端按 `device_id` 累计失败次数指数退避：30s → 2min → 10min → 永不再尝试（直到 mobile 重连或 device 重新进入流程）。双端任一次 `committed` 成功都会清零该 device 的 backoff 计数。`client_closing` 例外——它表达"用户主动切换偏好/退出账号"的礼貌降级，仅用于让对端立即清理 PeerConnection 与 metrics 计数，不计入退避，避免 `prefer_p2p ↔ relay_only` 反复切换时第二次回到 `prefer_p2p` 落入 `backoff_active` 死锁。

> 严格 P2P 模式（`transport_preference=prefer_p2p`）下，上述任意触发源都不会切回 relay path：`UpgradeCoordinator` 仍会发送 `tunnel.upgrade.downgrade`（用于 metrics 与退避），但本地不调用 `switchPath('relay')`，而是经 `SessionTransport.forceClose(reason)` 关闭整个 session。`AppState` 进入后台时改走 `pauseForBackground()` / `resumeForForeground()`，不算协商失败，不计入退避。详见 §6.1。

## 5. Relay 配置项

完整示例见 [relay/server/README.md](../relay/server/README.md)。升级相关项：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OMNIWORK_UPGRADE_ENABLED` | `true` | 全局开关；`false` 时 Relay 永远不发起 propose |
| `OMNIWORK_UPGRADE_ROLLOUT` | `100` | 灰度百分比 0..100；按 `sha1(device_id)` 哈希分桶 |
| `OMNIWORK_UPGRADE_DEVICE_BLOCKLIST` | （空） | 逗号分隔 device_id；命中的 device 永不升级 |
| `OMNIWORK_UPGRADE_ICE_SERVERS_JSON` | `[{"urls":"stun:stun.l.google.com:19302"}]` | propose 阶段下发的 ICE servers |
| `OMNIWORK_UPGRADE_PROPOSE_DELAY_MS` | `3000` | 鉴权完成到 propose 的稳定窗口 |
| `OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF` | `true` | 是否尊重 App `mobile.connect.transport_preference`；`false` 时 Relay 全部按 `auto` 处理（运维回滚开关） |

客户端可观测开关：

| 环境变量 | 端 | 说明 |
|---|---|---|
| `OMNIWORK_LOG_TRANSPORT` | Agent / App | `=1` 打印 transport 详细事件（path_change / ping_timeout / pong_received / downgrade / upgrade_*） |

## 6. /metrics 字段

`GET /metrics` 返回 JSON：

```json
{
  "proposed": 12,
  "committed": 20,
  "failed": { "ice_failed": 1 },
  "downgrade": { "app_background": 3, "pong_timeout": 1 },
  "prefs": { "auto": 18, "relay_only": 2, "prefer_p2p": 1 },
  "skipped_by_pref": 2,
  "in_flight": 0,
  "active_p2p": 2,
  "durations": { "count": 10, "p50_ms": 850, "p95_ms": 1820, "max_ms": 2400 }
}
```

字段语义：

- `proposed`：累计发起 propose 次数。
- `committed`：累计 `tunnel.upgrade.committed` 收到次数（双端各一次，所以 `committed` 通常约为 `proposed * 2`）。
- `failed[reason]`：升级失败原因分布（来自 `tunnel.upgrade.downgrade` 的 reason）。
- `downgrade[reason]`：与 `failed` 同源；保留两份是为后续区分"协商期失败" vs "运行期降级"，目前等价。
- `prefs[preference]`：按 `transport_preference` 三态统计 mobile 鉴权后落到 orchestrator 的次数；`OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF=false` 时全部计入 `auto`。
- `skipped_by_pref`：因 `transport_preference=relay_only` 而跳过 propose 的次数（不计入 `failed`，不进入退避）。
- `in_flight`：已 propose 未双端 committed 的升级数。
- `active_p2p`：当前已升级到 P2P 且尚未降级的 device 数。
- `durations`：最近最多 100 次升级耗时（`startedAt → 双端 committed`）的 p50/p95/max（毫秒）。

## 6.1 传输偏好可控

App 在 `mobile.connect.payload.transport_preference` 中显式声明传输偏好，由 Relay 在 propose 守门时读取，并按以下三态分流：

| 取值 | App 行为 | Relay 行为 |
|---|---|---|
| `auto`（默认） | 接受任何 propose | 仍按 `enabled` / `blocklist` / 灰度 / 退避 决策 |
| `prefer_p2p` | 严格 P2P：业务消息只走 DataChannel；协商或运行期失败即关闭 session | 跳过灰度（rollout）守门；propose payload 携带 `strict: true`；仍受 `enabled` / `blocklist` / 退避 限制 |
| `relay_only` | `peerFactory` 直接返回 `null`（防御性兜底，coordinator 标记 `peer_unavailable`） | 跳过 propose，不进入退避，不计 `failed`；累计 `skipped_by_pref` |

字段缺省时 Relay 视为 `auto`。运维需要全局忽略 App 偏好时设 `OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF=false`，Relay 会忽略 `transport_preference` 强制按 `auto` 流程执行（且不再下发 `strict: true`）。

App 端偏好的双层来源：

- 出厂默认：`app/src/app/appConfig.ts` 的 `transportPreference`（默认 `auto`），可由打包注入 `__OMNIWORK_APP_CONFIG__` 调整。
- 用户覆盖：底部全局 `Settings` 入口提供 `Connection mode` 三态开关；选中即写入 `AsyncStorage["omniwork.transportPreference"]`，并触发当前活动 pairing 的会话重连，使新偏好通过 `mobile.connect` 立即生效。

面向用户的 UI 文案与底层取值映射如下：

| UI 文案 | 底层取值 | 用户语义 |
|---|---|---|
| `Auto` | `auto` | 推荐模式：优先尝试 Direct，必要时允许 Relay 辅助连接 |
| `Direct only` | `prefer_p2p` | 隐私优先：直连建立后，session payload data 不由 Relay 承载；直连不可用时 session 失败 |
| `Relay only` | `relay_only` | 可靠性/诊断模式：固定使用 relay path；session payload data 仍保持加密 |

设备主界面展示当前实际连接路径，而不是底层协议枚举：`currentPath==='p2p'` 显示 `Direct`，`currentPath==='relay'` 显示 `Relay assisted`。控制面、认证和升级协商仍可能经过 Relay；`Direct only` 的承诺限定在业务 session payload data 不走 Relay 承载。

### 严格 P2P 模式（`prefer_p2p`）行为细节

收到 `propose.strict=true` 后：

- **控制面准入门 + 业务消息暂存**：`SessionTransport` 在 `currentPath==='relay'` 时只放行控制面消息（`tunnel.upgrade.*` / `transport.*`）。其他业务消息**不再 throw**，而是暂存到 `strictPendingQueue`（上限 `STRICT_PENDING_QUEUE_LIMIT=256`，与 `WebRtcPeerAdapter.pendingSends` 对齐）；一旦双端 `committed`、`switchPath('p2p')` 完成，队列会被 flush 出去并恢复正常下发。队列超过上限时直接 emit `pending_drop(reason="queue_overflow", count)` 并触发 `forceClose('strict_pending_overflow')`，不再静默丢弃；`close` / `forceClose` 时若队列非空，亦各自 emit `pending_drop(reason="session_close" | "force_close")`，由业务侧记录度量。agent 端的 `configureStrictP2p` 仅用于切换偏好语义，仍走静默清空路径。
- **DataChannel 未 open 防丢失**：双端 `WebRtcPeerAdapter.send()` 在 `dataChannel.readyState === 'connecting'` 时把消息暂存到 adapter 内部 `pendingSends` 队列（上限 256，超出丢最旧），`dataChannel.onopen` 时统一 flush。这样即便 ICE `connected` 抢跑 SCTP 握手，commit 后从 `strictPendingQueue` flush 到 peer 的首批业务消息也不会被静默丢弃。
- **dispatchSend 守门**：`SessionTransport.dispatchSend()` 在严格模式下若处于 `currentPath==='p2p'` 但 `peer===null` 的脱钩状态（健康降级竞态、forceClose 后状态机未及时复位等），不会 fallback 到 relay path，而是发出 `strict_send_blocked` 事件并触发 `forceClose('peer_missing')` 关闭整个 session，避免业务消息泄漏到 Relay。
- **forceClose 唯一入口（P2-3D）**：所有 strict 关闭路径——coordinator 协商失败 / 运行期健康降级 / Relay 主动 `strict_unavailable` / `dispatchSend` peer 脱钩——统一汇聚到 `SessionTransport.forceClose(reason)`：先 emit `force_close`、`detachP2pPeer`、`resetPathState`、非空时 emit `pending_drop("force_close")`，再回调 `downgradeHandler` 让 coordinator 发出 `tunnel.upgrade.downgrade`（保留 Relay metrics 与退避计数），最后回调 `forceCloseHandler` 让业务上层提示用户。`forceClose` 自带重入保护，重复调用立即返回。
- **close 与 forceClose 正交（P2-3E）**：`close()` 表达"session 生命周期结束"，仅做 detach + 释放回调注册表；`forceClose()` 表达"strict 模式下不可用，需上报上层"。两者互不调用，`close()` 不会触发 `forceCloseHandler`，避免 sessionTransport 关停时被误识别为 strict 失败。两者均设 `closed` / `forceClosed` 重入哨兵。
- **状态机完整 reset**：`forceClose` 与（agent 端的）`configureStrictP2p` 都会调用 `resetPathState()`，把 `currentPath` 切回 `relay`、清掉 `outboundQueue / switching` 标记并广播 `path_change`；让 transport 跨多次 mobile 连接复用时回归"刚创建未升级"的初始态，避免下一轮 propose 因 `currentPath==='p2p'` 残留导致 `switchPath('p2p')` 被 short-circuit。
- **降级处理**：协商失败（`timeout` / `peer_unavailable` / `ice_failed` 等）或运行期降级触发源（`pong_timeout` / `buffered_overflow` / `ice_disconnected` 等）都不会回退 relay。`UpgradeCoordinator` 发出 `tunnel.upgrade.downgrade`（仍计入 Relay metrics 与退避）后，调用 `SessionTransport.forceClose(reason)` 关闭整个 session。业务上层收到 `force_close` 事件，由用户决定是否重连或切换偏好。
- **心跳/超时阈值**：strict 模式下 `SessionTransport` 使用更宽松的健康阈值（`STRICT_PING_INTERVAL=3s` / `STRICT_PING_TIMEOUT=3s` / 连续 5 次未收到 pong 才计入失败 / `STRICT_ICE_DISCONNECTED_GRACE=10s`），避免移动网络瞬时丢包或 ICE 抖动直接触发不可恢复的 `forceClose`。`auto` 模式仍走原始阈值（5s / 1s / 3 次 / 3s）。
- **Relay 守门主动下发 downgrade**：`prefer_p2p` 偏好被 Relay 端 `enabled=false` / `deviceBlocklist` / 退避窗口命中时，orchestrator 不再静默吞掉 propose，而是主动向 mobile 下发 `tunnel.upgrade.downgrade(reason="strict_unavailable:<cause>")`（cause ∈ `relay_disabled` / `blocklisted` / `backoff_active`），并写入 `metrics.downgrade["strict_unavailable:<cause>"]`。App 端在收到该 reason 时直接调用 `transport.forceClose(reason)`，由 UI 把原因翻译成面向用户的友好文案。
- **后台处理**：`AppState` 进入 background / inactive 时走 `pauseForBackground()`，标记 `awaiting_resume`，session 保持但暂停 P2P 心跳；回到 foreground 时 `resumeForForeground()` 重新提议升级。该过程不算协商失败，不增加退避，也不触发 `forceClose`。
- **TURN 默认禁用**：`webRtcPeerAdapter` 在 `onicecandidate` 阶段过滤掉所有 `typ relay` candidate，确保仅打通 host / srflx / prflx 直连路径。如严苛 NAT 下 ICE 失败，按上一条直接关闭 session。
- **Web/wrtc 加载失败**：`peerFactory` 返回 null 时 coordinator 立即 `downgrade("peer_unavailable")`，严格模式下转 `forceClose`，不建立 session。
- **Metrics**：协商期失败仍按 `failed[reason]` 计入（`timeout` / `peer_unavailable` / `ice_failed` 等），Relay backoff 与 `auto` 模式一致；可在监控侧按 `prefs.prefer_p2p` × `failed[reason]` 维度过滤出严格模式失败率。

## 7. 升级控制面日志

Relay 通过 `logUpgradeEvent` 输出 JSON 行：

```json
{"ts":"2026-05-22T03:11:09.000Z","component":"omniwork-relay","event":"tunnel.upgrade.committed","upgrade_id":"...","device_id":"...","source_role":"mobile"}
```

所有 `tunnel.upgrade.*` 透传消息都会写一行日志；额外事件：

- `debug.trigger_upgrade`：通过 `POST /debug/upgrade?device_id=xxx` 手工触发。

客户端事件通过 `coordinator.onEvent` / `transport.onEvent` 暴露给业务侧 logger：`upgrade_proposed` / `upgrade_committed` / `upgrade_failed` / `path_change` / `ping_timeout` / `pong_received` / `downgrade`。

## 8. 故障排查 runbook

### 8.1 Relay 无法启动

- 错误 `RelayConfigError: refusing to start on non-loopback host`：非 loopback host 使用 `ws://` 时必须设置 `OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true`，且 `OMNIWORK_RELAY_REQUIRE_E2E=true` 必须保持开启。`wss://` 仍推荐，但业务安全边界是 App-Agent E2E。

### 8.2 始终走 relay path，从未升级

1. `GET /metrics` 看 `proposed` 是否 > 0。
   - 等于 0：检查 `OMNIWORK_UPGRADE_ENABLED`、`OMNIWORK_UPGRADE_ROLLOUT`、`OMNIWORK_UPGRADE_DEVICE_BLOCKLIST`；确认 mobile 鉴权在 `proposeDelayMs` 窗口内未断线。
   - 大于 0、`committed` 0：协商失败。看 `failed[*]`；最常见 `ice_failed`（NAT 严苛 / UDP 被拦） / `peer_unavailable`（wrtc 加载失败 / Web 端）。
2. 客户端开 `OMNIWORK_LOG_TRANSPORT=1`，重连观察日志：
   - 没有 `path_change to=p2p`：协商未完成。
   - 有 `path_change to=p2p` 然后 `path_change to=relay`：升级成功后立即降级，看 `downgrade reason`。

### 8.3 频繁升级 / 降级抖动

- 看客户端 `downgrade reason` 分布：
  - `pong_timeout`：底层链路有抖动；可能 NAT keepalive 不足或带宽饱和。
  - `buffered_overflow`：业务突发写入 > 1MB/5s；评估是否需要应用层分片或 backpressure。
  - `ice_disconnected` / `ice_failed`：网络切换或 UDP 通路失效。
  - `app_background`：iOS/Android 切后台必发，属预期行为；前台再上来后 Relay 会按退避决定是否重新 propose。
- Relay backoff 行为：见 §4 末段。如需手工清退避，重连 mobile（`notifyMobileDisconnected → notifyMobileAuthenticated`）即可。

### 8.4 P2P 路径上消息卡顿

- `getMetrics().active_p2p` 不为 0 但业务无响应：在客户端开 `OMNIWORK_LOG_TRANSPORT=1`，确认是否 `pong_received rtt_ms` 异常增长；可手工 `forceDowngrade("manual")` 切回 relay 验证。

### 8.5 手工触发 upgrade（调试）

```sh
curl -X POST "http://<relay-host>:<port>/debug/upgrade?device_id=<id>"
```

成功响应：

```json
{ "ok": true, "upgrade_id": "upg_..." }
```

失败响应：

- `400 { "error": "missing_device_id" }`：未传 query 参数。
- `404 { "error": "device_not_online" }`：device 当前没有 agent 或 mobile 在线。

注意：`/debug/upgrade` 直接走 `triggerUpgrade`，**不会受 ROLLOUT / DEVICE_BLOCKLIST / 退避 限制**——它只要求双端都已连接。该次 trigger 会进入 metrics 统计与日志（event=`debug.trigger_upgrade`），常用于本地或 staging 验证升级链路（见 `pnpm verify:upgrade:simulator`）。

## 9. 已知限制 / 不在范围

- 仅自建 STUN，未自建 TURN；严苛 NAT 下会停留在 relay path。
- 单 Relay；多区域 / 异地多活不在 v1 范围。
- Web 端不参与 P2P（`peerFactory` 返回 null，永远 relay path）。
- iOS 后台保活、Live Activity 等系统级保留 P2P 的能力不做。
