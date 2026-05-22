# 内网穿透技术方案

> ⚠️ **已弃用 (DEPRECATED)** —— 本文档为历史归档，对应 v1 阶段（包含 tunnel-service 与 Relay 端 WebRTC peer 的方案）。当前架构已回归到 App↔Relay↔Agent 全 WebSocket 的最小可用形态，详见 [`relay-architecture-implementation.md`](../relay-architecture-implementation.md)。

调研时间：2026-05-15

关联文档：

- [engineering-requirements.md](./engineering-requirements.md)
- [mobile-codex-tui-technical-solution.md](./mobile-codex-tui-technical-solution.md)
- [mobile-codex-tui-workbench-design.md](./mobile-codex-tui-workbench-design.md)
- [auth-key-design.md](./auth-key-design.md)

## 推进决策

本方案已确定按以下两条路线推进：

1. **自研 P2P 直连 MVP**
   - 作为第一阶段交付目标。
   - 明确复用 WebRTC ICE/DataChannel，不从零自研 UDP 打洞、可靠传输和拥塞控制。
   - Tunnel Service 只做建联、鉴权、候选交换和状态编排；直连成功后退出数据路径。
   - MVP 先验证 Mobile 与 Relay 的最小直连闭环。

2. **Cloudflare-like 增量能力**
   - 作为后续增量 Provider 和兜底路径。
   - 目标是在 P2P 直连不可用或需要快速稳定公网入口时，提供反向隧道模式。
   - 技术上优先接入 Cloudflare Tunnel；如果企业合规或私有化要求不允许，则使用 frp 作为自托管替代。

推进顺序：

```text
WebRTC P2P MVP -> P2P 生产化与 fallback -> Cloudflare-like 增量 Provider
```

## 当前实现状态

截至 2026-05-15，WebRTC P2P MVP 已开始工程落地：

- `packages/protocol-ts/src/index.ts`
  - 已新增 `tunnel.mobile.join`、`tunnel.session.offer`、`tunnel.session.answer`、`tunnel.session.candidate`、`tunnel.session.ready`、`tunnel.session.failed`、`tunnel.session.close` 等控制面消息类型。
  - 已新增 `tunnel.relay.register`，用于内网 Relay 主动注册到公网 Tunnel Service。
  - 已新增 WebRTC tunnel 相关 payload 类型。

- `packages/relay-client/src/webrtcTransport.ts`
  - 已新增 WebRTC peer、ICE candidate、DataChannel 的最小 TypeScript 抽象。
  - 已新增 `DataChannelEnvelopeTransport`，用于在 WebRTC DataChannel 上复用现有业务 Envelope。

- `relay/server/src/relayServer.ts`
  - 已新增 `/tunnel/mobile` WebSocket signaling 入口。
  - Relay 侧作为 WebRTC offerer 创建 DataChannel。
  - DataChannel 建立后会被适配成现有 mobile 连接，继续复用当前 `mobile.connect`、`auth.challenge`、`auth.proof`、`auth.verify`、`auth.ok` 业务鉴权链路。
  - 已支持通过 `OMNIWORK_TUNNEL_SERVICE_RELAY_URL` 主动连接公网 Tunnel Service 的 `/relay`，并在 Agent 上线后注册 `device_id`。
  - Relay 到公网 Tunnel Service 断开或连接失败时会自动重连。

- `relay/tunnel-service`
  - 已新增独立公网 Tunnel Service 包。
  - `/relay` 接收内网 Relay 的 outbound WebSocket 注册。
  - `/mobile` 和 `/tunnel/mobile` 接收 App 的 WebRTC signaling 连接。
  - 只转发 `tunnel.mobile.join`、offer、answer、ICE candidate 和 close/failed 等建联消息，不进入 WebRTC DataChannel 数据路径。

- `mac/agent/src/pairing/pairingQr.ts`
  - 已新增 `OMNIWORK_PAIRING_RELAY_URL`，用于让二维码中的 `relay_url` 指向公网 Tunnel Service `/mobile`。
  - 已新增 `OMNIWORK_PAIRING_TRANSPORT`，用于让二维码携带 App 连接类型；仅支持 `webrtc` 和 `websocket`。
  - 配对 URL 生成时会将 `0.0.0.0`、`127.0.0.1`、`localhost` 替换成本机 IPv4；存在多个 IPv4 时优先选择非 `192.*` 地址。
  - Agent 自身仍可通过 `OMNIWORK_RELAY_URL` 连接内网本机 Relay `/agent`。

- `app/src/lib/tunnel-client/appWebRtcTunnelSession.ts`
  - 已新增 App 侧 WebRTC tunnel session。
  - App 侧作为 WebRTC answerer，接收 offer、返回 answer、交换 ICE candidate。
  - DataChannel 打开后自动发送 `mobile.connect`，并复用现有临时 key proof 逻辑。

- `app/src/app/App.tsx` 和设备配对配置
  - 每个已链接设备都会保存自己的 `transport`，支持在现有 Relay WebSocket 和 WebRTC P2P MVP 之间切换。
  - 当设备 `transport` 为 `webrtc` 时，App 主流程会使用 `AppWebRtcTunnelSession`。
  - 当设备 `transport` 为 `websocket` 时，App 主流程会使用原 WebSocket Relay。

- WebRTC 运行时依赖
  - App 侧已接入 `react-native-webrtc`，并完成 iOS Pod 集成与 Android 权限 / ProGuard 配置。
  - Relay 侧已接入 `@roamhq/wrtc`，`relay/server/src/webrtcFactory.ts` 会优先使用全局 `RTCPeerConnection`，否则回退到 Node WebRTC runtime。
  - `app/package.json` 的 `pods:ios` 已改为使用项目本地 CocoaPods home，避免受用户目录下 `~/.cocoapods` 权限影响。

- 本地 E2E 验证
  - 已新增根脚本 `verify:app-webrtc:e2e`。
  - 脚本会模拟 Agent 与 App WebRTC tunnel client，连接已启动的 Relay。
  - 验证范围覆盖 `/tunnel/mobile` signaling、WebRTC offer/answer、ICE candidate、DataChannel 建立、`mobile.connect` 和现有 auth proof 链路。
  - 成功输出为 `app webrtc tunnel e2e ok`。
  - 已新增 `verify:public-tunnel-webrtc:e2e`，覆盖独立公网 Tunnel Service、内网 Relay outbound 注册、App 经公网 Tunnel Service 建联、DataChannel 鉴权闭环。
  - 成功输出为 `public tunnel webrtc e2e ok`。

当前实现边界：

- MVP 代码已经具备本地 Relay signaling、独立公网 Tunnel Service signaling 和 DataChannel Envelope 传输骨架。
- Relay 运行时当前依赖 `@roamhq/wrtc`；后续如部署环境不支持其 native binary，需要改为注入其他 Node WebRTC runtime。
- App 运行时当前依赖 `react-native-webrtc`；真机 E2E 仍需要完成原生构建和设备/模拟器验证。
- 当前 MVP 先验证 `direct_only` 直连闭环；TURN fallback、Tunnel Service 鉴权加固和 Cloudflare-like Provider 仍属于后续阶段。

## 测试与验证

WebRTC P2P MVP 的验证分为五层：

1. 静态检查：确认协议、Relay、App 和共享传输代码可编译。
2. Relay 启动检查：确认 Relay 配置和 WebRTC runtime 可加载。
3. 本地 WebRTC E2E：用脚本模拟 Agent 和 App，验证 `/tunnel/mobile` 到 DataChannel 的完整闭环。
4. 原生 App 构建：确认 `react-native-webrtc` 已正确进入 Android/iOS 工程。
5. 真机或模拟器联调：验证真实 App 使用 WebRTC transport 连接 Relay。

### 1. 静态检查

在仓库根目录执行：

```bash
pnpm --filter @omniwork/protocol-ts typecheck
pnpm --filter @omniwork/relay-client typecheck
pnpm --filter @omniwork/relay-server typecheck
pnpm --filter @omniwork/tunnel-service typecheck
pnpm --filter @omniwork/mac-agent typecheck
pnpm --filter @omniwork/app typecheck
```

成功标准：

- 所有命令退出码为 `0`。
- 不出现 TypeScript 编译错误。
- 编辑器诊断允许存在 `webrtc`、`wrtc`、`roamhq` 等拼写提示，但不应有 TypeScript error。

### 2. Relay 启动检查

先确认 Relay 配置可加载：

```bash
pnpm verify:relay
```

再启动本地 Relay：

```bash
OMNIWORK_RELAY_HOST=127.0.0.1 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_STUN_URLS= \
pnpm dev:relay
```

成功标准：

- `pnpm verify:relay` 输出 configuration ok。
- `pnpm dev:relay` 输出 `listening on 127.0.0.1:8787`。
- Relay 运行时没有输出 `RTCPeerConnection is not available`。

说明：

- 本地 E2E 使用同机连接，不需要 STUN，因此 `OMNIWORK_TUNNEL_STUN_URLS` 可以置空。
- 跨设备或真实网络联调时，应设置 STUN，例如 `OMNIWORK_TUNNEL_STUN_URLS=stun:stun.cloudflare.com:3478`。

