# Relay 架构升级实施计划

文档版本：1.0
创建日期：2026-05-21
关联文档：

- [archive/intranet-tunnel-technical-solution-v1.md](./archive/intranet-tunnel-technical-solution-v1.md)（已归档的旧方案，保留作历史背景）
- [relay-architecture.md](./relay-architecture.md)（终版架构与运行手册）
- [engineering-requirements.md](./engineering-requirements.md)
- [auth-key-design.md](./auth-key-design.md)

## 1. 目标与原则

### 1.1 架构目标

- **Relay 默认作为 App ↔ Agent 业务数据中继**，长期在线、公网可达、无业务状态。
- **在可能的情况下，由 Relay 协调把 App 与 Agent 升级为端到端 P2P 直连**（WebRTC DataChannel），升级成功后业务数据走 P2P，Relay 仅保留心跳与控制面。
- **任何升级失败、降级、网络切换均对业务层完全无感**：业务消息接口不变，路径切换由传输层吸收。
- **Relay 不再承担任何 WebRTC peer 角色**，只透传升级所需的 SDP / ICE 控制消息。
- **删除独立 tunnel-service**：Relay 必须公网可达（自有公网 IP 或经 Cloudflare Tunnel 暴露）。

### 1.2 核心原则

- 业务协议（Envelope、`session.*`、`terminal.*`、`auth.*`、`workspace.*`、`files.*`、`git.*`）零修改。
- 复杂度收敛到 4 个新抽象（`SessionTransport`、`UpgradeCoordinator`、`WebRtcPeerAdapter`、`RelayUpgradeOrchestrator`），不外溢到业务代码。
- 失败优先降级，不阻塞主流程。
- 每阶段交付都必须保持业务功能完整，不存在"中间不可用窗口"。

### 1.3 角色职责（升级后）

| 角色 | 数据面 | 控制面 |
|---|---|---|
| Relay | 始终承载 WS 业务中继（默认通路 + 降级承载） | 升级协调者：透传 SDP/ICE，维护升级状态 |
| Agent | WS 客户端 + 可选 WebRTC peer（`@roamhq/wrtc`） | 响应升级提议，执行 quiesce/drain/resume |
| App | WS 客户端 + 可选 WebRTC peer（`react-native-webrtc`） | 响应升级提议，执行 quiesce/drain/resume |

## 2. 总体路线图

```text
阶段 0: 依赖与可行性 spike       (1-2 天)
阶段 1: 删除 tunnel-service / Relay WebRTC peer   (2-3 天)
阶段 2: 引入 SessionTransport（仅 WS 实现）       (3-5 天)
阶段 3: WebRtcPeerAdapter + UpgradeCoordinator     (5-7 天)
阶段 4: RelayUpgradeOrchestrator + 灰度策略       (3-4 天)
阶段 5: 健康探测 + 自动降级 + 可观测性             (3-5 天)
```

每阶段独立可发布。建议至少在阶段 1、阶段 2 完成后各发一次内部版本，确认基础链路稳态。

---

## 阶段 0：依赖与可行性 spike

**目标**：消除 `@roamhq/wrtc` 在目标 macOS 用户机上的安装与运行不确定性，确认 Agent 端 P2P 能力可用。

### 任务 0.1：新增 spike 工程

- 新建临时目录 `scripts/spike/agent-wrtc/`（spike 完成后删除）。
- 写一个最小 Node 脚本：使用 `@roamhq/wrtc` 创建两个本地 PeerConnection，建立 DataChannel，互发 echo 消息。
- 运行环境覆盖：macOS arm64 (Apple Silicon)、macOS x64（如有目标用户）。

### 任务 0.2：依赖兼容性检查

- 确认 `@roamhq/wrtc` 与 Agent 当前 Node 版本（参考 [mac/agent/package.json](../mac/agent/package.json)）兼容。
- 验证 `pnpm install` 在目标机器上不出现 native 编译失败。
- 记录失败案例与缓解措施（例如要求最低 Node 版本、必要的 Xcode CLI 工具）。

### 任务 0.3：决策点

- 通过：进入阶段 1。
- 失败：评估是否改用纯 WebSocket 方案（保留 Relay 中继，不做 P2P 升级）。本文档其余阶段视情况调整。

### 验收标准

