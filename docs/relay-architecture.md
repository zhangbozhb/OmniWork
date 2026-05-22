# Relay 架构

文档版本：1.0（终版）
最后更新：2026-05-22
关联文档：

- [relay-architecture-implementation.md](./relay-architecture-implementation.md)：分阶段实施计划与变更明细
- [engineering-requirements.md](./engineering-requirements.md)
- [auth-key-design.md](./auth-key-design.md)
- 旧方案归档：[archive/intranet-tunnel-technical-solution-v1.md](./archive/intranet-tunnel-technical-solution-v1.md)

本篇是 OmniWork 中继与 P2P 升级链路的最终参考。所有客户端、Relay 与运维的预期行为都以本文为准。

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
- **业务协议**（`session.*`、`terminal.*`、`auth.*`、`workspace.*`、`files.*`、`git.*`、`agent.heartbeat`）零修改，路径切换由传输层吸收。完整消息族以 [packages/protocol-ts/src/index.ts](../packages/protocol-ts/src/index.ts) 为单一来源，对应 JSON Schema 见 [protocol/](../protocol/)。

## 2. 关键抽象

| 抽象 | 位置 | 职责 |
|---|---|---|
| `SessionTransport` | `mac/agent/src/transport/`、`app/src/lib/transport/` | 业务模块面对的统一接口；`send` / `onMessage` / `switchPath` / `onPathChange` / `onEvent` |
| `WebRtcPeerAdapter` | 同上 | 跨平台 WebRTC peer 抽象；Agent 用 `@roamhq/wrtc`，App 用 `react-native-webrtc`，Web 返回 null |
| `UpgradeCoordinator` | 同上 | 客户端升级状态机（idle → proposed → negotiating → committing → upgraded） |
| `RelayUpgradeOrchestrator` | `relay/server/src/upgrade/orchestrator.ts` | Relay 端：触发条件、灰度、退避、metrics、控制消息透传 |

## 3. 升级流程

### 3.1 触发

- App 通过 `mobile.connect` + `auth.proof` 鉴权成功 → Relay 调用 `notifyMobileAuthenticated`。
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

降级后 Relay 端按 `device_id` 累计失败次数指数退避：30s → 2min → 10min → 永不再尝试（直到 mobile 重连或 device 重新进入流程）。双端任一次 `committed` 成功都会清零该 device 的 backoff 计数。

## 5. Relay 配置项

完整示例见 [relay/server/README.md](../relay/server/README.md)。升级相关项：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OMNIWORK_UPGRADE_ENABLED` | `true` | 全局开关；`false` 时 Relay 永远不发起 propose |
| `OMNIWORK_UPGRADE_ROLLOUT` | `100` | 灰度百分比 0..100；按 `sha1(device_id)` 哈希分桶 |
| `OMNIWORK_UPGRADE_DEVICE_BLOCKLIST` | （空） | 逗号分隔 device_id；命中的 device 永不升级 |
| `OMNIWORK_UPGRADE_ICE_SERVERS_JSON` | `[{"urls":"stun:stun.l.google.com:19302"}]` | propose 阶段下发的 ICE servers |
| `OMNIWORK_UPGRADE_PROPOSE_DELAY_MS` | `3000` | 鉴权完成到 propose 的稳定窗口 |

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
- `in_flight`：已 propose 未双端 committed 的升级数。
- `active_p2p`：当前已升级到 P2P 且尚未降级的 device 数。
- `durations`：最近最多 100 次升级耗时（`startedAt → 双端 committed`）的 p50/p95/max（毫秒）。

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

- 错误 `RelayConfigError: refusing to start on non-loopback host`：非 loopback host 必须设置 `OMNIWORK_RELAY_TRUST_FORWARDED_TLS=true`，且必须由前置 HTTPS / wss 反代终止 TLS。

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
