import type {
  AppNetworkChangedPayload,
  MessageEnvelope,
  SessionTransport,
  TransportPath,
} from "@omniwork/protocol-ts";
import type { RelayCloseEvent } from "@omniwork/relay-client";

export type AppView =
  | "pairing"
  | "devices"
  | "settings"
  | "connectionPreference"
  | "sessions"
  | "terminal";

export type PrimaryTabView = "devices" | "settings";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "failed";

export type NetworkChangeDetails = {
  networkType?: string;
  isConnected?: boolean;
  isInternetReachable?: boolean;
};

export type AppSessionTransport = Omit<SessionTransport, "close"> & {
  connect(): Promise<void>;
  onClose(handler: (event: RelayCloseEvent) => void): () => void;
  close(reason?: string): void;
  getCurrentPath(): TransportPath;
  onPathChange(handler: (path: TransportPath) => void): () => void;
  forceDowngrade(reason: string): void;
  forceClose(reason: string): void;
  handleUpgradeMessage(message: MessageEnvelope): void;
  onBusinessReady(handler: () => void): () => void;
  pauseForBackground(): void;
  resumeForForeground(): void;
  requestP2pReconnect(
    reason: AppNetworkChangedPayload["reason"],
    details?: NetworkChangeDetails,
  ): void;
  isStrictP2p(): boolean;
};
