import type { TransportPath } from "@omniwork/protocol-ts";
import type { TransportRouteStore } from "./routeStore.ts";
import type { P2pPeerRegistry } from "./p2pPeerRegistry.ts";
import type { StrictP2pGate } from "./strictP2pGate.ts";
import type {
  DowngradeReasonHandler,
  ForceCloseHandler,
  TransportEvent,
} from "./types.ts";

interface TransportDowngradeControllerOptions {
  routeStore: TransportRouteStore;
  peerRegistry: P2pPeerRegistry;
  strictGate: StrictP2pGate;
  emitEvent(event: TransportEvent): void;
  currentPath(): TransportPath;
  strictP2p(): boolean;
  forceClosed(): boolean;
  setForceClosed(forceClosed: boolean): void;
  globalDowngradeHandler(): DowngradeReasonHandler | null;
  globalForceCloseHandler(): ForceCloseHandler | null;
  clearGlobalStrictState(): void;
  detachP2pPeer(appConnectionId?: string): void;
  resetPathState(): void;
  switchPath(target: TransportPath): Promise<void>;
  switchPathForConnection(
    appConnectionId: string,
    target: TransportPath,
  ): Promise<void>;
}

export class TransportDowngradeController {
  private readonly options: TransportDowngradeControllerOptions;

  constructor(options: TransportDowngradeControllerOptions) {
    this.options = options;
  }

  forceClose(reason: string): void {
    if (!this.options.strictP2p() || this.options.forceClosed()) {
      return;
    }
    this.options.setForceClosed(true);
    const downgradeHandler = this.options.globalDowngradeHandler();
    const forceCloseHandler = this.options.globalForceCloseHandler();
    this.options.emitEvent({ type: "force_close", reason });
    this.options.detachP2pPeer();
    this.options.resetPathState();
    this.options.strictGate.dropGlobalQueue("force_close");
    this.options.clearGlobalStrictState();
    callDowngradeHandler(
      downgradeHandler,
      reason,
      "[omniwork-agent-transport] forceClose downgrade handler failed",
    );
    callForceCloseHandler(
      forceCloseHandler,
      reason,
      "[omniwork-agent-transport] forceClose handler failed",
    );
  }

  forceCloseConnection(appConnectionId: string, reason: string): void {
    const route = this.options.routeStore.get(appConnectionId);
    if (!route?.strictP2p || route.forceClosed) {
      return;
    }
    route.forceClosed = true;
    const peer = this.options.peerRegistry.get(appConnectionId);
    const downgradeHandler = peer?.onDowngrade ?? null;
    const forceCloseHandler = route.forceCloseHandler;
    this.options.emitEvent({ type: "force_close", reason });
    this.options.detachP2pPeer(appConnectionId);
    const current = this.options.routeStore.getOrCreate(appConnectionId);
    current.strictP2p = false;
    current.forceCloseHandler = null;
    current.forceClosed = false;
    this.options.strictGate.dropAppQueue(route, "force_close");
    callDowngradeHandler(
      downgradeHandler,
      reason,
      "[omniwork-agent-transport] route forceClose downgrade handler failed",
      { app_connection_id: appConnectionId },
    );
    callForceCloseHandler(
      forceCloseHandler,
      reason,
      "[omniwork-agent-transport] route forceClose handler failed",
      { app_connection_id: appConnectionId },
    );
  }

  handleHealthDowngrade(reason: string): void {
    if (this.options.currentPath() !== "p2p") {
      return;
    }
    this.options.emitEvent({ type: "downgrade", reason });
    if (this.options.strictP2p()) {
      this.forceClose(reason);
      return;
    }
    const handler = this.options.globalDowngradeHandler();
    void this.options.switchPath("relay");
    this.options.detachP2pPeer();
    callDowngradeHandler(
      handler,
      reason,
      "[omniwork-agent-transport] downgrade handler failed",
    );
  }

  handleHealthDowngradeForConnection(
    appConnectionId: string,
    reason: string,
  ): void {
    const route = this.options.routeStore.get(appConnectionId);
    if (route?.currentPath !== "p2p") {
      return;
    }
    this.options.emitEvent({ type: "downgrade", reason });
    if (route.strictP2p) {
      this.forceCloseConnection(appConnectionId, reason);
      return;
    }
    const handler =
      this.options.peerRegistry.get(appConnectionId)?.onDowngrade ?? null;
    void this.options.switchPathForConnection(appConnectionId, "relay");
    this.options.detachP2pPeer(appConnectionId);
    callDowngradeHandler(
      handler,
      reason,
      "[omniwork-agent-transport] route downgrade handler failed",
      { app_connection_id: appConnectionId },
    );
  }
}

function callDowngradeHandler(
  handler: DowngradeReasonHandler | null,
  reason: string,
  warning: string,
  extra: Record<string, unknown> = {},
): void {
  if (!handler) {
    return;
  }
  try {
    handler(reason);
  } catch (error) {
    console.warn(warning, {
      ...extra,
      error: (error as Error)?.message,
    });
  }
}

function callForceCloseHandler(
  handler: ForceCloseHandler | null,
  reason: string,
  warning: string,
  extra: Record<string, unknown> = {},
): void {
  if (!handler) {
    return;
  }
  try {
    handler(reason);
  } catch (error) {
    console.warn(warning, {
      ...extra,
      error: (error as Error)?.message,
    });
  }
}
