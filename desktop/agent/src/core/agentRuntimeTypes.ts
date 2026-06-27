import type { RelayCloseEvent } from "@omniwork/relay-client";
import type { RelayConnectionStatus } from "./relayReconnectPolicy.ts";

export interface AgentDispatchContext {
  appConnectionId: string;
  trustedE2E: boolean;
}

export interface AgentInfo {
  device_id: string;
  agent_instance_id: string;
  hostname: string;
  platform: "darwin";
  version: string;
  started_at: number;
  now: number;
}

export interface AgentRelayRuntimeStatus {
  status: RelayConnectionStatus;
  reconnectAttempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  lastClose: RelayCloseEvent | null;
}