### 3. 公网 Tunnel Service 启动检查

先确认 Tunnel Service 配置可加载：

```bash
pnpm verify:tunnel
```

再启动公网建联服务：

```bash
OMNIWORK_TUNNEL_HOST=0.0.0.0 \
OMNIWORK_TUNNEL_PORT=8790 \
pnpm dev:tunnel
```

成功标准：

- `pnpm verify:tunnel` 输出 configuration ok。
- `pnpm dev:tunnel` 输出 `listening on 0.0.0.0:8790`。
- 公网服务器安全组或防火墙放行 TCP `8790`。
- `curl http://<public-host>:8790/healthz` 返回 `{"ok":true}`。

### 4. 本地 WebRTC E2E

保持 Relay 运行后，在另一个终端执行：

```bash
pnpm verify:app-webrtc:e2e
```

该脚本会执行以下动作：

- 模拟 Agent 连接 `ws://127.0.0.1:8787/agent`。
- 模拟 App 连接 `ws://127.0.0.1:8787/tunnel/mobile`。
- 验证 Relay 生成 WebRTC offer。
- 验证 App 返回 answer。
- 验证 ICE candidate 交换。
- 验证 WebRTC DataChannel 打开。
- 在 DataChannel 上发送 `mobile.connect`。
- 复用现有 `auth.challenge -> auth.proof -> auth.verify -> auth.ok` 鉴权链路。

成功标准：

```text
app webrtc tunnel e2e ok
```

失败判断：

- 如果出现 `agent_not_online`，说明 E2E 中 Agent 没有先连接或 Relay 里没有对应 device。
- 如果出现 `RTCPeerConnection is not available`，说明 Relay 侧 `@roamhq/wrtc` 没有加载成功。
- 如果超时，优先检查 Relay 是否在 `127.0.0.1:8787` 运行，以及是否有端口冲突。
- 如果 DataChannel 关闭，优先查看 offer/answer 和 ICE candidate 是否都完成交换。

### 5. 公网 Tunnel Service E2E

公网链路本地模拟验证：

```bash
pnpm verify:public-tunnel-webrtc:e2e
```

该脚本会在同一进程中启动 Tunnel Service 和 Relay，模拟：

- Relay 主动连接 `Tunnel Service /relay` 并注册 `device_id`。
- Agent 连接内网 Relay `/agent`。
- Mobile 连接 `Tunnel Service /mobile`。
- Tunnel Service 只转发 WebRTC signaling。
- WebRTC DataChannel 建立后完成 `mobile.connect` 和 auth proof。

成功输出：

```text
public tunnel webrtc e2e ok
```

### 6. Android 构建验证

在 `app/android` 目录执行：

```bash
./gradlew :app:assembleDebug -x lint
```

成功标准：

- Gradle 构建退出码为 `0`。
- `react-native-webrtc` 参与 native build 且无链接错误。
- Android Manifest 已包含网络状态相关权限。
- ProGuard 规则保留 `org.webrtc` 和 `com.oney.WebRTCModule`。

说明：

- 本地 Kotlin daemon 可能因权限问题短暂失败，Gradle 自动 fallback 后仍成功即可。
- 如果 native build 报 WebRTC 类缺失，先重新安装依赖并清理 Gradle 缓存后再试。

### 7. iOS 构建验证

先安装 Pod：

```bash
pnpm --filter @omniwork/app pods:ios
```

可选执行无签名 Release 构建：

```bash
pnpm app:build:ios
```

成功标准：

- `pods:ios` 退出码为 `0`。
- `Podfile.lock` 中包含 `react-native-webrtc` 和 `JitsiWebRTC`。
- 本地 CocoaPods 权限问题不会影响安装，因为脚本使用 `app/.cocoapods-home` 作为本地 cache。

说明：

- 如果 `bundle exec pod install` 受 bundler 版本阻塞，直接使用 `pnpm --filter @omniwork/app pods:ios`。
- 如果 `~/.cocoapods` 权限异常，不需要修改用户目录权限，当前脚本会使用项目内 cache。

### 8. 真机或模拟器联调

本地脚本通过后，再验证真实 App 流程。

准备 Relay：

```bash
OMNIWORK_RELAY_HOST=0.0.0.0 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_STUN_URLS=stun:stun.cloudflare.com:3478 \
pnpm dev:relay
```

准备 App：

- 在设备配对 / 编辑页面选择该设备的连接方式：`WebSocket Relay` 或 `WebRTC`。
- 每个已链接设备的连接方式独立保存，App 不再通过全局 `appConfig.tunnelTransport` 决定所有设备的连接方式。
- iOS 模拟器访问本机 Relay 可使用 `ws://127.0.0.1:8787/mobile` 作为配对 Relay URL。
- Android 模拟器访问宿主机 Relay 通常使用 `ws://10.0.2.2:8787/mobile` 作为配对 Relay URL。
- 真机需要使用 Mac 的局域网 IP，例如 `ws://<mac-lan-ip>:8787/mobile`，并确保防火墙允许入站。

运行 App：

```bash
pnpm app:ios
```

或：

```bash
pnpm app:android
```

成功标准：

- App 显示 WebRTC P2P tunnel 连接中。
- Relay 日志中没有 tunnel failure。
- App 能完成 `auth.ok` 并进入原有业务界面。
- 如果触发会话列表、终端创建或终端输入，消息应通过 DataChannel 到达 Relay，再由 Relay 转发到 Agent。

### 9. 发布前回归清单

每次修改 WebRTC MVP 相关代码后，至少执行：

```bash
pnpm --filter @omniwork/protocol-ts typecheck
pnpm --filter @omniwork/relay-client typecheck
pnpm --filter @omniwork/relay-server typecheck
pnpm --filter @omniwork/tunnel-service typecheck
pnpm --filter @omniwork/mac-agent typecheck
pnpm --filter @omniwork/app typecheck
pnpm verify:relay
pnpm verify:tunnel
pnpm verify:mac-key
pnpm verify:public-tunnel-webrtc:e2e
```

涉及原生依赖、Android Manifest、ProGuard、Podfile 或 `react-native-webrtc` 版本变化时，额外执行：

```bash
pnpm --filter @omniwork/app pods:ios
cd app/android && ./gradlew :app:assembleDebug -x lint
```

### 10. 当前已验证结果

截至 2026-05-15，当前实现已通过：

- `pnpm --filter @omniwork/protocol-ts typecheck`
- `pnpm --filter @omniwork/relay-client typecheck`
- `pnpm --filter @omniwork/relay-server typecheck`
- `pnpm --filter @omniwork/tunnel-service typecheck`
- `pnpm --filter @omniwork/mac-agent typecheck`
- `pnpm --filter @omniwork/app typecheck`
- `pnpm verify:relay`
- `pnpm verify:tunnel`
- `pnpm verify:mac-key`
- `pnpm verify:app-webrtc:e2e`
- `pnpm verify:public-tunnel-webrtc:e2e`
- `pnpm --filter @omniwork/app pods:ios`
- `cd app/android && ./gradlew :app:assembleDebug -x lint`

## 真实设备 P2P 联调 Runbook

本章节说明如何用真实设备完成一次 WebRTC P2P MVP 的端到端验证。

### 1. 当前 MVP 的真实链路

当前 MVP 的真实链路是：

```text
Mac Agent --WebSocket--> Relay
Mobile App --WebSocket signaling--> Relay /tunnel/mobile
Mobile App <==WebRTC DataChannel==> Relay
Relay --WebSocket--> Mac Agent
```

需要注意：

- 当前 MVP 验证的是 **Mobile App 与 Relay 之间的 WebRTC P2P DataChannel**。
- Mac Agent 仍通过原有 WebSocket 连接 Relay，不直接参与 WebRTC。
- Tunnel Service 目前以 `/tunnel/mobile` signaling endpoint 的形式集成在 Relay 进程里，不是独立服务。
- App 配对时仍填写或扫描 `/mobile` 地址；App 内部会自动把该地址转换为 `/tunnel/mobile` 作为 signaling 地址。
- 如果 Mobile 无法访问 Relay 的 signaling 地址，则无法开始 WebRTC 建联；真实公网环境后续需要独立 Tunnel Service、公网 signaling 入口或 Cloudflare-like 增量 Provider。

### 2. 设备和网络准备

最小真实设备联调建议：

- 一台 Mac，运行 Relay 和 Agent。
- 一台 iPhone 或 Android 真机，运行 OmniWork App。
- Mac 和手机连接同一个 Wi-Fi。
- Mac 防火墙允许 Node.js 或当前终端进程接受入站连接。
- 手机能够访问 `ws://<mac-lan-ip>:8787`。

获取 Mac 局域网 IP：

```bash
ipconfig getifaddr en0
```

如果使用有线网络，可能需要：

```bash
ipconfig getifaddr en1
```

如果不确定网卡：

