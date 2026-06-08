import { randomUUID } from "node:crypto";

import type {
  AppInfoPayload,
  AppConnectionHeartbeatPayload,
  AppConnectionGoodbyePayload,
} from "@omniwork/protocol-ts";

export type ConnectionState = "active" | "idle" | "stale" | "disconnected";
export type SecurityMode = "e2e" | "plaintext" | "unauthenticated";
export type ConnectionMethod = "relay" | "p2p" | "mixed" | "unknown";
export type TransportPathWithUnknown = "relay" | "p2p" | "unknown";
export type IpSource =
  | "p2p_observed"
  | "relay_forwarded"
  | "app_reported"
  | "unknown";

export interface AppConnectionRegistryOptions {
  heartbeatIntervalMs: number;
  staleTimeoutMs: number;
  disconnectTimeoutMs: number;
}

export interface AuthenticatedConnectionOptions {
  relayConnectionId: string;
  keyId: string;
  appInfo: AppInfoPayload;
  now?: number;
}

export interface AgentObservedAppConnection {
  connection_id: string;
  relay_connection_id?: string;
  app_instance_id: string;
  app_runtime_id: string;
  app_name?: string;
  app_device_name?: string;
  app_platform?: "ios" | "android" | "web" | "desktop";
  app_version?: string;
  client_info_available: boolean;
  state: ConnectionState;
  trusted: boolean;
  security: {
    encrypted: boolean;
    mode: SecurityMode;
    key_id?: string;
    e2e_ready: boolean;
    handshake_at?: number;
    last_verified_at?: number;
  };
  network: {
    ip?: string;
    ip_source: IpSource;
    user_agent?: string;
    connection_method: ConnectionMethod;
    relay_connection_id?: string;
  };
  timing: {
    connected_at: number;
    authenticated_at?: number;
    first_seen_at: number;
    last_seen_at: number;
    last_heartbeat_at?: number;
    last_message_at?: number;
    stale_after: number;
    disconnect_after: number;
  };
  transport: {
    current_path: TransportPathWithUnknown;
    available_paths: Array<"relay" | "p2p">;
    p2p_state?:
      | "new"
      | "connecting"
      | "connected"
      | "disconnected"
      | "failed"
      | "closed";
    relay_state?: "available" | "unavailable" | "unknown";
    last_path_change_at?: number;
  };
  counters: {
    messages_in: number;
    messages_out: number;
    heartbeats: number;
    replay_rejected: number;
    auth_failures: number;
  };
  last_seq: number;
}

export interface ConnectionSummary {
  total: number;
  trusted: number;
  untrusted: number;
  active: number;
  idle: number;
  stale: number;
  disconnected: number;
  encrypted: number;
  plaintext: number;
  p2p: number;
  relay: number;
  unknown_path: number;
}

export class AppConnectionRegistry {
  private readonly options: AppConnectionRegistryOptions;
  private readonly byConnectionId = new Map<string, AgentObservedAppConnection>();
  private readonly byRuntimeKey = new Map<string, string>();

  constructor(options: AppConnectionRegistryOptions) {
    this.options = options;
  }

  acceptAuthenticatedConnection(
    options: AuthenticatedConnectionOptions,
  ): AgentObservedAppConnection {
    const now = options.now ?? Date.now();
    const runtimeKey = this.runtimeKey(options.appInfo);
    const existing =
      this.findByRelayConnectionId(options.relayConnectionId) ??
      this.findByRuntimeKey(runtimeKey);
    const connection =
      existing ??
      this.createBaseConnection({
        appInfo: options.appInfo,
        relayConnectionId: options.relayConnectionId,
        keyId: options.keyId,
        now,
      });

    connection.state = "active";
    connection.trusted = true;
    connection.relay_connection_id = options.relayConnectionId;
    connection.app_instance_id = options.appInfo.instance_id;
    connection.app_runtime_id = options.appInfo.runtime_id;
    connection.app_name = options.appInfo.name ?? connection.app_name;
    connection.app_device_name =
      options.appInfo.device_name ?? connection.app_device_name;
    connection.app_platform = options.appInfo.platform ?? connection.app_platform;
    connection.app_version = options.appInfo.version ?? connection.app_version;
    connection.client_info_available = true;
    connection.security.key_id = options.keyId;
    connection.security.last_verified_at = now;
    connection.network.relay_connection_id = options.relayConnectionId;
    connection.timing.authenticated_at = connection.timing.authenticated_at ?? now;
    connection.timing.last_seen_at = now;
    connection.timing.stale_after = now + this.options.staleTimeoutMs;
    connection.timing.disconnect_after = now + this.options.disconnectTimeoutMs;
    connection.transport.relay_state = "available";
    this.byRuntimeKey.set(runtimeKey, connection.connection_id);
    this.byConnectionId.set(connection.connection_id, connection);
    return this.clone(connection);
  }