- `node spike.mjs` 输出 `peer-to-peer echo ok`。
- 在至少一台目标 Mac 上 `pnpm install` 全部通过且 spike 脚本可重复运行。
- 输出 spike 结论备忘（写入 [docs/relay-architecture-implementation.md](./relay-architecture-implementation.md) 末尾"附录 A"）。

---

## 阶段 1：删除 tunnel-service / Relay WebRTC peer

**目标**：把架构回到"App↔Relay↔Agent 全 WebSocket"的最小可用形态，删除所有不再需要的代码与配置。完成后业务功能完整，但暂时没有 P2P 升级能力。

### 任务 1.1：删除 tunnel-service

- 删除目录 [relay/tunnel-service/](../relay/tunnel-service/)。
- 从 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 中移除该包。
- 从根 [package.json](../package.json) 删除 `dev:tunnel`、`tunnel:start`、`verify:tunnel`、`verify:public-tunnel-webrtc:e2e` 脚本。
- 删除 [scripts/verify/public-tunnel-webrtc.e2e.mjs](../scripts/verify/public-tunnel-webrtc.e2e.mjs)。

### 任务 1.2：移除 Relay 的 WebRTC peer 实现

- 删除 [relay/server/src/dataChannelSocket.ts](../relay/server/src/dataChannelSocket.ts)。
- 删除 [relay/server/src/webrtcFactory.ts](../relay/server/src/webrtcFactory.ts)。
- 修改 [relay/server/src/relayServer.ts](../relay/server/src/relayServer.ts)：
  - 移除所有 `RTCPeerConnection`、`createOffer`、ICE candidate 处理逻辑。
  - 移除 `/tunnel/mobile` endpoint。
  - 移除 `OMNIWORK_TUNNEL_SERVICE_RELAY_URL` 主动注册逻辑。
  - 保留 `/agent` 和 `/mobile` WS endpoint，仅做 device_id 路由 + Envelope 透传。
- 从 [relay/server/package.json](../relay/server/package.json) 移除 `@roamhq/wrtc` 依赖。
- 更新 [relay/server/src/config.ts](../relay/server/src/config.ts)：删除 `OMNIWORK_TUNNEL_*` 相关配置。

### 任务 1.3：移除 App 端 WebRTC tunnel session

- 删除 [app/src/lib/tunnel-client/appWebRtcTunnelSession.ts](../app/src/lib/tunnel-client/appWebRtcTunnelSession.ts)。
- 删除 `app/src/platform/webrtc/` 目录（暂时移除，阶段 3 重新引入）。
- 修改 [app/src/app/App.tsx](../app/src/app/App.tsx)：所有设备强制走 `mobileRelaySession`，不再读 `transport` 字段。
- 配对设备数据结构中删除 `transport` 字段（含迁移：旧值忽略即可，无破坏性数据）。
- 从 [app/package.json](../app/package.json) 移除 `react-native-webrtc` 依赖（阶段 3 再加回）。
- 同步更新 iOS Pod、Android Manifest、ProGuard 中的 WebRTC 痕迹（仅删除，阶段 3 再恢复）。

### 任务 1.4：清理协议层

- 修改 [packages/protocol-ts/src/index.ts](../packages/protocol-ts/src/index.ts)：
  - 删除消息类型 `tunnel.relay.register`、`tunnel.mobile.join`、`tunnel.session.offer`、`tunnel.session.answer`、`tunnel.session.candidate`、`tunnel.session.ready`、`tunnel.session.failed`、`tunnel.session.close`。
  - 删除对应 payload 类型。
- 修改 [packages/protocol-ts/tests/contract.test.ts](../packages/protocol-ts/tests/contract.test.ts)：移除相关测试。
- 删除 [packages/relay-client/src/webrtcTransport.ts](../packages/relay-client/src/webrtcTransport.ts)（阶段 3 重新设计后再加回，新文件名 `webRtcPeerAdapter.ts`）。

### 任务 1.5：清理配对相关配置

- 修改 [mac/agent/src/pairing/pairingQr.ts](../mac/agent/src/pairing/pairingQr.ts)：
  - 删除 `OMNIWORK_PAIRING_RELAY_URL`、`OMNIWORK_PAIRING_TRANSPORT`。
  - 配对 URL 直接使用 `OMNIWORK_RELAY_URL` 推导出 `/mobile` 地址（保留本地 IP 替换逻辑）。