```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

假设得到的 Mac IP 是：

```text
192.168.1.23
```

后续示例都用该 IP 表示。

### 3. 安装和构建准备

仓库根目录安装依赖：

```bash
pnpm install
```

iOS 需要安装 Pod：

```bash
pnpm --filter @omniwork/app pods:ios
```

Android 可先验证 debug build：

```bash
cd app/android && ./gradlew :app:assembleDebug -x lint
```

回到仓库根目录：

```bash
cd ../../
```

### 4. 启动 Relay

在仓库根目录启动 Relay：

```bash
OMNIWORK_RELAY_HOST=0.0.0.0 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_STUN_URLS=stun:stun.cloudflare.com:3478 \
pnpm dev:relay
```

成功标准：

```text
[omniwork-relay] listening on 0.0.0.0:8787
```

说明：

- `OMNIWORK_RELAY_HOST=0.0.0.0` 让手机可以从局域网访问 Relay。
- `OMNIWORK_TUNNEL_STUN_URLS` 用于真实设备 ICE 候选收集。
- 如果只做同机脚本 E2E，可以把 `OMNIWORK_TUNNEL_STUN_URLS` 置空；真实设备建议设置 STUN。

可选检查 Relay 配置：

```bash
pnpm verify:relay
```

### 5. 启动 Agent

另开一个终端，在仓库根目录启动 Mac Agent：

```bash
OMNIWORK_DEVICE_ID=dev-mac-001 \
OMNIWORK_RELAY_URL=ws://127.0.0.1:8787/agent \
OMNIWORK_PAIRING_TRANSPORT=webrtc \
pnpm dev:mac
```

成功标准：

- Agent 输出 `connected to relay`。
- Agent 输出配对信息和二维码。
- 配对信息中的 `relay_url` 应该是手机可访问地址，例如：

```text
relay_url: ws://192.168.1.23:8787/mobile
```

说明：

- Agent 可以用 `127.0.0.1` 连接本机 Relay。
- 如果未设置 `OMNIWORK_PAIRING_RELAY_URL`，Agent 会基于 `OMNIWORK_RELAY_URL` 生成手机地址，并把 `/agent` 后缀替换为 `/mobile`。
- Agent 生成配对 QR 时会把 `0.0.0.0`、`127.0.0.1`、`localhost` 替换成 Mac 局域网 IP，方便手机扫码。
- 如果本机存在多个 IPv4，Agent 会优先选择非 `192.*` 地址。
- `OMNIWORK_PAIRING_TRANSPORT=webrtc` 会让二维码写入 `transport=webrtc`；如果设置为 `websocket`，二维码会写入 `transport=websocket`。
- 如果自动替换出的 IP 不对，可以手动在 App 中填写 `ws://<mac-lan-ip>:8787/mobile`。

### 6. 启动 App

iOS：

```bash
pnpm app:ios
```

Android：

```bash
pnpm app:android
```

确认 App 使用 WebRTC transport：

- 打开设备配对 / 编辑页面。
- 将该设备的连接方式切换为 `WebRTC`。
- 该选择只影响当前链接设备，不影响其他已保存设备。

如果要临时回退原 WebSocket Relay：

- 打开设备配对 / 编辑页面。
- 将该设备的连接方式切换为 `WebSocket Relay`。

### 7. App 配对和连接

推荐方式：

1. 在 Agent 终端扫描二维码。
2. App 进入配对页后确认 Relay URL 是 `ws://<mac-lan-ip>:8787/mobile`。
3. 点击连接。

手动方式：

- `relayUrl`: `ws://192.168.1.23:8787/mobile`
- `deviceId`: Agent 输出的 `device_id`，例如 `dev-mac-001`
- `key`: Agent 输出的 `key`
- `keyId`: Agent 输出的 `key_id`

连接时内部实际发生：

1. App 从配对信息读取 `relayUrl = ws://<mac-lan-ip>:8787/mobile`。
2. `AppWebRtcTunnelSession` 将其转换为 `ws://<mac-lan-ip>:8787/tunnel/mobile`。
3. App 通过 `/tunnel/mobile` 与 Relay 交换 offer、answer 和 ICE candidate。
4. WebRTC DataChannel 打开。
5. App 在 DataChannel 上发送 `mobile.connect`。
6. Relay 复用现有鉴权链路与 Agent 完成 `auth.challenge -> auth.proof -> auth.verify -> auth.ok`。

### 8. 成功标准

真实设备 P2P 联调成功需要同时满足：

- Agent 终端显示已连接 Relay。
- App 可以完成配对并进入已连接状态。
- Relay 没有输出 `tunnel.session.failed` 或 `RTCPeerConnection is not available`。
- App 没有停留在连接中或鉴权失败状态。
- App 可以继续触发现有业务能力，例如会话列表、创建会话、终端输入或终端快照。

当前代码没有专门打印 WebRTC ready 日志，因此真实设备验证主要依赖：

- App UI 状态。
- Agent 是否收到 `auth.verify` 并返回 `auth.ok`。
- Relay 是否持续运行且无 tunnel failure。
- 业务消息是否能通过 App 正常触达 Agent。

### 9. 辅助本地 E2E

真实设备联调前后，都建议运行脚本 E2E 做基线确认。

先保持 Relay 运行：

```bash
OMNIWORK_RELAY_HOST=127.0.0.1 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_STUN_URLS= \
pnpm dev:relay
```

再运行：

```bash
pnpm verify:app-webrtc:e2e
```

成功输出：

```text
app webrtc tunnel e2e ok
```

该脚本只能证明 Node 环境下 WebRTC signaling、DataChannel 和鉴权链路成立，不能替代真机网络验证。

### 10. 常见问题排查

#### 手机无法连接 Relay

现象：

- App 一直连接中。
- App 报 WebSocket 连接失败。
- Agent 已连接，但 App 连不上。

排查：

```bash
curl http://192.168.1.23:8787
```

说明：

- Relay 是 WebSocket 服务，`curl` 不一定返回业务内容，但如果完全连不上，说明网络或防火墙有问题。
- 确认 Relay 使用 `OMNIWORK_RELAY_HOST=0.0.0.0` 启动。
- 确认手机和 Mac 在同一网络。
- 确认 Mac 防火墙允许入站。
- 确认 App 中 Relay URL 使用 Mac 局域网 IP，而不是 `127.0.0.1`。

#### `RTCPeerConnection is not available`

含义：

- Relay 侧 WebRTC runtime 没有加载成功。

排查：

```bash
pnpm --filter @omniwork/relay-server typecheck
pnpm verify:relay
node -e "const wrtc=require('./relay/server/node_modules/@roamhq/wrtc'); console.log(typeof wrtc.RTCPeerConnection)"
```

成功时应输出：

```text
function
```

#### `agent_not_online`

含义：

- App 请求的 `device_id` 没有对应在线 Agent。

排查：

- 确认 Agent 已启动。
- 确认 Agent 输出 `connected to relay`。
- 确认 App 配对使用的 `deviceId` 与 `OMNIWORK_DEVICE_ID` 一致。
- 确认 Agent 和 App 连接的是同一个 Relay 实例。

#### ICE 或 DataChannel 失败

现象：

- Signaling 已连接，但 App 一直无法进入业务界面。
- E2E 或真机联调超时。

排查：

- 确认 `OMNIWORK_TUNNEL_STUN_URLS` 配置正确。
- 同一 Wi-Fi 下可先尝试置空 STUN，只验证 host candidate：

```bash
OMNIWORK_TUNNEL_STUN_URLS= pnpm dev:relay
```

- 换同一局域网、手机热点或另一台路由器测试，排除企业 Wi-Fi 禁 UDP。
- 如果网络禁 UDP，当前 MVP 没有 TURN fallback，直连可能失败。

#### Android 真机连不上 Mac

排查：

- 真机不能使用 `10.0.2.2`，必须使用 Mac 局域网 IP。
- `10.0.2.2` 只适用于 Android Emulator 访问宿主机。
- 确认 Android App 有 `INTERNET` 和 `ACCESS_NETWORK_STATE` 权限。

#### iOS 真机连不上 `ws://`

排查：

- Debug 环境通常允许本地明文连接；如被 ATS 限制，需要检查 iOS `Info.plist` 的本地网络/明文策略。
- 确认 iPhone 首次访问局域网时允许 Local Network 权限。
- 确认 Mac 和 iPhone 在同一网段。

#### iOS 扫码后卡在 key proof challenge 或 Relay connection failed

已验证过的真机问题：

- iOS / React Native 环境下，不应依赖 `URL.pathname` 或 `URL.host` mutation 来生成 WebRTC signaling 地址。
- 曾观察到 `ws://10.75.28.116:8787/mobile` 被错误转换成 `ws://10.75.28.116:8787/mobile/` 或 `ws:///tunnel/mobile`。
- 当前实现已改为基于字符串规范化生成 `ws://<host>:<port>/tunnel/mobile`。
- Relay 已兼容 `/mobile/`、`/agent/`、`/tunnel/mobile/` 这类尾斜杠路径。

排查步骤：