  acceptHeartbeat(
    relayConnectionId: string | undefined,
    payload: AppConnectionHeartbeatPayload,
  ): void {
    const connection = this.findByRelayConnectionId(relayConnectionId);
    if (!connection) {
      return;
    }
    const now = Date.now();
    connection.state = "active";
    connection.timing.last_heartbeat_at = now;
    connection.timing.last_seen_at = now;
    connection.timing.stale_after = now + this.options.staleTimeoutMs;
    connection.timing.disconnect_after = now + this.options.disconnectTimeoutMs;
    connection.counters.heartbeats += 1;
    connection.last_seq = payload.seq;
    if (payload.current_path) {
      this.setPath(connection.connection_id, payload.current_path);
    }
  }

  markGoodbye(
    relayConnectionId: string | undefined,
    payload: AppConnectionGoodbyePayload,
  ): void {
    const connection = this.findByRelayConnectionId(relayConnectionId);
    if (!connection) {
      return;
    }
    connection.state = "disconnected";
    connection.timing.last_seen_at = Date.now();
    connection.last_seq = payload.seq;
  }

  recordMessage(
    relayConnectionId: string | undefined,
    direction: "in" | "out",
    encrypted: boolean,
  ): void {
    const connection = this.findByRelayConnectionId(relayConnectionId);
    if (!connection) {
      return;
    }
    const now = Date.now();
    connection.timing.last_message_at = now;
    connection.timing.last_seen_at = now;
    connection.timing.stale_after = now + this.options.staleTimeoutMs;
    connection.timing.disconnect_after = now + this.options.disconnectTimeoutMs;
    if (connection.state !== "disconnected") {
      connection.state = "active";
    }
    if (direction === "in") {
      connection.counters.messages_in += 1;
    } else {
      connection.counters.messages_out += 1;
    }
    if (encrypted && connection.security.mode !== "e2e") {
      this.markE2EReady(relayConnectionId, now);
    }
  }

  markE2EReady(relayConnectionId: string | undefined, now = Date.now()): void {
    const connection = this.findByRelayConnectionId(relayConnectionId);
    if (!connection) {
      return;
    }
    connection.security.encrypted = true;
    connection.security.mode = "e2e";
    connection.security.e2e_ready = true;
    connection.security.handshake_at = connection.security.handshake_at ?? now;
    connection.security.last_verified_at = now;
    connection.timing.last_seen_at = now;
    connection.timing.stale_after = now + this.options.staleTimeoutMs;
    connection.timing.disconnect_after = now + this.options.disconnectTimeoutMs;
  }

  hasAuthenticatedConnection(relayConnectionId: string | undefined): boolean {
    const connection = this.findByRelayConnectionId(relayConnectionId);
    return connection?.trusted === true;
  }

  recordReplayRejected(connectionId: string | undefined): void {
    const connection = connectionId
      ? this.byConnectionId.get(connectionId)
      : undefined;
    if (connection) {
      connection.counters.replay_rejected += 1;
    }
  }

  recordAuthFailure(relayConnectionId: string | undefined): void {
    const connection = this.findByRelayConnectionId(relayConnectionId);
    if (connection) {
      connection.counters.auth_failures += 1;
    }
  }

  setPath(connectionIdOrRelayId: string, path: TransportPathWithUnknown): void {
    const connection =
      this.byConnectionId.get(connectionIdOrRelayId) ??
      this.findByRelayConnectionId(connectionIdOrRelayId);
    if (!connection) {
      return;
    }
    const now = Date.now();
    connection.transport.current_path = path;
    connection.network.connection_method = path === "unknown" ? "unknown" : path;
    connection.transport.last_path_change_at = now;
    if (path === "p2p" && !connection.transport.available_paths.includes("p2p")) {
      connection.transport.available_paths.push("p2p");
    }
    if (path === "p2p") {
      connection.transport.p2p_state = "connected";
    }
  }

