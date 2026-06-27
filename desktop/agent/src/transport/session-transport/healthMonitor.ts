import {
  createMessage,
  type MessageEnvelope,
  type TransportPath,
  type TransportPingPayload,
  type TransportPongPayload,
} from "@omniwork/protocol-ts";
import {
  BUFFERED_AMOUNT_LIMIT,
  BUFFERED_AMOUNT_OVERFLOW_SECONDS,
  BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS,
  ICE_DISCONNECTED_GRACE_MS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PING_TIMEOUT_THRESHOLD,
  PING_TIMER_STALL_GRACE_MS,
  STRICT_ICE_DISCONNECTED_GRACE_MS,
  STRICT_PING_INTERVAL_MS,
  STRICT_PING_TIMEOUT_MS,
  STRICT_PING_TIMEOUT_THRESHOLD,
  STRICT_PING_TIMER_STALL_GRACE_MS,
  type AppRouteState,
  type TransportEvent,
} from "./types.ts";
import type { P2pPeerRegistry } from "./p2pPeerRegistry.ts";
import type { TransportRouteStore } from "./routeStore.ts";

interface TransportHealthMonitorOptions {
  peerRegistry: P2pPeerRegistry;
  routeStore: TransportRouteStore;
  emitEvent(event: TransportEvent): void;
  globalStrictP2p(): boolean;
  globalCurrentPath(): TransportPath;
  globalUpgradeId(): string | null;
  handleHealthDowngrade(reason: string): void;
  handleHealthDowngradeForConnection(
    appConnectionId: string,
    reason: string,
  ): void;
}

export class TransportHealthMonitor {
  private readonly options: TransportHealthMonitorOptions;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  private readonly pendingPings = new Map<
    number,
    {
      sentAt: number;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private pongTimeoutCount = 0;
  private bufferedSampleTimer: ReturnType<typeof setInterval> | null = null;
  private bufferedOverflowSeconds = 0;
  private iceDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TransportHealthMonitorOptions) {
    this.options = options;
  }

  startPingLoop(): void {
    if (this.pingTimer || !this.options.peerRegistry.getLegacyPeer()) {
      return;
    }
    this.pongTimeoutCount = 0;
    const interval = this.options.globalStrictP2p()
      ? STRICT_PING_INTERVAL_MS
      : PING_INTERVAL_MS;
    const timer = setInterval(() => {
      this.sendPing();
    }, interval);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pingTimer = timer;
  }

  stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const entry of this.pendingPings.values()) {
      clearTimeout(entry.timeout);
    }
    this.pendingPings.clear();
    this.pongTimeoutCount = 0;
  }

  handleIncomingPing(
    envelope: MessageEnvelope<TransportPingPayload>,
  ): void {
    const peer = this.options.peerRegistry.getLegacyPeer();
    if (!peer || this.options.globalCurrentPath() !== "p2p") {
      return;
    }
    const reply = createMessage<TransportPongPayload>("transport.pong", {
      upgrade_id: envelope.payload.upgrade_id,
      seq: envelope.payload.seq,
      sent_at: envelope.payload.sent_at,
      received_at: new Date().toISOString(),
    });
    try {
      peer.send(JSON.stringify(reply), "control");
    } catch {
      /* ignore */
    }
  }

  handleIncomingPong(
    envelope: MessageEnvelope<TransportPongPayload>,
  ): void {
    const seq = envelope.payload.seq;
    const pending = this.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingPings.delete(seq);
    this.pongTimeoutCount = 0;
    const rtt = Date.now() - pending.sentAt;
    this.options.emitEvent({ type: "pong_received", seq, rtt_ms: rtt });
  }

  startPingLoopForConnection(appConnectionId: string): void {
    const route = this.options.routeStore.getOrCreate(appConnectionId);
    if (route.pingTimer || !this.options.peerRegistry.has(appConnectionId)) {
      return;
    }
    route.pongTimeoutCount = 0;
    const interval = route.strictP2p
      ? STRICT_PING_INTERVAL_MS
      : PING_INTERVAL_MS;
    const timer = setInterval(() => {
      this.sendPingForConnection(appConnectionId);
    }, interval);
    (timer as unknown as { unref?: () => void }).unref?.();
    route.pingTimer = timer;
  }

  stopPingLoopForRoute(route: AppRouteState): void {
    if (route.pingTimer) {
      clearInterval(route.pingTimer);
      route.pingTimer = null;
    }
    for (const entry of route.pendingPings.values()) {
      clearTimeout(entry.timeout);
    }
    route.pendingPings.clear();
    route.pongTimeoutCount = 0;
  }

  handleIncomingPingForConnection(
    appConnectionId: string,
    envelope: MessageEnvelope<TransportPingPayload>,
  ): void {
    const route = this.options.routeStore.get(appConnectionId);
    const peer = this.options.peerRegistry.get(appConnectionId);
    if (!route || !peer || route.currentPath !== "p2p") {
      return;
    }
    const reply = createMessage<TransportPongPayload>("transport.pong", {
      upgrade_id: envelope.payload.upgrade_id,
      seq: envelope.payload.seq,
      sent_at: envelope.payload.sent_at,
      received_at: new Date().toISOString(),
    });
    try {
      peer.peer.send(JSON.stringify(reply), "control");
    } catch {
      /* ignore */
    }
  }

  handleIncomingPongForConnection(
    appConnectionId: string,
    envelope: MessageEnvelope<TransportPongPayload>,
  ): void {
    const route = this.options.routeStore.get(appConnectionId);
    if (!route) {
      return;
    }
    const seq = envelope.payload.seq;
    const pending = route.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    route.pendingPings.delete(seq);
    route.pongTimeoutCount = 0;
    const rtt = Date.now() - pending.sentAt;
    this.options.emitEvent({ type: "pong_received", seq, rtt_ms: rtt });
  }

  startBufferedSampler(): void {
    if (
      this.bufferedSampleTimer ||
      !this.options.peerRegistry.getLegacyPeer()
    ) {
      return;
    }
    this.bufferedOverflowSeconds = 0;
    const timer = setInterval(() => {
      this.sampleBufferedAmount();
    }, BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.bufferedSampleTimer = timer;
  }

  stopBufferedSampler(): void {
    if (this.bufferedSampleTimer) {
      clearInterval(this.bufferedSampleTimer);
      this.bufferedSampleTimer = null;
    }
    this.bufferedOverflowSeconds = 0;
  }

  startBufferedSamplerForConnection(appConnectionId: string): void {
    const route = this.options.routeStore.getOrCreate(appConnectionId);
    if (
      route.bufferedSampleTimer ||
      !this.options.peerRegistry.has(appConnectionId)
    ) {
      return;
    }
    route.bufferedOverflowSeconds = 0;
    const timer = setInterval(() => {
      this.sampleBufferedAmountForConnection(appConnectionId);
    }, BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    route.bufferedSampleTimer = timer;
  }

  stopBufferedSamplerForRoute(route: AppRouteState): void {
    if (route.bufferedSampleTimer) {
      clearInterval(route.bufferedSampleTimer);
      route.bufferedSampleTimer = null;
    }
    route.bufferedOverflowSeconds = 0;
  }

  armIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      return;
    }
    const graceMs = this.options.globalStrictP2p()
      ? STRICT_ICE_DISCONNECTED_GRACE_MS
      : ICE_DISCONNECTED_GRACE_MS;
    const timer = setTimeout(() => {
      this.iceDisconnectedTimer = null;
      this.options.handleHealthDowngrade("ice_disconnected");
    }, graceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.iceDisconnectedTimer = timer;
  }

  clearIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      clearTimeout(this.iceDisconnectedTimer);
      this.iceDisconnectedTimer = null;
    }
  }

  armIceDisconnectedTimerForConnection(appConnectionId: string): void {
    const route = this.options.routeStore.getOrCreate(appConnectionId);
    if (route.iceDisconnectedTimer) {
      return;
    }
    const graceMs = route.strictP2p
      ? STRICT_ICE_DISCONNECTED_GRACE_MS
      : ICE_DISCONNECTED_GRACE_MS;
    const timer = setTimeout(() => {
      route.iceDisconnectedTimer = null;
      this.options.handleHealthDowngradeForConnection(
        appConnectionId,
        "ice_disconnected",
      );
    }, graceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    route.iceDisconnectedTimer = timer;
  }

  clearIceDisconnectedTimerForConnection(appConnectionId: string): void {
    const route = this.options.routeStore.get(appConnectionId);
    if (route) {
      this.clearIceDisconnectedTimerForRoute(route);
    }
  }

  clearIceDisconnectedTimerForRoute(route: AppRouteState): void {
    if (route.iceDisconnectedTimer) {
      clearTimeout(route.iceDisconnectedTimer);
      route.iceDisconnectedTimer = null;
    }
  }

  private sendPing(): void {
    const peer = this.options.peerRegistry.getLegacyPeer();
    if (!peer || this.options.globalCurrentPath() !== "p2p") {
      return;
    }
    const seq = ++this.pingSeq;
    const sentAt = Date.now();
    const envelope = createMessage<TransportPingPayload>("transport.ping", {
      upgrade_id: this.options.globalUpgradeId() ?? undefined,
      seq,
      sent_at: new Date(sentAt).toISOString(),
    });
    try {
      peer.send(JSON.stringify(envelope), "control");
    } catch {
      /* ignore: 下次 timeout 会触发降级 */
    }
    const timeoutMs = this.options.globalStrictP2p()
      ? STRICT_PING_TIMEOUT_MS
      : PING_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      this.handlePongTimeout(seq);
    }, timeoutMs);
    (timeout as unknown as { unref?: () => void }).unref?.();
    this.pendingPings.set(seq, { sentAt, timeout });
  }

  private handlePongTimeout(seq: number): void {
    const pending = this.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    this.pendingPings.delete(seq);
    const timeoutMs = this.options.globalStrictP2p()
      ? STRICT_PING_TIMEOUT_MS
      : PING_TIMEOUT_MS;
    const stallGraceMs = this.options.globalStrictP2p()
      ? STRICT_PING_TIMER_STALL_GRACE_MS
      : PING_TIMER_STALL_GRACE_MS;
    if (Date.now() - pending.sentAt > timeoutMs + stallGraceMs) {
      return;
    }
    this.pongTimeoutCount += 1;
    this.options.emitEvent({
      type: "ping_timeout",
      seq,
      count: this.pongTimeoutCount,
    });
    if (
      this.pongTimeoutCount >=
      (this.options.globalStrictP2p()
        ? STRICT_PING_TIMEOUT_THRESHOLD
        : PING_TIMEOUT_THRESHOLD)
    ) {
      this.options.handleHealthDowngrade("pong_timeout");
    }
  }

  private sendPingForConnection(appConnectionId: string): void {
    const route = this.options.routeStore.get(appConnectionId);
    const peer = this.options.peerRegistry.get(appConnectionId);
    if (!route || !peer || route.currentPath !== "p2p") {
      return;
    }
    const seq = ++route.pingSeq;
    const sentAt = Date.now();
    const envelope = createMessage<TransportPingPayload>("transport.ping", {
      upgrade_id: peer.upgradeId ?? undefined,
      seq,
      sent_at: new Date(sentAt).toISOString(),
    });
    try {
      peer.peer.send(JSON.stringify(envelope), "control");
    } catch {
      /* ignore: 下次 timeout 会触发降级 */
    }
    const timeoutMs = route.strictP2p
      ? STRICT_PING_TIMEOUT_MS
      : PING_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      this.handlePongTimeoutForConnection(appConnectionId, seq);
    }, timeoutMs);
    (timeout as unknown as { unref?: () => void }).unref?.();
    route.pendingPings.set(seq, { sentAt, timeout });
  }

  private handlePongTimeoutForConnection(
    appConnectionId: string,
    seq: number,
  ): void {
    const route = this.options.routeStore.get(appConnectionId);
    if (!route) {
      return;
    }
    const pending = route.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    route.pendingPings.delete(seq);
    const timeoutMs = route.strictP2p
      ? STRICT_PING_TIMEOUT_MS
      : PING_TIMEOUT_MS;
    const stallGraceMs = route.strictP2p
      ? STRICT_PING_TIMER_STALL_GRACE_MS
      : PING_TIMER_STALL_GRACE_MS;
    if (Date.now() - pending.sentAt > timeoutMs + stallGraceMs) {
      return;
    }
    route.pongTimeoutCount += 1;
    this.options.emitEvent({
      type: "ping_timeout",
      seq,
      count: route.pongTimeoutCount,
    });
    if (
      route.pongTimeoutCount >=
      (route.strictP2p ? STRICT_PING_TIMEOUT_THRESHOLD : PING_TIMEOUT_THRESHOLD)
    ) {
      this.options.handleHealthDowngradeForConnection(
        appConnectionId,
        "pong_timeout",
      );
    }
  }

  private sampleBufferedAmount(): void {
    const peer = this.options.peerRegistry.getLegacyPeer();
    if (!peer) {
      return;
    }
    const amount = peer.getBufferedAmount();
    if (amount > BUFFERED_AMOUNT_LIMIT) {
      this.bufferedOverflowSeconds += 1;
      if (this.bufferedOverflowSeconds >= BUFFERED_AMOUNT_OVERFLOW_SECONDS) {
        this.options.handleHealthDowngrade("buffered_overflow");
      }
    } else {
      this.bufferedOverflowSeconds = 0;
    }
  }

  private sampleBufferedAmountForConnection(appConnectionId: string): void {
    const route = this.options.routeStore.get(appConnectionId);
    const peer = this.options.peerRegistry.get(appConnectionId);
    if (!route || !peer) {
      return;
    }
    const amount = peer.peer.getBufferedAmount();
    if (amount > BUFFERED_AMOUNT_LIMIT) {
      route.bufferedOverflowSeconds += 1;
      if (route.bufferedOverflowSeconds >= BUFFERED_AMOUNT_OVERFLOW_SECONDS) {
        this.options.handleHealthDowngradeForConnection(
          appConnectionId,
          "buffered_overflow",
        );
      }
    } else {
      route.bufferedOverflowSeconds = 0;
    }
  }
}