- 确认 App 运行的是最新 bundle，必要时删除 App 后重新执行 `pnpm app:ios`。
- 删除旧配对设备，重新扫描当前 Agent 终端最新二维码，避免使用旧 `device_id`、`key_id` 和 `key`。
- 如果仍失败，确认 Relay 收到的是 `/tunnel/mobile`，而不是 `/mobile`。
- 如果 App 停在 key proof challenge，优先检查是否仍在走旧 WebSocket Relay 路径或旧配对信息。

## 公网 Tunnel Service 联调 Runbook

本章节用于用户已有一台公网服务器、但内网本机不能做 SSH 反向映射、端口映射、frp 或 Cloudflare Tunnel 的场景。

### 1. 公网链路

```text
Mac Agent --WebSocket--> Local Relay
Local Relay --outbound WebSocket--> Public Tunnel Service /relay
Mobile App --WebSocket signaling--> Public Tunnel Service /mobile
Mobile App <==WebRTC DataChannel==> Local Relay
Local Relay --WebSocket--> Mac Agent
```

关键点：

- 公网服务器只运行 `Tunnel Service`。
- 内网本机 Relay 主动连接公网 Tunnel Service，不需要公网服务器反连内网。
- App 扫码拿到的是公网 Tunnel Service `/mobile` 地址。
- Tunnel Service 只转发建联 signaling；DataChannel 建立后业务数据不经过 Tunnel Service。

### 2. 公网服务器启动 Tunnel Service

在公网服务器上准备代码和依赖后执行：

```bash
OMNIWORK_TUNNEL_HOST=0.0.0.0 \
OMNIWORK_TUNNEL_PORT=8790 \
pnpm dev:tunnel
```

生产运行可使用：

```bash
OMNIWORK_TUNNEL_HOST=0.0.0.0 \
OMNIWORK_TUNNEL_PORT=8790 \
pnpm tunnel:start
```

检查公网可达：

```bash
curl http://<public-host>:8790/healthz
```

成功标准：

```json
{"ok":true}
```

需要同时确认：

- 公网服务器安全组放行 TCP `8790`。
- 服务器本机防火墙放行 TCP `8790`。
- 如果使用域名和 TLS，外层网关需要把 WebSocket upgrade 正确转发到 Tunnel Service。

### 3. 内网本机启动 Relay

在内网 Mac 上启动本机 Relay，并让它主动连接公网 Tunnel Service：

```bash
OMNIWORK_RELAY_HOST=127.0.0.1 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_SERVICE_RELAY_URL=ws://<public-host>:8790/relay \
OMNIWORK_TUNNEL_STUN_URLS=stun:stun.cloudflare.com:3478 \
pnpm dev:relay
```

国内网络可替换 STUN：

```bash
OMNIWORK_TUNNEL_STUN_URLS=stun:stun.qq.com:3478,stun:stun.miwifi.com:3478
```

成功标准：

```text
[omniwork-relay] listening on 127.0.0.1:8787
[omniwork-relay] connected to tunnel service
```

说明：

- `OMNIWORK_RELAY_HOST=127.0.0.1` 即可，因为 App 不直接访问内网 Relay 的 WebSocket signaling。
- Relay 到 Tunnel Service 是内网主动出站连接，通常不需要本机端口映射。
- 如果公网 Tunnel Service 重启，Relay 会自动重连。

### 4. 内网本机启动 Agent

Agent 仍然连接本机 Relay，但二维码要给手机公网地址：

```bash
OMNIWORK_DEVICE_ID=my-mac \
OMNIWORK_RELAY_URL=ws://127.0.0.1:8787/agent \
OMNIWORK_PAIRING_RELAY_URL=ws://<public-host>:8790/mobile \
OMNIWORK_PAIRING_TRANSPORT=webrtc \
pnpm dev:mac
```

成功标准：

- Agent 输出 `connected to relay`。
- Agent 输出二维码。
- 配对信息中的 `relay_url` 是 `ws://<public-host>:8790/mobile`，不是 `ws://127.0.0.1:8787/mobile`。
- 配对信息中的 `transport` 是 `webrtc`。

`OMNIWORK_PAIRING_RELAY_URL` 的作用：

- 只影响二维码和配对 payload 中的 `relay_url`。
- 不影响 Agent 自己连接 Relay；Agent 仍使用 `OMNIWORK_RELAY_URL`。
- 用于公网 Tunnel Service 模式下解决“Agent 连本机，App 连公网”的地址分离问题。

`OMNIWORK_PAIRING_TRANSPORT` 的作用：

- 只影响二维码和配对 payload 中的 `transport`。
- `webrtc` 表示 App 使用 WebRTC tunnel；`websocket` 表示 App 使用 WebSocket Relay。
- 该值不会改变 Agent 自己连接 Relay 的方式。

### 5. 手机 App 操作

操作步骤：

1. 手机使用公网网络或任意可访问公网服务器的网络。
2. 打开 OmniWork App。
3. 扫描 Agent 终端输出的二维码。
4. 确认配对页中的 Relay URL 为 `ws://<public-host>:8790/mobile`。
5. 点击连接。

连接时内部实际发生：

1. App 读取配对信息中的公网 `relay_url`。
2. `AppWebRtcTunnelSession` 将 `/mobile` 规范化为 `/tunnel/mobile`。
3. Tunnel Service 接收 `tunnel.mobile.join`，按 `device_id` 找到已注册 Relay。
4. Tunnel Service 在 Relay 和 App 之间转发 offer、answer 和 ICE candidate。
5. WebRTC DataChannel 打开。
6. App 通过 DataChannel 发送 `mobile.connect`。
7. Relay 复用现有鉴权链路连接 Agent 并完成 `auth.ok`。

### 6. 公网链路成功标准

公网 Tunnel Service 模式成功需要同时满足：

- 公网服务器 `/healthz` 可访问。
- Relay 日志显示已连接 Tunnel Service。
- Agent 日志显示已连接本机 Relay。
- Agent 二维码中的 `relay_url` 指向公网 Tunnel Service。
- App 能完成配对并进入连接状态。
- Tunnel Service 只看到 signaling 连接，不承载终端帧、输入、会话列表等业务数据。

### 7. 公网链路排查

如果 App 报 `agent_not_online`：

- 确认 Agent 已连接 Relay。
- 确认 Relay 日志显示已连接 Tunnel Service。
- 确认 `OMNIWORK_DEVICE_ID` 与二维码中的 `device_id` 一致。
- 确认 Tunnel Service `/relay` 连接没有被公网网关断开。

如果 App 无法连接公网地址：

- 检查 `curl http://<public-host>:8790/healthz`。
- 检查安全组、防火墙和公网端口。
- 如果使用 `wss://`，检查证书、反向代理和 WebSocket upgrade。

如果 signaling 成功但 DataChannel 失败：

- 优先更换 STUN。
- 尝试手机热点、不同 Wi-Fi 或关闭企业网络代理。
- 如果双方网络都是严格 NAT、运营商 CGNAT 或禁 UDP，当前 direct-only MVP 可能失败，需要后续 TURN fallback。

### 8. 只验证链路的最小流程

如果目标只是确认公网 Tunnel Server 链路是否打通，不需要验证终端输入、会话创建或完整业务能力，只需要验证：

```text
Mobile App -> Public Tunnel Server -> Local Relay -> Local Agent
          signaling                  WebRTC DataChannel
```

最小准备：

- 一台公网服务器，手机公网可访问。
- 内网 Mac 本机运行 Relay 和 Agent。
- 手机安装最新 App，并确认 App 使用 `webrtc` transport。
- 公网服务器安全组和防火墙放行 TCP `8790`。
- 初次验证建议先使用 `ws://`，确认链路后再切换到 `wss://`。

公网服务器启动 Tunnel Server：

```bash
OMNIWORK_TUNNEL_HOST=0.0.0.0 \
OMNIWORK_TUNNEL_PORT=8790 \
pnpm dev:tunnel
```

确认公网健康检查：

```bash
curl http://<public-host>:8790/healthz
```

期望返回：

```json
{"ok":true}
```

内网 Mac 启动 Relay：

```bash
OMNIWORK_RELAY_HOST=127.0.0.1 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_SERVICE_RELAY_URL=ws://<public-host>:8790/relay \
OMNIWORK_TUNNEL_STUN_URLS=stun:stun.cloudflare.com:3478 \
pnpm dev:relay
```

Relay 期望日志：

```text
[omniwork-relay] listening on 127.0.0.1:8787
[omniwork-relay] connected to tunnel service
```

内网 Mac 启动 Agent：

```bash
OMNIWORK_DEVICE_ID=my-mac \
OMNIWORK_RELAY_URL=ws://127.0.0.1:8787/agent \
OMNIWORK_PAIRING_RELAY_URL=ws://<public-host>:8790/mobile \
OMNIWORK_PAIRING_TRANSPORT=webrtc \
pnpm dev:mac
```

Agent 期望状态：

- 输出 `connected to relay`。
- 输出二维码。
- 配对信息中的 `relay_url` 必须是 `ws://<public-host>:8790/mobile`。
- 配对信息中的 `transport` 必须是 `webrtc`。
- 如果 `relay_url` 是 `127.0.0.1` 或 Mac 局域网 IP，说明 `OMNIWORK_PAIRING_RELAY_URL` 没有生效。