- 配对二维码 payload 中移除 `transport` 字段。

### 任务 1.6：更新文档与脚本

- 归档旧文档：把 `docs/intranet-tunnel-technical-solution.md` 重命名为 [archive/intranet-tunnel-technical-solution-v1.md](./archive/intranet-tunnel-technical-solution-v1.md)，顶部加"已弃用"提示。
- 维护 [docs/relay-architecture.md](./relay-architecture.md) 作为终版架构文档（覆盖纯 WS 中继与 P2P 升级两个形态、运维指南、调试入口）。
- 更新 [docs/project-directory-structure.md](./project-directory-structure.md)。
- 更新根 [README.md](../README.md) 中的部署示例。

### 验收标准

- `pnpm install` 通过。
- 所有 typecheck 通过：
  ```text
  pnpm --filter @omniwork/protocol-ts typecheck
  pnpm --filter @omniwork/relay-client typecheck
  pnpm --filter @omniwork/relay-server typecheck
  pnpm --filter @omniwork/mac-agent typecheck
  pnpm --filter @omniwork/app typecheck
  ```
- `pnpm verify:relay`、`pnpm verify:mac-key` 通过。
- 真机或模拟器扫码配对、终端、会话列表、文件浏览、Git 状态全部可用。
- 仓库内 grep 无残留 `tunnel-service`、`tunnel.relay.register`、`@roamhq/wrtc`、`react-native-webrtc`。

---

## 阶段 2：引入 SessionTransport（仅 WS 实现）

**目标**：在 App 与 Agent 之间引入统一传输抽象，把所有业务模块的"直接调用 WS"替换为"调用 SessionTransport"。当前阶段只有 WS 一种实现，但接口已为 P2P 升级预留。

### 任务 2.1：定义传输抽象（共享类型）

新增 [packages/protocol-ts/src/transport.ts](../packages/protocol-ts/src/transport.ts)：

```text
export type TransportPath = 'relay' | 'p2p';

export interface SessionTransport {
  send(envelope: MessageEnvelope): void;
  onMessage(handler: (envelope: MessageEnvelope) => void): () => void;
  onPathChange(handler: (path: TransportPath) => void): () => void;
  getCurrentPath(): TransportPath;
  close(reason: string): void;
}
```

### 任务 2.2：Agent 端实现

新增 `mac/agent/src/transport/`：

- `sessionTransport.ts`：`AgentSessionTransport` 类，内部持有一个 `RelayPath`，`getCurrentPath()` 永远返回 `'relay'`。
- `relayPath.ts`：把现有 [agentRelayClient.ts](../mac/agent/src/relay-client/agentRelayClient.ts) 的 send/onMessage 能力包装出来，不改连接管理。
- `index.ts`：导出。

修改：

- [agentService.ts](../mac/agent/src/core/agentService.ts)：注入 `SessionTransport`，业务模块调用 `transport.send` 而不是 `relayClient.send`。
- 所有业务模块（[sessionManager.ts](../mac/agent/src/core/sessionManager.ts)、[fileService.ts](../mac/agent/src/files/fileService.ts)、[gitService.ts](../mac/agent/src/git/gitService.ts)、[terminalBridge.ts](../mac/agent/src/pty-bridge/terminalBridge.ts)）通过依赖注入接收 `SessionTransport`。

### 任务 2.3：App 端实现

新增 `app/src/lib/transport/`：

- `sessionTransport.ts`、`relayPath.ts`、`index.ts`：与 Agent 端对称。
- `relayPath` 内部封装现有 [mobileRelaySession.ts](../app/src/lib/relay-client/mobileRelaySession.ts)。

修改：

- [App.tsx](../app/src/app/App.tsx)：构造 `SessionTransport` 后注入到所有屏幕的 context。
- 各屏幕（`SessionListScreen`、`TerminalScreen`、`FileBrowserScreen`、`GitStatusScreen`、`DeviceListScreen`）从 context 取 `transport`，调用 `transport.send`。
- 保留 `mobileRelaySession` 的连接生命周期管理（连接、断线重连、auth 流程）。

### 任务 2.4：连接生命周期与 transport 解耦

