import {
  parseMessageEnvelope,
  type MessageEnvelope,
  type TransportPingPayload,
  type TransportPongPayload,
  type WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";
import type {
  AttachP2pPeerOptions,
  PeerRouteState,
} from "./types.ts";
import type { TransportRouteStore } from "./routeStore.ts";

interface P2pPeerRegistryOptions {
  routeStore: TransportRouteStore;
  dispatch(message: MessageEnvelope): void;
  handleIncomingPing(envelope: MessageEnvelope<TransportPingPayload>): void;
  handleIncomingPong(envelope: MessageEnvelope<TransportPongPayload>): void;
  handleIncomingPingForConnection(
    appConnectionId: string,
    envelope: MessageEnvelope<TransportPingPayload>,
  ): void;
  handleIncomingPongForConnection(
    appConnectionId: string,
    envelope: MessageEnvelope<TransportPongPayload>,
  ): void;
  handleHealthDowngrade(reason: string): void;
  handleHealthDowngradeForConnection(
    appConnectionId: string,
    reason: string,
  ): void;
  armIceDisconnectedTimer(): void;
  armIceDisconnectedTimerForConnection(appConnectionId: string): void;
  clearIceDisconnectedTimer(): void;
  clearIceDisconnectedTimerForConnection(appConnectionId: string): void;
  currentGlobalPath(): "relay" | "p2p";
}

export class P2pPeerRegistry {
  private readonly options: P2pPeerRegistryOptions;
  private legacyPeer: WebRtcPeerAdapter | null = null;
  private detachLegacyPeerListeners: (() => void) | null = null;
  private readonly peersByAppConnectionId = new Map<string, PeerRouteState>();

  constructor(options: P2pPeerRegistryOptions) {
    this.options = options;
  }

  getLegacyPeer(): WebRtcPeerAdapter | null {
    return this.legacyPeer;
  }

  get(appConnectionId: string): PeerRouteState | undefined {
    return this.peersByAppConnectionId.get(appConnectionId);
  }

  has(appConnectionId: string): boolean {
    return this.peersByAppConnectionId.has(appConnectionId);
  }

  values(): IterableIterator<PeerRouteState> {
    return this.peersByAppConnectionId.values();
  }

  attach(peer: WebRtcPeerAdapter, options: AttachP2pPeerOptions = {}): void {
    const appConnectionId = options.appConnectionId;
    if (!appConnectionId) {
      this.legacyPeer = peer;
    }

    const offMessage = peer.onDataMessage((data) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(data);
      } catch {
        decoded = null;
      }
      const envelope = parseMessageEnvelope(decoded);
      if (!envelope) {
        return;
      }
      if (envelope.type === "transport.ping") {
        if (appConnectionId) {
          this.options.handleIncomingPingForConnection(
            appConnectionId,
            envelope as MessageEnvelope<TransportPingPayload>,
          );
        } else {
          this.options.handleIncomingPing(
            envelope as MessageEnvelope<TransportPingPayload>,
          );
        }
        return;
      }
      if (envelope.type === "transport.pong") {
        if (appConnectionId) {
          this.options.handleIncomingPongForConnection(
            appConnectionId,
            envelope as MessageEnvelope<TransportPongPayload>,
          );
        } else {
          this.options.handleIncomingPong(
            envelope as MessageEnvelope<TransportPongPayload>,
          );
        }
        return;
      }
      this.options.dispatch(envelope);
    });

    const offState = peer.onStateChange((state) => {
      if (state === "failed") {
        if (appConnectionId) {
          this.options.handleHealthDowngradeForConnection(
            appConnectionId,
            "ice_failed",
          );
        } else {
          this.options.handleHealthDowngrade("ice_failed");
        }
        return;
      }
      if (state === "disconnected") {
        if (appConnectionId) {
          this.options.armIceDisconnectedTimerForConnection(appConnectionId);
        } else {
          this.options.armIceDisconnectedTimer();
        }
        return;
      }
      if (state === "connected") {
        if (appConnectionId) {
          this.options.clearIceDisconnectedTimerForConnection(appConnectionId);
        } else {
          this.options.clearIceDisconnectedTimer();
        }
        return;
      }
      if (state === "closed") {
        const currentPath = appConnectionId
          ? this.options.routeStore.get(appConnectionId)?.currentPath
          : this.options.currentGlobalPath();
        if (currentPath === "p2p") {
          if (appConnectionId) {
            this.options.handleHealthDowngradeForConnection(
              appConnectionId,
              "peer_closed",
            );
          } else {
            this.options.handleHealthDowngrade("peer_closed");
          }
        } else {
          this.detach(appConnectionId);
        }
      }
    });

    const detach = () => {
      offMessage();
      offState();
    };
    if (appConnectionId) {
      this.options.routeStore.getOrCreate(appConnectionId);
      this.peersByAppConnectionId.set(appConnectionId, {
        peer,
        detach,
        onDowngrade: options.onDowngrade ?? null,
        upgradeId: options.upgradeId ?? null,
      });
      return;
    }
    this.detachLegacyPeerListeners = detach;
  }

  detach(appConnectionId?: string): PeerRouteState | undefined {
    if (appConnectionId) {
      const entry = this.peersByAppConnectionId.get(appConnectionId);
      if (!entry) {
        return undefined;
      }
      entry.detach();
      closePeer(entry.peer);
      this.peersByAppConnectionId.delete(appConnectionId);
      if (this.legacyPeer === entry.peer) {
        this.legacyPeer = null;
        this.detachLegacyPeerListeners = null;
      }
      return entry;
    }

    if (this.detachLegacyPeerListeners) {
      this.detachLegacyPeerListeners();
      this.detachLegacyPeerListeners = null;
    }
    this.legacyPeer = null;
    for (const entry of this.peersByAppConnectionId.values()) {
      entry.detach();
      closePeer(entry.peer);
    }
    this.peersByAppConnectionId.clear();
    return undefined;
  }

  clear(): void {
    this.peersByAppConnectionId.clear();
    this.legacyPeer = null;
    this.detachLegacyPeerListeners = null;
  }
}

function closePeer(peer: WebRtcPeerAdapter): void {
  try {
    peer.close();
  } catch {
    /* ignore */
  }
}