手机 App 验证：

1. 手机切到公网网络，避免依赖和 Mac 同一个局域网。
2. 打开 App 并扫描 Agent 二维码。
3. 配对页确认 Relay URL 是 `ws://<public-host>:8790/mobile`。
4. 点击连接。

只验证链路的成功标准：

- Tunnel Server 进程仍在运行，没有报错退出。
- Relay 日志出现 `connected to tunnel service`。
- Agent 日志出现 `connected to relay`。
- App 不再卡在连接中，能进入已连接状态。
- 如 App 有设备或会话列表入口，能成功触发一次加载即可。
- Tunnel Server 只应参与 signaling，不应承载终端帧、输入、会话列表等业务数据。

最小失败判断：

- `/healthz` 不通：公网端口、安全组、防火墙或 Tunnel Server 启动有问题。
- Relay 没有 `connected to tunnel service`：内网 Mac 到公网 `/relay` WebSocket 没连上。
- App 报连接失败：手机访问不了 `ws://<public-host>:8790/mobile`。
- App 报 `agent_not_online`：Relay 没有向 Tunnel Server 注册对应 `device_id`，或 Agent 尚未连接 Relay。
- App 一直连接中但无 `agent_not_online`：signaling 可能已通，但 WebRTC DataChannel 没打通，优先更换 STUN 或换网络验证。

## Cloudflare Tunnel 暴露内网 Relay Runbook

