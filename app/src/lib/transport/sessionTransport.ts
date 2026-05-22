import {
  createMessage,
  type MessageEnvelope,
  type SessionTransport,
  type TransportPath,
  type TransportPingPayload,
  type TransportPongPayload,
  type WebRtcPeerAdapter,
} from "../../../../packages/protocol-ts/src/index";
import type { RelayCloseEvent } from "../../../../packages/relay-client/src/index";
import type { MobileRelayPath } from "./relayPath";

type MessageHandler = (envelope: MessageEnvelope) => void;
type PathChangeHandler = (path: TransportPath) => void;
type DowngradeReasonHandler = (reason: string) => void;
type TransportEvent =
  | { type: "path_change"; from: TransportPath; to: TransportPath }
  | { type: "ping_timeout"; seq: number; count: number }
  | { type: "pong_received"; seq: number; rtt_ms: number }
  | { type: "downgrade"; reason: string };
type TransportEventHandler = (event: TransportEvent) => void;

const DRAIN_DELAY_MS = 100;
const PING_INTERVAL_MS = 5_000;
const PING_TIMEOUT_MS = 1_000;
const PING_TIMEOUT_THRESHOLD = 3;
const BUFFERED_AMOUNT_LIMIT = 1_000_000;
const BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS = 1_000;
const BUFFERED_AMOUNT_OVERFLOW_SECONDS = 5;
const ICE_DISCONNECTED_GRACE_MS = 3_000;

export interface AttachP2pPeerOptions {
  /** 由 UpgradeCoordinator.downgrade 提供的降级回调；transport 检测到健康异常时调用。 */
  onDowngrade?: DowngradeReasonHandler;
  upgradeId?: string;
}

export class MobileSessionTransport implements SessionTransport {
  private readonly relayPath: MobileRelayPath;
  private currentPath: TransportPath = "relay";
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly pathChangeHandlers = new Set<PathChangeHandler>();
  private readonly eventHandlers = new Set<TransportEventHandler>();
  private closed = false;
  private peer: WebRtcPeerAdapter | null = null;
  private detachPeerListeners: (() => void) | null = null;
  private outboundQueue: MessageEnvelope[] | null = null;
  private switching = false;
  private downgradeHandler: DowngradeReasonHandler | null = null;
  private upgradeId: string | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  private pendingPings = new Map<
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

  constructor(relayPath: MobileRelayPath) {
    this.relayPath = relayPath;
    this.relayPath.onMessage((message) => this.dispatch(message));
  }