- `SessionTransport` 不负责拉起/关闭 WS，只负责"在已建立的连接上读写 envelope"。
- 连接管理仍在 `mobileRelaySession` / `agentRelayClient` 中。
- WS 断线时：`SessionTransport` 不自动关闭，等待外层重连后重新挂上同一个 transport 实例。

### 任务 2.5：单元测试

- `mac/agent/tests/transport/sessionTransport.test.ts`：覆盖 send 转发、onMessage 分发、close 释放。
- `app/src/lib/transport/sessionTransport.test.ts`（如使用 jest）：同上。

### 验收标准

- 所有业务屏幕和模块不再直接 import `mobileRelaySession` / `agentRelayClient` 的 send 方法。
- 全量 typecheck 通过。
- 业务功能 e2e 完整：终端、会话、文件、Git、配对。
- 新增传输层单元测试通过。

---

## 阶段 3：WebRtcPeerAdapter + UpgradeCoordinator

**目标**：恢复 WebRTC 能力，但 peer 角色下沉到 App 与 Agent。新增升级状态机，可由人工触发完成 P2P 升级（Relay 端的自动触发放在阶段 4）。

### 任务 3.1：协议层新增升级消息

修改 [packages/protocol-ts/src/index.ts](../packages/protocol-ts/src/index.ts)，新增消息类型与 payload：

| 消息 | 方向 | payload 关键字段 |
|---|---|---|
| `tunnel.upgrade.propose` | Relay → App, Relay → Agent | `upgrade_id`, `ice_servers` |
| `tunnel.upgrade.offer` | App → Relay → Agent | `upgrade_id`, `sdp` |
| `tunnel.upgrade.answer` | Agent → Relay → App | `upgrade_id`, `sdp` |
| `tunnel.upgrade.candidate` | 双向 | `upgrade_id`, `candidate`, `sdp_mid`, `sdp_mline_index` |
| `tunnel.upgrade.committed` | App/Agent → Relay | `upgrade_id` |
| `tunnel.upgrade.downgrade` | 任意端 → Relay | `upgrade_id`, `reason` |

更新 [contract.test.ts](../packages/protocol-ts/tests/contract.test.ts) 与 schema 文件。

### 任务 3.2：WebRtcPeerAdapter 共享接口

新增 [packages/protocol-ts/src/webrtc.ts](../packages/protocol-ts/src/webrtc.ts)，定义 `WebRtcPeerAdapter` 接口：

```text
export interface WebRtcPeerAdapter {
  createOffer(): Promise<string>;
  createAnswer(): Promise<string>;
  setRemoteDescription(sdp: string): Promise<void>;
  addIceCandidate(c: IceCandidateInit): Promise<void>;
  onLocalCandidate(handler: (c: IceCandidateInit) => void): void;
  onDataMessage(handler: (data: string) => void): void;
  onStateChange(handler: (state: PeerState) => void): void;
  send(data: string): void;
  close(): void;
}
```

### 任务 3.3：Agent 端 WebRtcPeerAdapter

- 重新引入 `@roamhq/wrtc` 到 [mac/agent/package.json](../mac/agent/package.json)。
- 新增 `mac/agent/src/transport/webRtcPeerAdapter.ts`：基于 `@roamhq/wrtc` 实现 `WebRtcPeerAdapter`。
- **加载失败容忍**：try-import；失败则模块导出 `null`，`UpgradeCoordinator` 检测到 null 后永久禁用升级。

### 任务 3.4：App 端 WebRtcPeerAdapter

- 重新引入 `react-native-webrtc` 到 [app/package.json](../app/package.json)。
- 恢复 iOS Pod、Android Manifest（INTERNET、ACCESS_NETWORK_STATE）、ProGuard 配置。
- 新增 `app/src/lib/transport/webRtcPeerAdapter.native.ts`、`webRtcPeerAdapter.web.ts`（web 端可暂返回 null）。

### 任务 3.5：UpgradeCoordinator 状态机

新增 `mac/agent/src/transport/upgradeCoordinator.ts` 与 `app/src/lib/transport/upgradeCoordinator.ts`。

状态：

```text
idle → proposed → negotiating → committing → upgraded
                                    ↓
                                 failed → idle (downgrade)
```

输入事件：

