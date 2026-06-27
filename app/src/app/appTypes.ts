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
  | "messages"
  | "settings"
  | "securitySettings"
  | "connectionPreference"
  | "workbench"
  | "gitReview"
  | "terminalFiles"
  | "fileEditor"
  | "terminal";

export type PrimaryTabView = "devices" | "messages" | "settings";

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
  getAppConnectionId(): string | null;
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
