import type { MessageEnvelope, P2pChannelKind } from "@omniwork/protocol-ts";
import { isStrictControlMessage } from "./channelRouter.ts";
import {
  STRICT_PENDING_QUEUE_LIMIT,
  type AppRouteState,
  type QueuedSend,
  type TransportEvent,
} from "./types.ts";

interface StrictP2pGateOptions {
  emitEvent(event: TransportEvent): void;
  forceClose(reason: string): void;
  forceCloseConnection(appConnectionId: string, reason: string): void;
  dispatchSend(envelope: MessageEnvelope, channel?: P2pChannelKind): void;
}

export class StrictP2pGate {
  private readonly emitEvent: (event: TransportEvent) => void;
  private readonly forceClose: (reason: string) => void;
  private readonly forceCloseConnection: (
    appConnectionId: string,
    reason: string,
  ) => void;
  private readonly dispatchSend: (
    envelope: MessageEnvelope,
    channel?: P2pChannelKind,
  ) => void;
  private globalPendingQueue: QueuedSend[] = [];

  constructor(options: StrictP2pGateOptions) {
    this.emitEvent = options.emitEvent;
    this.forceClose = options.forceClose;
    this.forceCloseConnection = options.forceCloseConnection;
    this.dispatchSend = options.dispatchSend;
  }

  clearGlobalQueue(): void {
    this.globalPendingQueue = [];
  }

  dropGlobalQueue(reason: "session_close" | "force_close"): void {
    if (this.globalPendingQueue.length === 0) {
      return;
    }
    const dropped = this.globalPendingQueue.length;
    this.globalPendingQueue = [];
    this.emitEvent({
      type: "pending_drop",
      reason,
      count: dropped,
    });
  }

  handleGlobalSend(input: {
    strictP2p: boolean;
    currentPath: "relay" | "p2p";
    forceClosed: boolean;
    envelope: MessageEnvelope;
    channel?: P2pChannelKind;
  }): boolean {
    if (
      !input.strictP2p ||
      input.currentPath === "p2p" ||
      isStrictControlMessage(input.envelope.type)
    ) {
      return false;
    }
    if (input.forceClosed) {
      this.emitEvent({
        type: "strict_send_blocked",
        envelope_type: input.envelope.type,
      });
      return true;
    }
    if (this.globalPendingQueue.length >= STRICT_PENDING_QUEUE_LIMIT) {
      const dropped = this.globalPendingQueue.length;
      this.globalPendingQueue = [];
      this.emitEvent({
        type: "pending_drop",
        reason: "queue_overflow",
        count: dropped,
      });
      this.forceClose("strict_pending_overflow");
      return true;
    }
    this.globalPendingQueue.push({
      envelope: input.envelope,
      channel: input.channel,
    });
    return true;
  }

  flushGlobalQueue(): void {
    if (this.globalPendingQueue.length === 0) {
      return;
    }
    const pending = this.globalPendingQueue;
    this.globalPendingQueue = [];
    for (const item of pending) {
      this.dispatchSend(item.envelope, item.channel);
    }
  }

  shouldQueueAppSend(
    route: AppRouteState | undefined,
    envelope: MessageEnvelope,
  ): boolean {
    if (!route?.strictP2p || route.currentPath === "p2p") {
      return false;
    }
    return !isStrictControlMessage(envelope.type);
  }

  queueAppSend(
    appConnectionId: string,
    route: AppRouteState,
    envelope: MessageEnvelope,
    channel?: P2pChannelKind,
  ): void {
    if (route.forceClosed) {
      this.emitEvent({
        type: "strict_send_blocked",
        envelope_type: envelope.type,
      });
      return;
    }
    if (route.pendingQueue.length >= STRICT_PENDING_QUEUE_LIMIT) {
      const dropped = route.pendingQueue.length;
      route.pendingQueue = [];
      this.emitEvent({
        type: "pending_drop",
        reason: "queue_overflow",
        count: dropped,
      });
      this.forceCloseConnection(appConnectionId, "strict_pending_overflow");
      return;
    }
    route.pendingQueue.push({ envelope, channel });
  }

  flushAppQueue(route: AppRouteState | undefined): void {
    if (!route || route.pendingQueue.length === 0) {
      return;
    }
    const pending = route.pendingQueue;
    route.pendingQueue = [];
    for (const item of pending) {
      this.dispatchSend(item.envelope, item.channel);
    }
  }

  dropAppQueue(
    route: AppRouteState,
    reason: "session_close" | "force_close",
  ): void {
    if (route.pendingQueue.length === 0) {
      return;
    }
    const dropped = route.pendingQueue.length;
    route.pendingQueue = [];
    this.emitEvent({
      type: "pending_drop",
      reason,
      count: dropped,
    });
  }
}
