import type { AppRouteState } from "./types.ts";

export class TransportRouteStore {
  private readonly appRoutes = new Map<string, AppRouteState>();

  get(appConnectionId: string): AppRouteState | undefined {
    return this.appRoutes.get(appConnectionId);
  }

  getOrCreate(appConnectionId: string): AppRouteState {
    const existing = this.appRoutes.get(appConnectionId);
    if (existing) {
      return existing;
    }
    const route = createAppRouteState();
    this.appRoutes.set(appConnectionId, route);
    return route;
  }

  values(): IterableIterator<AppRouteState> {
    return this.appRoutes.values();
  }

  clear(): void {
    this.appRoutes.clear();
  }
}

export function createAppRouteState(): AppRouteState {
  return {
    currentPath: "relay",
    strictP2p: false,
    forceCloseHandler: null,
    forceClosed: false,
    pendingQueue: [],
    switching: false,
    outboundQueue: null,
    pingTimer: null,
    pingSeq: 0,
    pendingPings: new Map(),
    pongTimeoutCount: 0,
    bufferedSampleTimer: null,
    bufferedOverflowSeconds: 0,
    iceDisconnectedTimer: null,
  };
}