- `propose(upgradeId, iceServers)`：从 Relay 收到 propose
- `remoteOffer(sdp)` / `remoteAnswer(sdp)` / `remoteCandidate(c)`：透传消息
- `localCommit()`：DataChannel open，本端确认升级
- `peerCommitted()`：对端 committed
- `failure(reason)`：超时、ICE 失败、wrtc null 等
- `downgrade(reason)`：运行时降级触发

输出动作：

- 通过 transport 出口发送 `tunnel.upgrade.offer/answer/candidate/committed/downgrade`。
- 调用 `SessionTransport.switchPath('p2p' | 'relay')`。

约束：

- 总超时 10s（可配）。
- 同一时刻只能有一个进行中的 upgrade。
- App 进入后台立即 downgrade。

### 任务 3.6：SessionTransport 增加 P2P path 与切换语义

升级 `sessionTransport.ts`：

- 内部新增 `P2pPath`，包装 `WebRtcPeerAdapter`。
- 新增方法 `switchPath(target)`：
  1. quiesce：阻塞 outbound 队列（业务调用 `send` 时入队，不立即写底层）
  2. drain：等待 in-flight Envelope 在原 path 上对端 ack（基于业务消息既有的 request/response 配对，3s 超时强切）
  3. 切换 currentPath，触发 `onPathChange`
  4. resume：回放队列到新 path
- 任意 path 异常 → 立即 fallback 到 relay path，重新进入 idle。

### 任务 3.7：Relay 端 signaling 透传

修改 [relay/server/src/relayServer.ts](../relay/server/src/relayServer.ts)：

- 收到 `tunnel.upgrade.offer/answer/candidate/committed/downgrade` 时按 device_id 路由到对端。
- Relay **不解析** SDP/ICE 内容，仅记录 `upgrade_id` 用于会话审计。
- 不做 propose（阶段 4 任务）。

### 任务 3.8：手工触发升级（开发用）

- 新增调试 endpoint `POST /debug/upgrade?device_id=xxx`，向该 device 的 App 与 Agent 同时发 `tunnel.upgrade.propose`。
- 新增端到端模拟器 [scripts/verify/mobile-upgrade-simulator.mjs](../scripts/verify/mobile-upgrade-simulator.mjs)：模拟手机端走完整 P2P 升级流程（mobile.connect → auth.proof → propose → offer → answer → candidate → committed → DataChannel ping/pong → 可选 downgrade），借用 `mac/agent` 的 `@roamhq/wrtc` 即可独立运行。注册为 npm script `pnpm verify:upgrade:simulator`，参数：`--relay <ws-url>` `--device <id>` `--key <KEY>` `--key-id <KEY_ID>`。
- 详细执行步骤见 [relay-architecture.md](./relay-architecture.md) 调试与回归章节。

### 验收标准

- `pnpm verify:upgrade:simulator` 完整跑通：propose → offer → answer → candidate → committed → DataChannel ping/pong 全部成功，`/metrics` `proposed/committed` 均自增。
- 真机/模拟器：扫码配对成功 → 业务功能正常 → 触发 `/debug/upgrade` → App 和 Agent 切到 P2P path → 终端输入正常 → 主动调用降级接口 → 切回 relay path → 终端继续正常。
- 业务消息在切换前后无丢失、无重复（终端、会话列表回归用例覆盖）。
- 全量 typecheck + 单元测试通过。

---

## 阶段 4：RelayUpgradeOrchestrator + 灰度策略

**目标**：让 Relay 自动决定何时发起 upgrade，引入退避、灰度、远端开关。

### 任务 4.1：Orchestrator 模块

新增 `relay/server/src/upgrade/orchestrator.ts`：

- 监听已建立的 mobile↔agent 会话（基于现有 device_id 路由表）。
- 触发条件：会话稳定 ≥ 3s，且 device 未在 `transport_capability=ws_only` 名单，且未在退避窗口内。
- 发出 `tunnel.upgrade.propose` 给 App 与 Agent。
- 监听 committed/downgrade，更新会话状态。

### 任务 4.2：退避与重试

- 失败计数：失败 1 次 → 30s 退避；连续失败 2 次 → 2min；3 次 → 10min；4 次起停止。
- 退避状态按 device_id 持久化在内存（重启清零）。
- 网络变更信号（App 端发送 `app.network.changed` 事件，本阶段不实现，预留）→ 重置退避。

