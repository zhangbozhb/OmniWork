import type {
  AppInfoPayload,
  BusinessSecurityMode,
  E2ESupport,
  MessageEnvelope,
  TransportPreference,
} from "@omniwork/protocol-ts";

export type RelayRole = "unknown" | "agent" | "mobile";
export type RelayEndpoint = "agent" | "mobile";
export type RelayConnectionState =
  | "socket_connected"
  | "registered_agent"
  | "mobile_connected"
  | "relay_pairing_verified"
  | "e2e_handshaking"
  | "e2e_ready"
  | "closed";

export interface RelaySocket {
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: () => void): () => void;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayConnectionBase {
  id: string;
  endpoint: RelayEndpoint;
  role: RelayRole;
  state: RelayConnectionState;
  socket: RelaySocket;
  deviceId?: string;
  agentInstanceId?: string;
  keyId?: string;
  appInfo?: RelayAppInfo;
  businessSecurityMode?: BusinessSecurityMode;
  e2e?: E2ESupport;
  authenticated: boolean;
  /** Remote address used as the secondary key for auth.proof rate limiting. */
  remoteIp: string;
  connectedAt: number;
  lastSeenAt: number;
  authState: "none" | "pending" | "verified" | "failed";
  transportPath: "relay" | "p2p" | "mixed" | "unknown";
  /**
   * App 在 mobile.connect 中显式声明的传输偏好，由 orchestrator 在 propose
   * 守门时读取；缺省视为 "auto"。
   */
  transportPreference?: TransportPreference;
  e2eHandshakeId?: string;
  e2eTranscriptHash?: string;
  e2eSessionId?: string;
  agentE2EPeers?: Map<string, AgentE2EPeerState>;
}

export interface UnboundRelayConnection extends RelayConnectionBase {
  role: "unknown";
  state: "socket_connected" | "closed";
}

export interface RegisteredAgentRelayConnection extends RelayConnectionBase {
  endpoint: "agent";
  role: "agent";
  state: "registered_agent" | "closed";
  deviceId: string;
  agentInstanceId: string;
  keyId: string;
  businessSecurityMode: BusinessSecurityMode;
  e2e: E2ESupport;
  authenticated: true;
  authState: "verified";
  agentE2EPeers?: Map<string, AgentE2EPeerState>;
}

export interface MobileRelayConnection extends RelayConnectionBase {
  endpoint: "mobile";
  role: "mobile";
  state:
    | "mobile_connected"
    | "relay_pairing_verified"
    | "e2e_handshaking"
    | "e2e_ready"
    | "closed";
  deviceId?: string;
  keyId?: string;
  appInfo?: RelayAppInfo;
  transportPreference?: TransportPreference;
}

export interface AuthenticatedMobileRelayConnection extends MobileRelayConnection {
  state: "relay_pairing_verified" | "e2e_handshaking" | "e2e_ready";
  deviceId: string;
  keyId: string;
  appInfo: RelayAppInfo;
  authenticated: true;
  authState: "verified";
}

export type RelayConnection =
  | UnboundRelayConnection
  | RegisteredAgentRelayConnection
  | MobileRelayConnection;

export type RelayRoutedAppMessage<TPayload = unknown> =
  MessageEnvelope<TPayload> & {
    device_id: string;
    app_connection_id: string;
    relay_context_id: string;
  };

export interface AgentE2EPeerState {
  handshakeId: string;
  transcriptHash?: string;
  e2eSessionId?: string;
  state: "handshaking" | "ready";
}

export interface RelayAppInfo {
  instanceId: AppInfoPayload["instance_id"];
  runtimeId: AppInfoPayload["runtime_id"];
  name?: string;
  deviceName?: string;
  platform?: AppInfoPayload["platform"];
  version?: string;
  capabilities?: string[];
}

export interface PendingAuth {
  deviceId: string;
  nonce: string;
  keyId: string;
  appInfo: RelayAppInfo;
}

export interface ControlRule {
  id: string;
  reason?: string;
  createdAt: number;
  expiresAt?: number;
}