本章节说明如何在没有公网服务器、也不部署独立 Tunnel Service 的场景下，使用 Cloudflare Tunnel 把内网 Relay 的 `/mobile` 端点直接暴露成 `wss://...`。该模式与 [公网 Tunnel Service 联调 Runbook](#公网-tunnel-service-联调-runbook) 互斥，二选一即可。

### 1. 适用范围

适合下列场景：

- 用户没有独立公网服务器，只能在内网 Mac 本机运行 Relay 与 Agent。
- 用户不希望维护 Tunnel Service 进程，只想给 Relay `/mobile` 加一个公网入口。
- 公网链路只承担 signaling 与 WebRTC TLS 握手；WebRTC DataChannel 建联完成后，业务数据仍尽量走 ICE 直连，DataChannel 失败时回退到经 TLS 的 signaling 通道仍由 Cloudflare 边缘转发。

不在范围内：

- 多 Relay、多区域、生产级灰度。
- App、Agent、Relay、protocol 代码层面任何修改 —— 当前实现已直接支持 `wss://*.trycloudflare.com/mobile` 与 `wss://relay.example.com/mobile`，因此该模式只需运维与文档配置。

### 2. 公网链路

```text
Mac Agent --WebSocket--> Local Relay (127.0.0.1:8787)
cloudflared --outbound HTTPS--> Cloudflare Edge
Mobile App --wss://<edge-host>/mobile--> Cloudflare Edge --HTTP/WebSocket--> Local Relay /mobile
Mobile App --wss://<edge-host>/tunnel/mobile--> Cloudflare Edge --HTTP/WebSocket--> Local Relay /tunnel/mobile
Mobile App <==WebRTC DataChannel==> Local Relay
```

关键点：

- `cloudflared` 由内网 Mac 主动出站连接 Cloudflare 边缘，不需要公网服务器，也不需要本机入站端口。
- App 配对二维码里的 `relay_url` 直接写 Cloudflare 边缘地址，例如 `wss://omniwork-foo.trycloudflare.com/mobile`。
- App 内部会基于该 URL 自动派生 `/tunnel/mobile` 作为 WebRTC signaling 地址，无需额外配置。
- 业务数据建联成功后走 WebRTC DataChannel；如果 ICE 全部失败、且未来开启 TURN fallback 前，仍然依赖 Cloudflare 边缘转发 signaling 通道，因此 Cloudflare 仅充当 TLS 公网入口，不是数据面长期承载方。

### 3. 准备 cloudflared

按 Cloudflare 官方文档安装，例如 macOS：

```bash
brew install cloudflared
cloudflared --version
```

不建议把 cloudflared 嵌进 Agent 进程托管，原因是：

- cloudflared 已经是成熟独立进程，没必要在 Agent 里再做一层进程编排。
- 用户有可能直接走 Named Tunnel + 自有域名，托管化反而限制能力。

### 4. 启动内网 Relay

终端 1：

```bash
OMNIWORK_RELAY_HOST=127.0.0.1 \
OMNIWORK_RELAY_PORT=8787 \
OMNIWORK_TUNNEL_STUN_URLS=stun:stun.cloudflare.com:3478 \
pnpm dev:relay
```

成功标准：

```text
[omniwork-relay] listening on 127.0.0.1:8787
```

说明：

- `OMNIWORK_RELAY_HOST=127.0.0.1` 即可，因为 cloudflared 与 Relay 都在本机；不要写 `0.0.0.0`，避免无关公开。
- 不需要设置 `OMNIWORK_TUNNEL_SERVICE_RELAY_URL`；该变量只属于公网 Tunnel Service 模式。

### 5. 启动 cloudflared (二选一)

#### 5.1 Quick Tunnel（无 Cloudflare 账号、无固定域名）

终端 2：

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

成功标准：

```text
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take a few moments to be reachable):
|  https://omniwork-foo.trycloudflare.com
+--------------------------------------------------------------------------------------------+
```

记录该域名作为后续配对地址使用。Quick Tunnel 每次重启会换新域名，仅用于开发与体验。

#### 5.2 Named Tunnel（已有 Cloudflare 账号与域名）

按 [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 完成 `cloudflared login`、`cloudflared tunnel create omniwork-relay`，并在 `~/.cloudflared/config.yml` 写入：

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: relay.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

启动：

```bash
cloudflared tunnel run omniwork-relay
```

DNS 配置：

```bash
cloudflared tunnel route dns omniwork-relay relay.example.com
```

成功标准：浏览器或 `curl` 访问 `https://relay.example.com/healthz` 返回 `{"ok":true}`。

### 6. 公网可达性检查

任意外网终端：

```bash
curl https://omniwork-foo.trycloudflare.com/healthz
```

或：

```bash
curl https://relay.example.com/healthz
```

期望返回：

```json
{"ok":true}
```

如果 `/healthz` 不通：

- 检查 cloudflared 进程是否仍在运行。
- 检查 Quick Tunnel 是否被关闭、被换链接。
- Named Tunnel 模式检查 `ingress` 是否指向 `http://127.0.0.1:8787`。

### 7. 启动 Agent

终端 3：

```bash
OMNIWORK_DEVICE_ID=my-mac \
OMNIWORK_RELAY_URL=ws://127.0.0.1:8787/agent \
OMNIWORK_PAIRING_RELAY_URL=wss://omniwork-foo.trycloudflare.com/mobile \
OMNIWORK_PAIRING_TRANSPORT=webrtc \
pnpm dev:mac
```

Named Tunnel 模式则把 `OMNIWORK_PAIRING_RELAY_URL` 改成 `wss://relay.example.com/mobile`。

成功标准：

- Agent 输出 `connected to relay`。
- Agent 输出二维码。
- 配对信息中的 `relay_url` 严格等于 `OMNIWORK_PAIRING_RELAY_URL`，没有被本地 IP 替换。
- 配对信息中的 `transport` 是 `webrtc`。

说明：

- `OMNIWORK_RELAY_URL` 只用于 Agent 自己连接本机 Relay，不会出现在二维码里。
- `OMNIWORK_PAIRING_RELAY_URL` 是非 `0.0.0.0`/`127.0.0.1`/`localhost` 的普通公网 URL，Agent 不会替换 hostname。
- 如果同时设置了 `OMNIWORK_TUNNEL_SERVICE_RELAY_URL`，相当于走 Tunnel Service 模式，应避免与 Cloudflare Tunnel 模式同时启用。

### 8. App 端验证

1. 手机切到任意可访问公网的网络（移动数据或非内网 Wi-Fi）。
2. 打开 OmniWork App 并扫描 Agent 二维码。
3. 确认配对页 Relay URL 是 `wss://...trycloudflare.com/mobile` 或 `wss://relay.example.com/mobile`。
4. 选择 transport `WebRTC` 或 `WebSocket Relay`：
   - `WebRTC`：App 通过 `wss://<edge>/tunnel/mobile` 走 signaling，DataChannel 建立后业务数据走 ICE。
   - `WebSocket Relay`：App 通过 `wss://<edge>/mobile` 全量走 Cloudflare 边缘，无 P2P。
5. 点击连接。

### 9. Cloudflare Tunnel 模式成功标准

需要同时满足：

- 公网 `/healthz` 可访问。
- App 配对页能完成连接，进入会话列表或终端入口。
- Agent 终端没有 `tunnel.session.failed`。
- Relay 终端没有 `RTCPeerConnection is not available`。
- 业务消息触发后 Agent 终端有相应日志，说明已穿越 Cloudflare 边缘到达 Relay 再到 Agent。

### 10. Cloudflare Tunnel 模式排查

如果 App 报 `agent_not_online`：

- 确认 Agent 已启动并连接本机 Relay。
- 确认 `OMNIWORK_DEVICE_ID` 与二维码中的 `device_id` 一致。
- 确认 cloudflared 转发的是同一个 Relay 实例。

如果 App 卡在连接中但没有 `agent_not_online`：

- 优先排查 WebRTC DataChannel：尝试切换网络（手机热点、家庭 Wi-Fi、移动数据），排除 NAT 与运营商 UDP 限制。
- 再次确认 Relay 端未输出 `RTCPeerConnection is not available`。
- 没有 TURN fallback，对称 NAT 与禁 UDP 网络下可能直连失败；此时改用 transport `WebSocket Relay`，所有数据走 Cloudflare TLS 边缘。

如果 cloudflared 报 `connection refused`：

- 检查 Relay 是否在 `127.0.0.1:8787` 监听。
- Named Tunnel 模式检查 `ingress.service` 是否拼写正确。

如果 Cloudflare 边缘对 WebSocket 升级失败：

- Cloudflare 默认允许 WebSocket，但如果使用了 Cloudflare 仪表板的 SSL/TLS、Cache、WAF 自定义规则，需要确认未阻断 `Upgrade: websocket`。
- 如果使用自有域名走 Cloudflare CDN（橙云模式），保留默认 WebSocket 即可；如果用 Cloudflare One Tunnel + Access，需要给 `relay.example.com` 单独开放无认证策略，或在 App 与 Cloudflare Access token 之间提前完成认证。

## 当前 MVP 的限制

- 当前真实设备 P2P 是 `Mobile App <-> Relay` 的 WebRTC DataChannel，不是 `Mobile App <-> Agent` 直连。
- 本地 `/tunnel/mobile` signaling 要求 Mobile 能访问 Relay；公网模式可改为访问独立 Tunnel Service 或 Cloudflare Tunnel 暴露的内网 Relay。
- 没有 TURN fallback，复杂 NAT 或禁 UDP 网络下可能失败；Cloudflare Tunnel 模式可作为兜底，让 App 改用 transport `WebSocket Relay` 全程走 TLS 边缘。
- 公网 Tunnel Service MVP 尚未加入注册 token、设备级授权、限流和审计，生产化前必须补齐。
- Cloudflare Tunnel 模式默认不带账号绑定与设备授权，仅依赖现有临时 key + HMAC proof；如果对外暴露需补齐 Cloudflare Access、IP 限制或自有 token。
- 没有专门的 WebRTC 连接质量 UI 和 Relay ready 日志，后续需要补充可观测性。
- 没有多 Relay、多区域或多 Tunnel Service 编排。

## 结论摘要

当前确定将系统连接层抽象为统一的 `Tunnel Provider`，优先推进自研 P2P MVP，再补充 Cloudflare-like 增量能力：

1. **自实现直连穿透模式**
   - 作为 MVP 主路径。
   - 复用 WebRTC ICE/DataChannel。
   - 目标是 Tunnel Service 只负责建联和候选地址交换，建联完成后不进入数据路径。
   - 由 Mobile 和 Relay 分别连接 Tunnel Service，完成鉴权、会话建立、NAT 探测和直连协商。
   - 直连成功后，业务流量由 Mobile 和 Relay 直接交互。

2. **Cloudflare-like 反向隧道模式**
   - 作为增量 Provider。
   - 由内网 Relay 主动向公网 Tunnel Provider 建立出站连接。
   - Mobile 通过公网域名访问现有 Relay。
   - 用于 P2P 不可用、企业网络限制较强或需要快速稳定公网入口的场景。

需要明确一个关键判断：

- 如果要求 Tunnel Service 在建联后完全退出数据路径，则该方案无法保证所有网络环境都成功。
- 在对称 NAT、移动运营商 CGNAT、企业代理、禁 UDP 或严格防火墙环境下，直连可能失败。
- 因此生产方案必须提供可选的中继兜底能力，只是默认优先直连。

最终按双路线推进：

- 短期先落地基于 WebRTC ICE/DataChannel 的自实现直连穿透 MVP。
- 中期补齐 P2P fallback、连接质量探测和生产化能力。
- 后续再接入 Cloudflare-like 反向隧道，作为增量 Provider 和稳定兜底路径。
- 对上层业务统一为一个连接抽象，不让 App、Relay、Agent 直接耦合某个具体隧道产品。

## 背景与现状

当前项目已经具备公司内网控制能力，基本链路为：

```text
Mobile App <-> Company Relay <-> Mac Agent
```

现有实现特点：

- `relay/server` 已负责 Mobile 与 Agent 的连接路由和鉴权中继。
- `packages/protocol-ts` 已定义跨端消息协议。
- `app` 和 `mac/agent` 已完成基于 WebSocket 的连接模型。
- 当前链路默认假设 Mobile 能访问公司内网 Relay，尚未完整覆盖公网场景。

对应的当前能力边界是：

- 业务控制协议已存在。
- 会话和终端交互模型已存在。
- 缺少公网到内网 Relay 的接入方案。
- 缺少在复杂 NAT 环境下的建联策略和可观测性。

## 目标与非目标

## 目标

- MVP 优先支持自实现的 WebRTC P2P 内网穿透能力。
- 增量支持类似 Cloudflare Tunnel 的公网访问能力。
- 尽量复用当前 Relay、App、Agent 的协议和鉴权模型。
- 上层业务不感知具体隧道实现。
- 在可行时让 Mobile 与 Relay 建立直连。
- 对生产环境提供审计、限流、可观测和故障回退能力。

## 非目标

- 本阶段不重写现有 Relay 业务协议。
- 本阶段不把 Agent 改造成完整 VPN 节点。
- 本阶段不优先建设系统级 Overlay Network。
- 本阶段不追求在所有网络环境下都只靠纯直连成功。

## 设计原则

- **控制面和数据面分离**：鉴权、配对、会话编排在控制面；业务数据走数据面。
- **传输层可插拔**：WebSocket、反向隧道、P2P 通道都通过统一接口接入。
- **业务协议复用**：保持当前 `Envelope` 和消息类型不变，尽量只替换底层传输。
- **默认最小改动**：MVP 不改动当前 Agent 的核心业务逻辑，优先在 Relay 和 App 连接层新增 P2P 传输能力。
- **安全边界前置**：隧道本身不是最终信任边界，业务层仍需保留现有鉴权和签名校验。
- **失败可降级**：P2P 失败时允许根据策略切换到加密中继。

## 总体架构

推荐在现有系统之上增加一个逻辑层：

```text
                 +----------------------+
                 |  Tunnel Orchestrator |
                 | provider / policy    |
                 | auth / audit / state |
                 +----------+-----------+
                            |
          +-----------------+------------------+
          |                                    |
          v                                    v
 Cloudflare-like Provider               Self P2P Provider
 (Cloudflare/frp/rathole)              (Rendezvous + STUN + ICE)
          |                                    |
          v                                    v
   Mobile -> public edge -> Relay       Mobile <====direct====> Relay
```

对应到当前项目，建议增加以下抽象：

- `TunnelProvider`
  - 统一定义 tunnel 初始化、连接建立、健康检查、错误分类、回退策略。
- `TunnelSession`
  - 表示一次 Mobile 与 Relay 的连接会话。
- `TunnelPolicy`
  - 定义 `direct_only`、`direct_then_relay`、`relay_only` 等策略。
- `TunnelEndpointResolver`
  - 负责给 Mobile 返回当前可用入口地址和推荐连接方式。

## 接入当前工程的建议

### App 侧

- 保持当前 Relay Client 上层 API 不变。
- 新增 `TunnelAdapter`，负责获取最终可用的 Relay 连接入口。
- 在 App 中区分三类连接目标：
  - `intranet`
  - `public_tunnel`
  - `p2p_session`

### Relay 侧

- 保持当前业务 Relay 能力不变，继续承载现有业务消息路由。
- 新增 `TunnelConnector` 模块，用于把 Relay 暴露到外部连接体系中。
- 新增 Tunnel 状态上报、健康检查、入口注册地址等能力。

### Protocol 侧

- 保持现有业务消息协议不变。
- 仅在控制面补充 Tunnel 建联相关消息类型。
- 直连建立后，继续复用当前业务消息 Envelope 作为数据载荷。

### Agent 侧

- 第一阶段无需感知 Tunnel 变化。
- 若后续要让 Relay 下沉到本机或需要 Agent 直接参与 P2P，再扩展 Agent 侧连接能力。

## 增量方案：Cloudflare-like 反向隧道

## 增量范围

Cloudflare-like 增量能力只解决一个核心问题：

```text
公网 Mobile 可以稳定连接内网 Relay，并继续复用现有业务协议。
```

增量版本必须包含：

- Relay 可通过公网域名暴露 `wss://.../mobile` 和必要的健康检查入口。
- Relay 所在内网不需要开放入站端口。
- Mobile 可以通过配置或入口发现拿到公网 Relay URL。
- 现有临时 key、HMAC proof 和业务路由流程保持不变。
- Relay 和 App 能区分当前连接来自 `intranet` 还是 `public_tunnel`。
- 支持最小可观测指标：连接成功、连接失败、认证失败、断开原因。

增量版本暂不包含：

- P2P 实现本身。
- 多 Provider 自动切换。
- 业务层端到端加密改造。
- 自建 TURN/DERP 兜底。

## 核心思路

内网 Relay 主动向外部隧道服务建立长期出站连接，Mobile 不再直接访问内网地址，而是访问公网入口。

```text
Mobile -> Public Tunnel Entry -> Tunnel Provider -> Relay -> Agent
```

## 适配方式

- Relay 侧部署 tunnel connector。
- connector 主动连接公网入口，不要求内网开放入站端口。
- Mobile 连接公网域名，例如 `wss://relay.example.com/mobile`。
- Relay 内部的鉴权和路由逻辑保持不变。

## 优点

- 上线速度最快。
- 对当前系统改动最小。
- 不需要自研 NAT 穿透算法。
- 运维路径清晰，适合快速验证公网闭环。

## 缺点

- Tunnel Provider 持续处于数据路径。
- 会存在外部供应商依赖或自建边缘节点运维成本。
- 若隧道服务终止 TLS，则需要关注数据路径可见性。

## 适用场景

- P2P MVP 之后的增量 Provider。
- 需要快速让外网手机访问内网 Relay。
- 企业内网对出站连接放行、但不愿开放入站端口。
- P2P 在当前网络环境下不可用，需要稳定兜底。

## 实现建议

- 托管方案优先使用 Cloudflare Tunnel。
- 自托管替代方案优先使用 frp。
- rathole 作为轻量备选，不进入增量版本默认实现。
- 上层统一走 `TunnelProvider`，避免业务代码写死某个厂商。

## Cloudflare-like 增量交付项

- `TunnelProvider` 增加 `cloudflare_like` 类型。
- Relay 支持从环境变量或配置读取公网入口信息。
- App 支持从配置或入口发现结果连接公网 Relay URL。
- 部署文档补充 Cloudflare Tunnel 或 frp 的最小配置。
- 监控指标补充 tunnel 连接状态、认证结果和断开原因。
- 灰度开关支持在 `intranet` 和 `cloudflare_like` 之间切换。

## MVP 方案：自实现直连穿透

## 已选技术路线

MVP 直连方案明确选择：

```text
WebRTC ICE + WebRTC DataChannel + STUN + 可选 TURN fallback
```

技术边界：

- 复用 ICE 做候选收集、连通性检查和 NAT traversal。
- 复用 DataChannel 承载现有业务 Envelope。
- Tunnel Service 只承担 signaling 和会话编排。
- 不自研 UDP hole punching。
- 不自研可靠传输、拥塞控制和重传机制。
- 不引入完整 VPN / WireGuard mesh 作为第一版实现。

## 核心思路

新增独立的 `Tunnel Service`，它只承担控制面职责：

- Relay 注册
- Mobile 加入
- 会话创建
- 候选地址交换
- NAT 探测协助
- 密钥协商与鉴权

建联成功后，业务数据不再经过 `Tunnel Service`，而是由 Mobile 和 Relay 直接通信。

```text
1. Relay  -> Tunnel Service: register
2. Mobile -> Tunnel Service: join
3. Tunnel Service: authenticate and exchange candidates
4. Mobile <-> Relay: direct connectivity checks
5. Mobile <-> Relay: establish secure direct channel
6. Tunnel Service: exit data path
```

## 推荐技术路线

第一版直连方案基于 **WebRTC DataChannel**。

原因：

- 自带 ICE、STUN、TURN 能力模型。
- 移动端生态成熟，Android 和 iOS 可用性较高。
- 内置加密握手，适合跨公网双向消息传输。
- 可靠数据通道足以承载当前 WebSocket 语义的业务消息。

备选路线：

- `QUIC + ICE`
  - 长期能力强，但工程复杂度高。
- 自研 UDP 打洞 + 自研可靠传输
  - 不建议，复杂度和风险过高。
- WireGuard / Mesh VPN
  - 体系太重，不适合作为当前阶段主路线。

上述备选路线仅保留为长期技术观察项，不进入当前推进范围。

## P2P MVP 范围

P2P MVP 只验证最小直连闭环：

- Relay 侧运行 WebRTC peer。
- Mobile 侧运行 WebRTC peer。
- Tunnel Service 完成 signaling。
- 双方通过 ICE 完成候选交换和连通性检查。
- DataChannel 建立后传输现有业务 Envelope。
- 直连失败时记录失败原因，但 MVP 阶段可以不自动 fallback。

P2P MVP 不承诺：

- 后台长期保活。
- 所有 NAT 类型成功。
- 多地域最优路径选择。
- 多 Relay 高可用。
- TURN 生产级容量。

## P2P 生产化范围

P2P 进入生产前必须补齐：

- `direct_then_relay` 策略。
- TURN fallback 或等价的加密中继兜底。
- ICE 失败原因分类。
- 网络切换后的重协商。
- App 前后台切换处理。
- 连接质量指标。
- 灰度、开关和远程策略。
- 安全审计和限流。

## 关键组件

### Tunnel Service

职责：

- 设备鉴权。
- 会话创建。
- 候选地址交换。
- 连接状态管理。
- 失败原因归档。
- 审计日志。

不负责：

- 长期转发业务数据。
- 替代业务 Relay 路由能力。

### WebRTC Signaling

职责：

- 传递 offer。
- 传递 answer。
- 传递 ICE candidate。
- 绑定 `session_id`、`relay_id`、`mobile_id`。
- 校验消息签名和时效。

约束：

- signaling 消息不得承载业务数据。
- signaling 通道断开不应立即中断已建立的直连数据面。
- 直连失败后可以重新发起 signaling。

### STUN 服务

职责：

- 获取公网映射地址。
- 为直连协商提供 server reflexive candidate。

建议：

- 可先复用成熟 STUN 服务验证方案。
- 生产可自建或与 TURN 服务一体化部署。

### TURN 或 DERP 兜底

职责：

- 当直连失败时作为加密中继。
- 只转发密文，不持有业务层明文。

建议：

- 虽然目标是建联后退出数据路径，但生产环境必须保留兜底能力。
- 策略上可以默认 `direct_then_relay`，也可以对高安全场景允许 `direct_only`。

## 关键限制

- 纯直连无法保证 100% 成功率。
- 严格企业网络、对称 NAT、禁 UDP 环境下常常需要中继。
- 移动网络切换会影响直连稳定性，需要处理重协商和重连。

## 推荐的控制面协议

建议在现有协议上增加以下消息类型：

```text
tunnel.relay.register
tunnel.mobile.join
tunnel.session.create
tunnel.session.offer
tunnel.session.answer
tunnel.session.candidate
tunnel.session.check
tunnel.session.ready
tunnel.session.failed
tunnel.session.close
```

控制面原则：

- 会话建立和候选地址交换走 Tunnel Service。
- 数据面建立成功后，上层业务继续走现有 Envelope。
- 上层不感知底层是 WebSocket、反向隧道还是 P2P DataChannel。

## WebRTC 数据面封装

DataChannel 建立后，建议封装为统一的传输接口：

```text
Transport.send(envelope)
Transport.onMessage(handler)
Transport.close(reason)
Transport.getStats()
```

封装要求：

- Envelope 编码保持和当前 WebSocket 传输一致。
- DataChannel 打开后再发送业务认证后续消息。
- DataChannel 关闭时向上层抛出统一断开原因。
- 通过 `getStats()` 汇报 RTT、丢包、重传、candidate pair 等指标。

## 安全设计

## 基本原则

- 隧道只解决连通性，不替代业务鉴权。
- 业务层保留现有临时 key、HMAC proof、设备身份校验模型。
- Tunnel Service 只保存最小必要元数据。

## 建议措施

- Relay 和 Mobile 在建联时使用短期公私钥进行签名和身份绑定。
- pairing token 只用于授权当前会话，不直接作为数据面主密钥。
- 所有控制面消息带 `session_id`、`nonce`、`timestamp` 和签名。
- 控制面接口需要限流、防重放和失败审计。
- 日志默认不落地原始敏感载荷，只记录摘要和状态。

## 数据路径安全

- 如果使用 Cloudflare-like 方案，建议通过业务层端到端加密降低中间路径可见性。
- 如果使用 P2P + fallback，要求 fallback 节点仅转发密文。
- 无论是否直连，都不应把隧道入口视为唯一安全边界。

## 市面技术方案调研

## 一类：托管反向隧道

### Cloudflare Tunnel

- 特点：由 `cloudflared` 从内网主动向 Cloudflare 建立 outbound-only 连接，无需开放入站端口。
- 优点：部署快、稳定性高、证书和公网入口能力成熟。
- 缺点：强厂商依赖，数据路径经过 Cloudflare 网络，私有化和可控性有限。
- 结论：适合作为 P2P MVP 之后的增量 Provider 和稳定兜底路径。

参考：

- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/tunnel/)
- [Cloudflare One Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)

### ngrok

- 特点：开发者体验成熟，支持公网入口、观察和鉴权。
- 优点：上手快，适合开发测试和演示。
- 缺点：闭源、长期成本较高、私有化弱。
- 结论：更适合开发和临时使用，不建议作为长期主方案。

## 二类：自托管反向隧道

### frp

- 特点：成熟开源，支持 TCP、UDP、HTTP、HTTPS，也支持 P2P 模式。
- 优点：社区成熟、协议丰富、可自托管、适合企业私有化。
- 缺点：配置和治理复杂度高于托管产品。
- 结论：最适合作为自托管版 Cloudflare-like 方案。

参考：

- [frp GitHub](https://github.com/fatedier/frp)
- [frp 文档](https://gofrp.org/)

### rathole

- 特点：Rust 实现，轻量、高性能。
- 优点：资源占用低，适合简单稳定的数据转发场景。
- 缺点：生态、管理面和成熟配套弱于 frp。
- 结论：适合作为轻量自托管 Provider 备选。

参考：

- [rathole GitHub](https://github.com/rapiz1/rathole)

### chisel / boringproxy / pangolin

- 特点：分别偏向穿透能力、可管理代理、隧道管理面。
- 优点：适合特定团队或轻量管理场景。
- 缺点：和当前业务模型的深度集成价值不如 frp 明确。
- 结论：可关注，但不作为主推荐。

## 三类：P2P / Mesh / 加密中继

### Tailscale

- 特点：优先直连，失败时走 DERP 中继；所有连接默认端到端加密。
- 优点：直连与中继切换模型成熟，DERP 架构非常值得借鉴。
- 缺点：完整接入意味着引入更重的网络层体系，不适合作为当前产品的 MVP 主实现。
- 结论：强烈建议借鉴其建联设计，但不建议当前直接整体接入。

参考：

- [Tailscale Connection Types](https://tailscale.com/kb/1257/connection-types)
- [Tailscale DERP Servers](https://tailscale.com/docs/reference/derp-servers)
- [Tailscale Encryption](https://tailscale.com/docs/concepts/tailscale-encryption)

### NetBird / Headscale / ZeroTier / Nebula

- 特点：偏向 Mesh 网络或自托管控制平面。
- 优点：网络能力完整，适合长期企业网络接入。
- 缺点：体系较重，需要更高部署和客户端接入成本。
- 结论：不适合本阶段 MVP，但可作为长期企业网络方案备选。

### WebRTC DataChannel

- 特点：自带 ICE / STUN / TURN 模型，适合移动端直连。
- 优点：与“建联服务只做控制面”目标最匹配，跨端成熟。
- 缺点：需要处理移动端网络切换、ICE 状态、可靠性策略和 fallback。
- 结论：推荐作为自实现直连方案的第一选择。

### coturn

- 特点：成熟的 TURN/STUN 组件。
- 优点：标准化、成熟、部署经验丰富。
- 缺点：启用 TURN 时仍会进入数据路径。
- 结论：适合作为自实现方案的生产兜底组件。

## 推荐方案

已确定采用统一抽象下的双路线方案，MVP 优先 WebRTC P2P，Cloudflare-like 作为后续增量：

### 第一阶段：WebRTC P2P MVP

- 引入自实现 `Tunnel Service`。
- 采用 `WebRTC ICE/DataChannel + STUN` 的模型。
- 先验证 `direct_only` 或手动 fallback。
- 不修改现有业务 Envelope，只替换底层传输。

验收标准：

- Mobile 和 Relay 可通过 Tunnel Service 完成 signaling。
- 双方能建立 WebRTC DataChannel。
- 现有 Envelope 可在 DataChannel 上双向传输。
- Tunnel Service 不转发业务数据。
- 直连失败原因可观测。
- Mac Agent 与 Mobile 的原有业务交互不受影响。

### 第二阶段：TunnelProvider 抽象

- 抽象 `TunnelProvider` 和 `TunnelPolicy`。
- 优先支持 `intranet` 和 `p2p_webrtc`。
- 为后续 Cloudflare-like Provider 做接口准备。

验收标准：

- App 上层连接逻辑不直接依赖 WebRTC 实现细节。
- Relay 上报统一 tunnel 状态。
- 连接失败原因统一归类。
- 后续新增 `cloudflare`、`frp` Provider 不需要重写业务协议。

### 第三阶段：P2P 生产化

- 补齐生产所需能力：
  - `direct_then_relay` 策略
  - TURN 或等价加密中继兜底
  - ICE 失败原因分类
  - 网络切换重协商
  - App 前后台切换处理
  - 连接质量指标
  - 灰度、开关和远程策略

验收标准：

- 默认策略支持 `direct_then_relay`。
- 直连失败可自动回退到 TURN 或等价加密中继。
- 网络切换可重连或重协商。
- App 前后台切换行为明确。
- 可按用户、设备、环境灰度开启 P2P。

### 第四阶段：Cloudflare-like 增量

- 使用 Cloudflare Tunnel 或自托管 frp，补充稳定公网入口。
- 不修改现有业务协议，只新增 Provider 配置和入口发现能力。
- 作为 P2P 不可用时的增量兜底路径。

验收标准：

- Mobile 可通过公网域名连接 Relay。
- 认证失败、Relay 不在线、Tunnel 不可用都有明确错误。
- Relay 无需开放内网入站端口。
- 可以通过配置开关在 P2P、Cloudflare-like、内网连接之间切换。

## 统一的策略模型

建议定义以下策略：

- `direct_only`
  - 只允许直连。
  - 适合强安全或实验场景。
  - 失败率最高。

- `direct_then_relay`
  - 优先直连，失败后回退中继。
  - 适合默认生产策略。

- `relay_only`
  - 永远走反向隧道或中继。
  - 适合最稳定、最快上线的场景。

## 推荐演进路径

```text
阶段 1: 现有内网模式
阶段 2: WebRTC P2P MVP
阶段 3: TunnelProvider 抽象
阶段 4: P2P + Relay Fallback 生产化
阶段 5: Cloudflare-like 增量 Provider
```

推荐默认顺序：

```text
P2P direct -> self-hosted relay fallback -> managed tunnel provider
```

业务落地顺序与默认连接优先级保持一致：

```text
P2P direct MVP -> provider abstraction -> P2P fallback -> Cloudflare-like incremental provider
```

原因是：

- 先验证目标架构中最关键的直连能力。
- 再抽象可插拔架构，避免后续 Provider 侵入业务层。
- 最后补齐反向隧道增量能力，用于不可直连网络和稳定兜底。

## 风险与难点

- P2P 直连成功率依赖网络环境，无法完全由应用控制。
- iOS 和 Android 的后台、锁屏、网络切换会影响长连接稳定性。
- 如果未来希望所有数据面都端到端加密，需要在业务层补充更严格的会话密钥模型。
- 若同时支持多种 Provider，需要统一错误分类、指标、告警和灰度能力。
- 自建 Tunnel Service 后，控制面稳定性会直接影响连接成功率。

## 实施建议

## 建议先做

- 设计 `Tunnel Service` 控制面协议。
- 验证 `WebRTC ICE/DataChannel` 在 Mobile 和 Relay 场景下的可行性。
- 给 Mobile 和 Relay 增加 P2P signaling 与 DataChannel 传输封装。
- 建立连接质量指标和失败原因分类。
- 保持现有业务 Relay 协议和鉴权模型不变。

## 第二批再做

- 确定 `TunnelProvider` 抽象。
- 引入 STUN 和可选 TURN 兜底。
- 接入 `Cloudflare Tunnel`，必要时用 `frp` 做自托管替代。
- 给 Mobile 增加入口发现和动态连接目标能力。
- 给 Relay 增加公网入口注册和健康状态上报。

## 待确认问题

- 自实现直连方案中，Relay 是否长期部署在固定内网节点，还是未来会下沉到 Agent 本机。
- 移动端是否允许在部分网络环境下回退到中继，还是必须严格 direct-only。
- 企业合规上是否允许优先使用 Cloudflare 这类外部托管服务。
- 未来是否要求业务层做到严格端到端加密。
- Tunnel Service 是否需要多地域部署，以及是否需要与现有 Relay 分离部署。

## 最终建议

最终按以下方案推进：

- **产品默认方案**：先落地 WebRTC P2P MVP，优先验证“服务只参与建联、后续直连”的核心目标。
- **技术架构方案**：抽象统一 `Tunnel Provider`，避免业务层绑定具体厂商。
- **长期演进方案**：自实现 `Tunnel Service + WebRTC ICE/DataChannel + STUN/TURN`，达成“优先直连，必要时回退”的能力。
- **增量兜底方案**：Cloudflare-like 反向隧道后续接入，作为 P2P 不可用场景下的稳定 Provider。
- **关键工程判断**：严格意义上的“服务只参与建联、后续完全不参与数据传输”只能作为优先路径，不能作为所有网络环境下的唯一承诺。

该方案兼顾了短期交付速度、长期可控性和对现有系统的复用程度，是当前阶段最稳妥的设计路线。