  sweep(now = Date.now()): void {
    for (const connection of this.byConnectionId.values()) {
      if (connection.state === "disconnected") {
        continue;
      }
      if (now >= connection.timing.disconnect_after) {
        connection.state = "disconnected";
      } else if (now >= connection.timing.stale_after) {
        connection.state = "stale";
      } else if (
        connection.timing.last_message_at &&
        now - connection.timing.last_message_at > this.options.heartbeatIntervalMs
      ) {
        connection.state = "idle";
      }
    }
  }

  list(): AgentObservedAppConnection[] {
    this.sweep();
    return [...this.byConnectionId.values()].map((connection) =>
      this.clone(connection),
    );
  }

  summary(): ConnectionSummary {
    const summary: ConnectionSummary = {
      total: 0,
      trusted: 0,
      untrusted: 0,
      active: 0,
      idle: 0,
      stale: 0,
      disconnected: 0,
      encrypted: 0,
      plaintext: 0,
      p2p: 0,
      relay: 0,
      unknown_path: 0,
    };
    for (const connection of this.list()) {
      summary.total += 1;
      summary[connection.trusted ? "trusted" : "untrusted"] += 1;
      summary[connection.state] += 1;
      summary[connection.security.encrypted ? "encrypted" : "plaintext"] += 1;
      if (connection.transport.current_path === "p2p") {
        summary.p2p += 1;
      } else if (connection.transport.current_path === "relay") {
        summary.relay += 1;
      } else {
        summary.unknown_path += 1;
      }
    }
    return summary;
  }

  getHeartbeatIntervalMs(): number {
    return this.options.heartbeatIntervalMs;
  }

  getStaleTimeoutMs(): number {
    return this.options.staleTimeoutMs;
  }

  getDisconnectTimeoutMs(): number {
    return this.options.disconnectTimeoutMs;
  }

  private findByRelayConnectionId(
    relayConnectionId: string | undefined,
  ): AgentObservedAppConnection | undefined {
    if (!relayConnectionId) {
      return undefined;
    }
    for (const connection of this.byConnectionId.values()) {
      if (connection.relay_connection_id === relayConnectionId) {
        return connection;
      }
    }
    return undefined;
  }

  private findByRuntimeKey(
    runtimeKey: string,
  ): AgentObservedAppConnection | undefined {
    const connectionId = this.byRuntimeKey.get(runtimeKey);
    return connectionId ? this.byConnectionId.get(connectionId) : undefined;
  }

  private runtimeKey(appInfo: AppInfoPayload): string {
    return `${appInfo.instance_id}:${appInfo.runtime_id}`;
  }

  private createBaseConnection(options: {
    appInfo: AppInfoPayload;
    relayConnectionId: string;
    keyId: string;
    now: number;
  }): AgentObservedAppConnection {
    return {
      connection_id: randomUUID(),
      relay_connection_id: options.relayConnectionId,
      app_instance_id: options.appInfo.instance_id,
      app_runtime_id: options.appInfo.runtime_id,
      app_name: options.appInfo.name ?? "OmniWork App",
      app_device_name: options.appInfo.device_name,
      app_platform: options.appInfo.platform,
      app_version: options.appInfo.version,
      client_info_available: true,
      state: "active",
      trusted: true,
      security: {
        encrypted: false,
        mode: "plaintext",
        key_id: options.keyId,
        e2e_ready: false,
        last_verified_at: options.now,
      },
      network: {
        ip_source: "unknown",
        connection_method: "relay",
        relay_connection_id: options.relayConnectionId,
      },
      timing: {
        connected_at: options.now,
        authenticated_at: options.now,
        first_seen_at: options.now,
        last_seen_at: options.now,
        stale_after: options.now + this.options.staleTimeoutMs,
        disconnect_after: options.now + this.options.disconnectTimeoutMs,
      },
      transport: {
        current_path: "relay",
        available_paths: ["relay"],
        relay_state: "available",
      },
      counters: {
        messages_in: 0,
        messages_out: 0,
        heartbeats: 0,
        replay_rejected: 0,
        auth_failures: 0,
      },
      last_seq: 0,
    };
  }

  private clone(
    connection: AgentObservedAppConnection,
  ): AgentObservedAppConnection {
    return JSON.parse(JSON.stringify(connection)) as AgentObservedAppConnection;
  }
}
