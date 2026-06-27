import type {
  MessageEnvelope,
  P2pChannelKind,
  SessionTransport,
  TransportPath,
  WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";
import type { AgentRelayPath } from "./relayPath.ts";
import {
  channelForP2pEnvelope,
  getEnvelopeAppConnectionId,
} from "./session-transport/channelRouter.ts";
import {
  DRAIN_DELAY_MS,
  type AttachP2pPeerOptions,
  type DowngradeReasonHandler,
  type ForceCloseHandler,
  type MessageHandler,
  type PathChangeHandler,
  type QueuedSend,
  type SendOptions,
  type TransportEventHandler,
} from "./session-transport/types.ts";
import { TransportEventBus } from "./session-transport/eventBus.ts";
import { TransportRouteStore } from "./session-transport/routeStore.ts";
import { StrictP2pGate } from "./session-transport/strictP2pGate.ts";
import { P2pPeerRegistry } from "./session-transport/p2pPeerRegistry.ts";
import { TransportHealthMonitor } from "./session-transport/healthMonitor.ts";
import { TransportDowngradeController } from "./session-transport/downgradeController.ts";
export { DISPLAY_FRAME_BUFFERED_AMOUNT_LIMIT } from "./session-transport/types.ts";
export type { AttachP2pPeerOptions } from "./session-transport/types.ts";

export interface AgentSessionTransportOptions {
  /**
   * 严格 P2P 模式标记，由 mobile.connect.transport_preference="prefer_p2p"
   * 通过 tunnel.upgrade.propose.strict 透传。strict 模式下 transport 行为：
   * - 升级前 send() 拒绝业务消息（仅放行 tunnel.upgrade.* / transport.*）
   * - 升级后任何健康降级理由都改为 forceClose，不会切回 relay
   */
  strictP2p?: boolean;
  /**
   * strict 模式下 transport 触发"严格 P2P 失败"时调用，由上层（通常是
   * agentService）清理与该 mobile 相关的会话状态。
   */
  onForceClose?: ForceCloseHandler;
}

export class AgentSessionTransport implements SessionTransport {
  private readonly relayPath: AgentRelayPath;
  private readonly eventBus = new TransportEventBus();
  private readonly routeStore = new TransportRouteStore();
  private readonly peerRegistry = new P2pPeerRegistry({
    routeStore: this.routeStore,
    dispatch: (message) => this.dispatch(message),
    handleIncomingPing: (envelope) =>
      this.healthMonitor.handleIncomingPing(envelope),
    handleIncomingPong: (envelope) =>
      this.healthMonitor.handleIncomingPong(envelope),
    handleIncomingPingForConnection: (appConnectionId, envelope) =>
      this.healthMonitor.handleIncomingPingForConnection(
        appConnectionId,
        envelope,
      ),
    handleIncomingPongForConnection: (appConnectionId, envelope) =>
      this.healthMonitor.handleIncomingPongForConnection(
        appConnectionId,
        envelope,
      ),
    handleHealthDowngrade: (reason) => this.handleHealthDowngrade(reason),
    handleHealthDowngradeForConnection: (appConnectionId, reason) =>
      this.handleHealthDowngradeForConnection(appConnectionId, reason),
    armIceDisconnectedTimer: () => this.healthMonitor.armIceDisconnectedTimer(),
    armIceDisconnectedTimerForConnection: (appConnectionId) =>
      this.healthMonitor.armIceDisconnectedTimerForConnection(appConnectionId),
    clearIceDisconnectedTimer: () =>
      this.healthMonitor.clearIceDisconnectedTimer(),
    clearIceDisconnectedTimerForConnection: (appConnectionId) =>
      this.healthMonitor.clearIceDisconnectedTimerForConnection(
        appConnectionId,
      ),
    currentGlobalPath: () => this.currentPath,
  });
  private readonly healthMonitor = new TransportHealthMonitor({
    peerRegistry: this.peerRegistry,
    routeStore: this.routeStore,
    emitEvent: (event) => this.eventBus.emitEvent(event),
    globalStrictP2p: () => this.strictP2p,
    globalCurrentPath: () => this.currentPath,
    globalUpgradeId: () => this.upgradeId,
    handleHealthDowngrade: (reason) => this.handleHealthDowngrade(reason),
    handleHealthDowngradeForConnection: (appConnectionId, reason) =>
      this.handleHealthDowngradeForConnection(appConnectionId, reason),
  });
  private readonly strictGate = new StrictP2pGate({
    emitEvent: (event) => this.eventBus.emitEvent(event),
    forceClose: (reason) => this.forceClose(reason),
    forceCloseConnection: (appConnectionId, reason) =>
      this.forceCloseConnection(appConnectionId, reason),
    dispatchSend: (envelope, channel) => this.dispatchSend(envelope, channel),
  });
  private readonly downgradeController = new TransportDowngradeController({
    routeStore: this.routeStore,
    peerRegistry: this.peerRegistry,
    strictGate: this.strictGate,
    emitEvent: (event) => this.eventBus.emitEvent(event),
    currentPath: () => this.currentPath,
    strictP2p: () => this.strictP2p,
    forceClosed: () => this.forceClosed,
    setForceClosed: (forceClosed) => {
      this.forceClosed = forceClosed;
    },
    globalDowngradeHandler: () => this.downgradeHandler,
    globalForceCloseHandler: () => this.forceCloseHandler,
    clearGlobalStrictState: () => {
      this.strictP2p = false;
      this.forceCloseHandler = null;
    },
    detachP2pPeer: (appConnectionId) => this.detachP2pPeer(appConnectionId),
    resetPathState: () => this.resetPathState(),
    switchPath: (target) => this.switchPath(target),
    switchPathForConnection: (appConnectionId, target) =>
      this.switchPathForConnection(appConnectionId, target),
  });
  private currentPath: TransportPath = "relay";
  private closed = false;
  private outboundQueue: QueuedSend[] | null = null;
  private switching = false;
  private downgradeHandler: DowngradeReasonHandler | null = null;
  private upgradeId: string | null = null;
  private strictP2p: boolean;
  private forceCloseHandler: ForceCloseHandler | null;
  private forceClosed = false;

  constructor(
    relayPath: AgentRelayPath,
    options: AgentSessionTransportOptions = {},
  ) {
    this.relayPath = relayPath;
    this.strictP2p = options.strictP2p ?? false;
    this.forceCloseHandler = options.onForceClose ?? null;
    this.relayPath.onMessage((message) => this.dispatch(message));
  }

  /**
   * agent 端的 transport 复用同一实例横跨多次 mobile 连接：
   * 当协议层从 propose.strict 解析出新一轮 strict 模式时，需要在握手前
   * 把状态切到 strict；非 strict 时也要复位 forceClosed 标记，避免误判。
   *
   * 同时对 transport 运行期状态做完整 reset（detach peer / 切回 relay
   * path / 清空所有队列与计数），让本次 mobile 进入握手前状态机回归初始态，
   * 避免上一轮残留导致 switchPath 被 short-circuit 或 currentPath 与 peer
   * 脱钩等"虚连"问题。
   */
  configureStrictP2p(
    strictP2p: boolean,
    onForceClose: ForceCloseHandler | null = null,
  ): void {
    this.strictP2p = strictP2p;
    this.forceCloseHandler = onForceClose;
    this.forceClosed = false;
    this.detachP2pPeer();
    this.resetPathState();
    this.strictGate.clearGlobalQueue();
  }

  configureStrictP2pForConnection(
    appConnectionId: string,
    strictP2p: boolean,
    onForceClose: ForceCloseHandler | null = null,
  ): void {
    const route = this.routeStore.getOrCreate(appConnectionId);
    route.strictP2p = strictP2p;
    route.forceCloseHandler = onForceClose;
    route.forceClosed = false;
    route.pendingQueue = [];
    if (!strictP2p) {
      route.forceCloseHandler = null;
    }
  }

  clearStrictP2pForConnection(appConnectionId: string): void {
    const route = this.routeStore.get(appConnectionId);
    if (!route) {
      return;
    }
    route.strictP2p = false;
    route.forceCloseHandler = null;
    route.forceClosed = false;
    route.pendingQueue = [];
  }

  isStrictP2pForConnection(appConnectionId: string): boolean {
    return this.routeStore.get(appConnectionId)?.strictP2p === true;
  }

  send(
    envelope: MessageEnvelope,
    channel?: P2pChannelKind,
    options: SendOptions = {},
  ): void {
    if (this.closed) {
      throw new Error("AgentSessionTransport is closed");
    }
    const appConnectionId = getEnvelopeAppConnectionId(envelope);
    if (
      appConnectionId &&
      !options.strictBypass &&
      this.strictGate.shouldQueueAppSend(
        this.routeStore.get(appConnectionId),
        envelope,
      )
    ) {
      this.strictGate.queueAppSend(
        appConnectionId,
        this.routeStore.getOrCreate(appConnectionId),
        envelope,
        channel,
      );
      return;
    }
    if (appConnectionId) {
      const appRoute = this.routeStore.get(appConnectionId);
      if (appRoute?.outboundQueue) {
        appRoute.outboundQueue.push({ envelope, channel });
        return;
      }
      if (options.strictBypass && appRoute?.currentPath !== "p2p") {
        this.relayPath.send(envelope);
        return;
      }
    }
    if (
      this.strictGate.handleGlobalSend({
        strictP2p: this.strictP2p,
        currentPath: this.currentPath,
        forceClosed: this.forceClosed,
        envelope,
        channel,
      })
    ) {
      return;
    }
    if (this.outboundQueue) {
      this.outboundQueue.push({ envelope, channel });
      return;
    }
    this.dispatchSend(envelope, channel);
  }

  onMessage(handler: MessageHandler): () => void {
    return this.eventBus.onMessage(handler);
  }

  onPathChange(handler: PathChangeHandler): () => void {
    return this.eventBus.onPathChange(handler);
  }

  onEvent(handler: TransportEventHandler): () => void {
    return this.eventBus.onEvent(handler);
  }

  getCurrentPath(): TransportPath {
    return this.currentPath;
  }

  getBufferedAmountForApp(appConnectionId: string): number {
    const peer = this.peerRegistry.get(appConnectionId)?.peer;
    return peer?.getBufferedAmount("display") ?? 0;
  }

  emitDisplayFrameDeferred(
    appConnectionId: string,
    bufferedAmount: number,
  ): void {
    this.eventBus.emitEvent({
      type: "display_frame_deferred",
      app_connection_id: appConnectionId,
      buffered_amount: bufferedAmount,
    });
  }

  /**
   * 释放传输层所有资源。与 `forceClose` 正交：`close` 表示"上层主动结束 transport
   * 生命周期"（agentService 退出 / relay 重建），不会触发 forceCloseHandler；
   * `forceClose` 表示"strict 模式下 session 不可用"，会 emit force_close 并
   * 通知 forceCloseHandler 让 agentService 清理对应 mobile 的 session 状态。
   *
   * 若 close 时 strict pending queue 非空，先发出 `pending_drop(reason="session_close")`
   * 让上层日志可见。
   */
  close(_reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachP2pPeer();
    this.strictGate.dropGlobalQueue("session_close");
    this.eventBus.clear();
    this.outboundQueue = null;
  }

  attachP2pPeer(
    peer: WebRtcPeerAdapter,
    options: AttachP2pPeerOptions = {},
  ): void {
    const appConnectionId = options.appConnectionId;
    if (appConnectionId) {
      this.detachP2pPeer(appConnectionId);
    } else {
      this.detachP2pPeer();
    }
    if (!appConnectionId) {
      this.downgradeHandler = options.onDowngrade ?? null;
      this.upgradeId = options.upgradeId ?? null;
    }
    this.peerRegistry.attach(peer, options);
  }

  detachP2pPeer(appConnectionId?: string): void {
    if (appConnectionId) {
      const route = this.routeStore.get(appConnectionId);
      if (route) {
        this.healthMonitor.stopPingLoopForRoute(route);
        this.healthMonitor.stopBufferedSamplerForRoute(route);
        this.healthMonitor.clearIceDisconnectedTimerForRoute(route);
        route.currentPath = "relay";
        route.outboundQueue = null;
        route.switching = false;
      }
      const entry = this.peerRegistry.detach(appConnectionId);
      if (this.peerRegistry.getLegacyPeer() === null && entry) {
        this.downgradeHandler = null;
        this.upgradeId = null;
      }
      return;
    }
    this.healthMonitor.stopPingLoop();
    this.healthMonitor.stopBufferedSampler();
    this.healthMonitor.clearIceDisconnectedTimer();
    this.peerRegistry.detach();
    for (const route of this.routeStore.values()) {
      this.healthMonitor.stopPingLoopForRoute(route);
      this.healthMonitor.stopBufferedSamplerForRoute(route);
      this.healthMonitor.clearIceDisconnectedTimerForRoute(route);
    }
    this.routeStore.clear();
    this.downgradeHandler = null;
    this.upgradeId = null;
  }

  async switchPath(target: TransportPath): Promise<void> {
    if (this.closed || this.currentPath === target || this.switching) {
      return;
    }
    if (target === "p2p" && !this.peerRegistry.getLegacyPeer()) {
      console.warn("[omniwork-agent-transport] cannot switch to p2p: no peer");
      return;
    }
    if (this.strictP2p && target === "relay") {
      console.warn(
        "[omniwork-agent-transport] strict_p2p mode rejects switchPath('relay')",
      );
      return;
    }
    this.switching = true;
    this.outboundQueue = [];
    const previous = this.currentPath;
    try {
      await delay(DRAIN_DELAY_MS);
      this.currentPath = target;
      this.eventBus.emitPathChange(target);
      this.eventBus.emitEvent({
        type: "path_change",
        from: previous,
        to: target,
      });
      const queued = this.outboundQueue;
      this.outboundQueue = null;
      if (queued) {
        for (const item of queued) {
          this.dispatchSend(item.envelope, item.channel);
        }
      }
      if (target === "p2p") {
        this.healthMonitor.startPingLoop();
        this.healthMonitor.startBufferedSampler();
        this.strictGate.flushGlobalQueue();
      } else {
        this.healthMonitor.stopPingLoop();
        this.healthMonitor.stopBufferedSampler();
      }
    } finally {
      this.switching = false;
    }
  }

  async switchPathForConnection(
    appConnectionId: string,
    target: TransportPath,
  ): Promise<void> {
    const route = this.routeStore.getOrCreate(appConnectionId);
    if (this.closed || route.currentPath === target || route.switching) {
      return;
    }
    const appPeer = this.peerRegistry.get(appConnectionId);
    if (target === "p2p" && !appPeer) {
      console.warn(
        "[omniwork-agent-transport] cannot switch app to p2p: no peer",
        {
          app_connection_id: appConnectionId,
        },
      );
      return;
    }
    if (route.strictP2p && target === "relay") {
      console.warn(
        "[omniwork-agent-transport] strict_p2p route rejects switchPath('relay')",
        { app_connection_id: appConnectionId },
      );
      return;
    }
    route.switching = true;
    route.outboundQueue = [];
    const previous = route.currentPath;
    try {
      await delay(DRAIN_DELAY_MS);
      route.currentPath = target;
      this.eventBus.emitPathChange(target);
      this.eventBus.emitEvent({
        type: "path_change",
        from: previous,
        to: target,
      });
      const queued = route.outboundQueue;
      route.outboundQueue = null;
      if (queued) {
        for (const item of queued) {
          this.dispatchSend(item.envelope, item.channel);
        }
      }
      if (target === "p2p") {
        this.healthMonitor.startPingLoopForConnection(appConnectionId);
        this.healthMonitor.startBufferedSamplerForConnection(appConnectionId);
        this.strictGate.flushAppQueue(this.routeStore.get(appConnectionId));
      } else {
        this.healthMonitor.stopPingLoopForRoute(route);
        this.healthMonitor.stopBufferedSamplerForRoute(route);
      }
    } finally {
      route.switching = false;
    }
  }

  private dispatchSend(
    envelope: MessageEnvelope,
    channel?: P2pChannelKind,
  ): void {
    const appConnectionId = getEnvelopeAppConnectionId(envelope);
    const appRoute = appConnectionId
      ? this.routeStore.get(appConnectionId)
      : undefined;
    const appPeer = appConnectionId
      ? this.peerRegistry.get(appConnectionId)
      : undefined;
    if (appPeer && appRoute?.currentPath === "p2p") {
      appPeer.peer.send(
        JSON.stringify(envelope),
        channelForP2pEnvelope(envelope, channel),
      );
      return;
    }
    if (appConnectionId) {
      if (appRoute?.strictP2p) {
        this.eventBus.emitEvent({
          type: "strict_send_blocked",
          envelope_type: envelope.type,
        });
        this.forceCloseConnection(appConnectionId, "peer_missing");
        return;
      }
      this.relayPath.send(envelope);
      return;
    }
    const legacyPeer = this.peerRegistry.getLegacyPeer();
    if (this.currentPath === "p2p" && legacyPeer) {
      legacyPeer.send(
        JSON.stringify(envelope),
        channelForP2pEnvelope(envelope, channel),
      );
      return;
    }
    // strict 模式守门：currentPath 已经升到 p2p 但 peer 已被 detach（例如健康
    // 降级竞态、forceClose 后还没复位 currentPath）时，绝不允许 fallback 到
    // relay——这会让"业务消息只走 DataChannel"的契约破产。直接发出 force_close
    // 并丢弃当前消息，由上层重建 session。
    if (this.strictP2p && this.currentPath === "p2p" && !legacyPeer) {
      this.eventBus.emitEvent({
        type: "strict_send_blocked",
        envelope_type: envelope.type,
      });
      this.forceClose("peer_missing");
      return;
    }
    this.relayPath.send(envelope);
  }

  private dispatch(message: MessageEnvelope): void {
    if (this.closed) {
      return;
    }
    this.eventBus.emitMessage(message);
  }

  /**
   * strict 模式下"严格 P2P 不可用"的唯一统一入口。所有触发源都汇聚到这里：
   *
   * 1. coordinator 协商失败（peer_unavailable / timeout / handle_offer_failed
   *    等）→ agentService onForceClose → 调本方法
   * 2. transport 运行期健康降级（pong_timeout / buffered_overflow / ice_failed
   *    / ice_disconnected / peer_closed）→ handleHealthDowngrade 调本方法
   * 3. dispatchSend 检测到 strict + currentPath==='p2p' + peer===null 的脱钩
   *    状态 → 调本方法（reason="peer_missing"）
   *
   * 本方法负责完成所有清理 / 通知职责：
   * - 通过 downgradeHandler 让 coordinator 发出 `tunnel.upgrade.downgrade`
   *   给 Relay 用于 metrics + backoff（idempotent）
   * - emit `force_close` 事件 / detach peer / 完整 reset 路径状态
   * - strict pending queue 非空时 emit `pending_drop(reason="force_close")`
   * - 通知 forceCloseHandler 让 agentService 清理 mobile 关联会话
   *
   * 非 strict 模式调用本方法直接 no-op。多次调用幂等（forceClosed 标记）。
   */
  forceClose(reason: string): void {
    this.downgradeController.forceClose(reason);
  }

  forceCloseConnection(appConnectionId: string, reason: string): void {
    this.downgradeController.forceCloseConnection(appConnectionId, reason);
  }

  /**
   * 把 currentPath 切回 "relay" 并清掉切换/出站队列状态；用于 forceClose
   * 与 configureStrictP2p 后让 transport 状态机回归初始态。
   */
  private resetPathState(): void {
    this.outboundQueue = null;
    this.switching = false;
    if (this.currentPath !== "relay") {
      const previous = this.currentPath;
      this.currentPath = "relay";
      this.eventBus.emitPathChange("relay");
      this.eventBus.emitEvent({
        type: "path_change",
        from: previous,
        to: "relay",
      });
    }
  }

  isStrictP2p(): boolean {
    return this.strictP2p;
  }

  isForceClosed(): boolean {
    return this.forceClosed;
  }

  private handleHealthDowngrade(reason: string): void {
    this.downgradeController.handleHealthDowngrade(reason);
  }

  private handleHealthDowngradeForConnection(
    appConnectionId: string,
    reason: string,
  ): void {
    this.downgradeController.handleHealthDowngradeForConnection(
      appConnectionId,
      reason,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