### 任务 4.3：灰度与远端开关

- 配置：
  - `OMNIWORK_UPGRADE_ENABLED=true|false`：全局开关
  - `OMNIWORK_UPGRADE_ROLLOUT=0..100`：灰度百分比（按 device_id 哈希）
  - `OMNIWORK_UPGRADE_DEVICE_BLOCKLIST=`：逗号分隔
- Relay 启动时从环境变量读取，运行时不热更新（v1）。

### 任务 4.4：可观测埋点（Relay 侧）

- 计数器：`upgrade_proposed_total`、`upgrade_committed_total`、`upgrade_failed_total{reason}`、`upgrade_downgrade_total{reason}`。
- 暴露 `/metrics` endpoint（prometheus 文本格式，先简化为 JSON 也可）。

### 任务 4.5：测试

- 单元测试：覆盖触发条件、退避计算、灰度分流（[relay/server/tests/upgrade/orchestrator.test.ts](../relay/server/tests/upgrade/orchestrator.test.ts)）。
- 端到端：`pnpm verify:upgrade:simulator` 增加"自动触发"用例（不再调 `/debug/upgrade`，由 Relay 在会话稳定后自动 propose；当前实现通过 `OMNIWORK_UPGRADE_PROPOSE_DELAY_MS` 控制提议延迟）。

### 验收标准

- 默认配置下，App 配对成功后 ≤ 5s 内 Relay 自动发起 upgrade。
- 关闭 `OMNIWORK_UPGRADE_ENABLED` 后，所有会话保持 relay path，无 upgrade 流量。
- 灰度比例 50% 时，统计样本下约半数会话触发 upgrade。
- Metrics endpoint 可访问，关键计数器有数据。

---

## 阶段 5：健康探测 + 自动降级 + 可观测性

**目标**：让 P2P path 在异常时自动降级，业务无感；补齐生产级可观测性。

### 任务 5.1：应用层 ping/pong

- `SessionTransport` 在 P2P path 启用后，每 5s 发送一次 `transport.ping`，期望对端 1s 内回 `transport.pong`。
- 这两条消息**不进入业务消息流**，由 `SessionTransport` 内部消化。
- 协议层新增 `transport.ping` / `transport.pong`。

### 任务 5.2：健康指标与降级阈值

| 指标 | 阈值 | 动作 |
|---|---|---|
| pong 连续超时 | 3 次 | 降级 |
| DataChannel `bufferedAmount` | > 1MB 持续 5s | 降级 |
| ICE state 变 `disconnected` 持续 | 3s | 降级 |
| ICE state 变 `failed` | 立即 | 降级 |
| App 进入后台（mobile 平台事件） | 立即 | 降级 |

### 任务 5.3：网络变更处理

- App 端订阅 `react-native` 的网络状态变化（NetInfo）。
- 网络切换：先 downgrade 到 relay path，再异步尝试重新 upgrade（受 Relay 退避控制）。
- 前后台切换：进入后台 downgrade，回前台允许重新 upgrade。

### 任务 5.4：客户端可观测

- App 与 Agent 的 logger 加入 transport 事件：path 切换、upgrade 成功/失败、ping 超时、downgrade 原因。
- `OMNIWORK_LOG_TRANSPORT=1` 开启详细日志。
- App 设置页（如有）暴露当前 path、最近一次 upgrade 状态（debug build only）。

### 任务 5.5：Relay 可观测增强

- `/metrics` 增加：`upgrade_session_duration_seconds`（直方图）、`active_p2p_sessions`、`active_relay_sessions`。
- 日志结构化（JSON），关键字段：`upgrade_id`、`device_id`、`event`、`reason`。

### 任务 5.6：文档与回归

- 完成 [docs/relay-architecture.md](./relay-architecture.md) 终版（覆盖完整升级流程、降级策略、运维指南）。
- 删除阶段 1 留下的过渡描述。
- 更新 [README.md](../README.md) 的部署与调试章节。
- 完整回归：
  - `pnpm verify:relay`
  - `pnpm verify:mac-key`
  - `pnpm verify:upgrade:simulator`（按 [relay-architecture.md](./relay-architecture.md) 调试章节启动 relay + agent，再驱动模拟器）
  - 真机：网络切换、前后台切换、人为关闭 P2P 端口（防火墙）下，业务持续可用。