  send(envelope: MessageEnvelope): void {
    if (this.closed) {
      throw new Error("MobileSessionTransport is closed");
    }
    if (this.outboundQueue) {
      this.outboundQueue.push(envelope);
      return;
    }
    this.dispatchSend(envelope);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onPathChange(handler: PathChangeHandler): () => void {
    this.pathChangeHandlers.add(handler);
    return () => {
      this.pathChangeHandlers.delete(handler);
    };
  }

  onEvent(handler: TransportEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  getCurrentPath(): TransportPath {
    return this.currentPath;
  }

  close(_reason: string): void {
    this.closed = true;
    this.detachP2pPeer();
    this.messageHandlers.clear();
    this.pathChangeHandlers.clear();
    this.eventHandlers.clear();
    this.outboundQueue = null;
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    return this.relayPath.onClose(handler);
  }

  attachP2pPeer(
    peer: WebRtcPeerAdapter,
    options: AttachP2pPeerOptions = {},
  ): void {
    this.detachP2pPeer();
    this.peer = peer;
    this.downgradeHandler = options.onDowngrade ?? null;
    this.upgradeId = options.upgradeId ?? null;

    const offMessage = peer.onDataMessage((data) => {
      let envelope: MessageEnvelope | null = null;
      try {
        envelope = JSON.parse(data) as MessageEnvelope;
      } catch {
        envelope = null;
      }
      if (!envelope) {
        return;
      }
      if (envelope.type === "transport.ping") {
        this.handleIncomingPing(
          envelope as MessageEnvelope<TransportPingPayload>,
        );
        return;
      }
      if (envelope.type === "transport.pong") {
        this.handleIncomingPong(
          envelope as MessageEnvelope<TransportPongPayload>,
        );
        return;
      }
      this.dispatch(envelope);
    });
    const offState = peer.onStateChange((state) => {
      if (state === "failed") {
        this.handleHealthDowngrade("ice_failed");
        return;
      }
      if (state === "disconnected") {
        this.armIceDisconnectedTimer();
        return;
      }
      if (state === "connected") {
        this.clearIceDisconnectedTimer();
        return;
      }
      if (state === "closed") {
        if (this.currentPath === "p2p") {
          this.handleHealthDowngrade("peer_closed");
        } else {
          this.detachP2pPeer();
        }
      }
    });
    this.detachPeerListeners = () => {
      offMessage();
      offState();
    };
  }

  detachP2pPeer(): void {
    this.stopPingLoop();
    this.stopBufferedSampler();
    this.clearIceDisconnectedTimer();
    if (this.detachPeerListeners) {
      this.detachPeerListeners();
      this.detachPeerListeners = null;
    }
    this.peer = null;
    this.downgradeHandler = null;
    this.upgradeId = null;
  }

  /**
   * 由外部（例如 AppState background）调用，主动触发降级；
   * 等价于内部健康检查触发的 downgrade，确保事件统计与 onDowngrade 调用路径一致。
   */
  forceDowngrade(reason: string): void {
    this.handleHealthDowngrade(reason);
  }

  async switchPath(target: TransportPath): Promise<void> {
    if (this.closed || this.currentPath === target || this.switching) {
      return;
    }
    if (target === "p2p" && !this.peer) {
      console.warn("[omniwork-mobile-transport] cannot switch to p2p: no peer");
      return;
    }
    this.switching = true;
    this.outboundQueue = [];
    const previous = this.currentPath;
    try {
      await delay(DRAIN_DELAY_MS);
      this.currentPath = target;
      for (const handler of this.pathChangeHandlers) {
        handler(target);
      }
      this.emitEvent({ type: "path_change", from: previous, to: target });
      const queued = this.outboundQueue;
      this.outboundQueue = null;
      if (queued) {
        for (const envelope of queued) {
          this.dispatchSend(envelope);
        }
      }
      if (target === "p2p") {
        this.startPingLoop();
        this.startBufferedSampler();
      } else {
        this.stopPingLoop();
        this.stopBufferedSampler();
      }
    } finally {
      this.switching = false;
    }
  }

  private dispatchSend(envelope: MessageEnvelope): void {
    if (this.currentPath === "p2p" && this.peer) {
      this.peer.send(JSON.stringify(envelope));
      return;
    }
    this.relayPath.send(envelope);
  }

  private dispatch(message: MessageEnvelope): void {
    if (this.closed) {
      return;
    }
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  // ---- ping/pong ----

  private startPingLoop(): void {
    if (this.pingTimer || !this.peer) {
      return;
    }
    this.pongTimeoutCount = 0;
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
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

  private sendPing(): void {
    if (!this.peer || this.currentPath !== "p2p") {
      return;
    }
    const seq = ++this.pingSeq;
    const sentAt = Date.now();
    const envelope = createMessage<TransportPingPayload>("transport.ping", {
      upgrade_id: this.upgradeId ?? undefined,
      seq,
      sent_at: new Date(sentAt).toISOString(),
    });
    try {
      this.peer.send(JSON.stringify(envelope));
    } catch {
      /* ignore */
    }
    const timeout = setTimeout(() => {
      this.handlePongTimeout(seq);
    }, PING_TIMEOUT_MS);
    this.pendingPings.set(seq, { sentAt, timeout });
  }

  private handleIncomingPing(
    envelope: MessageEnvelope<TransportPingPayload>,
  ): void {
    if (!this.peer || this.currentPath !== "p2p") {
      return;
    }
    const reply = createMessage<TransportPongPayload>("transport.pong", {
      upgrade_id: envelope.payload.upgrade_id,
      seq: envelope.payload.seq,
      sent_at: envelope.payload.sent_at,
      received_at: new Date().toISOString(),
    });
    try {
      this.peer.send(JSON.stringify(reply));
    } catch {
      /* ignore */
    }
  }

  private handleIncomingPong(
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
    this.emitEvent({ type: "pong_received", seq, rtt_ms: rtt });
  }

  private handlePongTimeout(seq: number): void {
    const pending = this.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    this.pendingPings.delete(seq);
    this.pongTimeoutCount += 1;
    this.emitEvent({
      type: "ping_timeout",
      seq,
      count: this.pongTimeoutCount,
    });
    if (this.pongTimeoutCount >= PING_TIMEOUT_THRESHOLD) {
      this.handleHealthDowngrade("pong_timeout");
    }
  }

  // ---- bufferedAmount sampler ----

  private startBufferedSampler(): void {
    if (this.bufferedSampleTimer || !this.peer) {
      return;
    }
    this.bufferedOverflowSeconds = 0;
    this.bufferedSampleTimer = setInterval(() => {
      this.sampleBufferedAmount();
    }, BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS);
  }

  private stopBufferedSampler(): void {
    if (this.bufferedSampleTimer) {
      clearInterval(this.bufferedSampleTimer);
      this.bufferedSampleTimer = null;
    }
    this.bufferedOverflowSeconds = 0;
  }

  private sampleBufferedAmount(): void {
    if (!this.peer) {
      return;
    }
    const amount = this.peer.getBufferedAmount();
    if (amount > BUFFERED_AMOUNT_LIMIT) {
      this.bufferedOverflowSeconds += 1;
      if (this.bufferedOverflowSeconds >= BUFFERED_AMOUNT_OVERFLOW_SECONDS) {
        this.handleHealthDowngrade("buffered_overflow");
      }
    } else {
      this.bufferedOverflowSeconds = 0;
    }
  }

  // ---- ICE disconnected grace ----

  private armIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      return;
    }
    this.iceDisconnectedTimer = setTimeout(() => {
      this.iceDisconnectedTimer = null;
      this.handleHealthDowngrade("ice_disconnected");
    }, ICE_DISCONNECTED_GRACE_MS);
  }

  private clearIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      clearTimeout(this.iceDisconnectedTimer);
      this.iceDisconnectedTimer = null;
    }
  }

  private handleHealthDowngrade(reason: string): void {
    if (this.currentPath !== "p2p") {
      return;
    }
    const handler = this.downgradeHandler;
    this.emitEvent({ type: "downgrade", reason });
    void this.switchPath("relay");
    this.detachP2pPeer();
    if (handler) {
      try {
        handler(reason);
      } catch (error) {
        console.warn("[omniwork-mobile-transport] downgrade handler failed", {
          error: (error as Error)?.message,
        });
      }
    }
  }

  private emitEvent(event: TransportEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        /* ignore */
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