### 验收标准

- 在网络抖动场景下（手动断 WiFi 切 4G、防火墙拦截 UDP），业务消息不丢、不报错。
- Relay 与客户端可观测指标完整、可追溯任意一次 upgrade 的全生命周期。
- 文档完整，能让新成员独立完成部署与排障。

---

## 3. 风险登记册

| ID | 风险 | 影响阶段 | 缓解 |
|---|---|---|---|
| R1 | `@roamhq/wrtc` 在用户 Mac 安装失败 | 0, 3 | 阶段 0 spike + try-import 容忍 |
| R2 | quiesce/drain 切换瞬间消息重复或丢失 | 3 | 业务消息维持幂等 + 强制超时切换；如发现回归再加 seq |
| R3 | ICE 在严苛 NAT/CGNAT 下失败 | 3, 5 | 默认 relay path 已可用，失败仅退化为不升级 |
| R4 | App 后台 PeerConnection 被系统挂起 | 5 | 后台立即 downgrade，回前台再 upgrade |
| R5 | Relay 没有公网入口 | 1 | 文档中明确部署要求；提供 Cloudflare Tunnel runbook |
| R6 | 升级控制消息与业务消息共用 WS，可能阻塞 | 3 | 升级消息小，且带超时保护，必要时优先级队列 |

## 4. 依赖与前置条件

- 阶段 0 spike 通过是阶段 3 的硬前置。
- 阶段 1 与阶段 2 可同步推进（删除工作和抽象引入相对独立），但建议先 1 后 2，避免在两条变更链上同时修同一文件。
- 阶段 4 依赖阶段 3 的 upgrade e2e 稳定。
- 阶段 5 依赖阶段 4 的灰度能力（用于灰度环境收集真实数据）。

## 5. 不在本计划范围

- TURN 服务自建（仍用公共 STUN，必要时未来加 coturn）
- 多 Relay 多区域部署
- 端到端业务层加密（业务数据已在 P2P 路径上端到端，TLS 在 WS 路径由部署侧处理）
- iOS Live Activity / 后台保活强化
- Web 平台的 P2P（保持 web 端走 relay path）

## 附录 A：阶段 0 spike 结论

实施阶段 2-5 时已通过 [scripts/verify/mobile-upgrade-simulator.mjs](../scripts/verify/mobile-upgrade-simulator.mjs) 间接完成 spike 工作，结论如下：

- **测试机型与运行时**：macOS arm64 (Apple Silicon)，Node.js v24.13.0，pnpm 11.1.2。
- **`@roamhq/wrtc` 安装**：在目标 Mac 上 `pnpm install` 通过，无需额外 Xcode CLI 工具；预编译 binary 直接可用。
- **ESM 兼容性问题**：动态 `import("@roamhq/wrtc")`（CJS）在 Node ESM 下会被包装为 `{ default: { RTCPeerConnection, ... }, RTCDataChannel, ... }`，`RTCPeerConnection` 等只挂在 `default` 上。`mac/agent/src/transport/webRtcPeerAdapter.ts` 的 `loadWrtc` 已加入 `default` 解包逻辑作为兼容层。
- **协议参数**：默认 STUN（如 `stun:stun.l.google.com:19302`）即可让本机 PeerConnection 互联；TURN 仍由部署侧另行决定。
- **关键决策**：
  - RN 端使用 `react-native-webrtc`，Node 端使用 `@roamhq/wrtc`，Web 端 `webRtcPeerAdapter.web.ts` 返回 null 表示不支持升级。
  - `transport.ping` 周期 5s、超时 1s、连续 3 次降级。
  - 失败容忍：`@roamhq/wrtc` 加载失败时 `UpgradeCoordinator` 检测到 null 后永久禁用升级，业务不受影响。
- **已知问题与缓解建议**：
  - 在严苛 NAT/CGNAT 下 ICE 可能直接 failed，`UpgradeCoordinator` 立即降级回 relay。
  - App 进入后台时 PeerConnection 易被系统挂起，已通过 `forceDowngrade` 主动切回 relay。

> 后续若引入新机型/新 Node 主版本（≥ v26），需重新跑一次 `pnpm verify:upgrade:simulator` 与 `pnpm --filter @omniwork/mac-agent test` 验证 native binding。
