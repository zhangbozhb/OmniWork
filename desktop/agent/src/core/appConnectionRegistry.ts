import { randomUUID } from "node:crypto";

import type {
  AppConnectionObservation,
  AppInfoPayload,
  AppConnectionHeartbeatPayload,
  AppConnectionGoodbyePayload,
} from "@omniwork/protocol-ts";

export type ConnectionState = "active" | "idle" | "stale" | "disconnected";
export type SecurityMode = "e2e" | "plaintext" | "unauthenticated";
export type ConnectionMethod = "relay" | "p2p" | "mixed" | "unknown";
export type TransportPathWithUnknown = "relay" | "p2p" | "unknown";
export type IpSource =
  | "socket_remote_address"
  | "x_forwarded_for"
  | "p2p_observed"
  | "app_reported"
  | "agent_observed"
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
  observations?: AppConnectionObservation[];
  now?: number;
}

export interface AuthenticatedConnectionResult {
  connection: AgentObservedAppConnection;
  previousRelayConnectionId?: string;
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
  observations: AppConnectionObservation[];
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
    ip_history: string[];
    private_network_hash?: string;
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
    connection_attempts: number;
    bytes_in: number;
    bytes_out: number;
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
  connection_attempts: number;
  bytes_in: number;
  bytes_out: number;
}

export interface DeviceConnectionStats {
  device_id: string;
  device_name?: string;
  platform?: AgentObservedAppConnection["app_platform"];
  app_name?: string;
  app_version?: string;
  connection_count: number;
  active_connections: number;
  trusted_connections: number;
  encrypted_connections: number;
  connection_attempts: number;
  bytes_in: number;
  bytes_out: number;
  messages_in: number;
  messages_out: number;
  current_path: ConnectionMethod;
  ip?: string;
  ip_source: IpSource;
  ip_history: string[];
  private_network_hash?: string;
  first_seen_at: number;
  last_seen_at: number;
  last_message_at?: number;
}

export class AppConnectionRegistry {
  private readonly options: AppConnectionRegistryOptions;
  private readonly byConnectionId = new Map<
    string,
    AgentObservedAppConnection
  >();
  private readonly byRuntimeKey = new Map<string, string>();
  private readonly byAppInstanceId = new Map<string, string>();

  constructor(options: AppConnectionRegistryOptions) {
    this.options = options;
  }

  acceptAuthenticatedConnection(
    options: AuthenticatedConnectionOptions,
  ): AgentObservedAppConnection {
    return this.acceptAuthenticatedConnectionDetailed(options).connection;
  }

  acceptAuthenticatedConnectionDetailed(
    options: AuthenticatedConnectionOptions,
  ): AuthenticatedConnectionResult {
    const now = options.now ?? Date.now();
    const runtimeKey = this.runtimeKey(options.appInfo);
    const previousRuntimeKey = this.findRuntimeKeyByAppInstanceId(
      options.appInfo.instance_id,
    );
    const existing =
      this.findByRelayConnectionId(options.relayConnectionId) ??
      this.findByRuntimeKey(runtimeKey) ??
      this.findByAppInstanceId(options.appInfo.instance_id);
    const previousRelayConnectionId =
      existing?.relay_connection_id &&
      existing.relay_connection_id !== options.relayConnectionId
        ? existing.relay_connection_id
        : undefined;
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
    connection.app_name = options.appInfo.app?.name ?? connection.app_name;
    connection.app_device_name =
      options.appInfo.device?.name ?? connection.app_device_name;
    connection.app_platform =
      options.appInfo.device?.platform ?? connection.app_platform;
    connection.app_version =
      options.appInfo.app?.version ?? connection.app_version;
    connection.client_info_available = true;
    this.recordObservations(connection, [
      appInfoToObservation(options.appInfo, now),
      ...(options.observations ?? []),
    ]);
    connection.security.encrypted = false;
    connection.security.mode = "plaintext";
    connection.security.key_id = options.keyId;
    connection.security.e2e_ready = false;
    connection.security.handshake_at = undefined;
    connection.security.last_verified_at = now;
    connection.network.relay_connection_id = options.relayConnectionId;
    connection.network.connection_method = "relay";
    connection.timing.connected_at = now;
    connection.timing.authenticated_at = now;
    connection.timing.last_seen_at = now;
    connection.timing.stale_after = now + this.options.staleTimeoutMs;
    connection.timing.disconnect_after = now + this.options.disconnectTimeoutMs;
    connection.transport.current_path = "relay";
    connection.transport.available_paths = ["relay"];
    connection.transport.p2p_state = undefined;
    connection.transport.relay_state = "available";
    connection.transport.last_path_change_at = now;
    connection.last_seq = 0;
    connection.counters.connection_attempts += 1;
    if (previousRuntimeKey && previousRuntimeKey !== runtimeKey) {
      this.byRuntimeKey.delete(previousRuntimeKey);
    }
    this.byRuntimeKey.set(runtimeKey, connection.connection_id);
    this.byAppInstanceId.set(
      options.appInfo.instance_id,
      connection.connection_id,
    );
    this.byConnectionId.set(connection.connection_id, connection);
    return {
      connection: this.clone(connection),
      previousRelayConnectionId,
    };
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

  markRelayUnavailable(now = Date.now()): void {
    for (const connection of this.byConnectionId.values()) {
      connection.state = "disconnected";
      connection.timing.last_seen_at = now;
      connection.timing.stale_after = now;
      connection.timing.disconnect_after = now;
      connection.transport.relay_state = "unavailable";
      connection.transport.current_path = "unknown";
      connection.network.connection_method = "unknown";
      if (connection.transport.p2p_state) {
        connection.transport.p2p_state = "closed";
      }
    }
  }

  recordMessage(
    relayConnectionId: string | undefined,
    direction: "in" | "out",
    encrypted: boolean,
    bytes = 0,
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
      connection.counters.bytes_in += bytes;
    } else {
      connection.counters.messages_out += 1;
      connection.counters.bytes_out += bytes;
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
    connection.network.connection_method =
      path === "unknown" ? "unknown" : path;
    connection.transport.last_path_change_at = now;
    if (
      path === "p2p" &&
      !connection.transport.available_paths.includes("p2p")
    ) {
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
        now - connection.timing.last_message_at >
          this.options.heartbeatIntervalMs
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
      connection_attempts: 0,
      bytes_in: 0,
      bytes_out: 0,
    };
    for (const connection of this.list()) {
      summary.total += 1;
      summary.connection_attempts += connection.counters.connection_attempts;
      summary.bytes_in += connection.counters.bytes_in;
      summary.bytes_out += connection.counters.bytes_out;
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

  devices(): DeviceConnectionStats[] {
    const devices = new Map<string, DeviceConnectionStats>();
    for (const connection of this.list()) {
      const deviceId = connection.app_instance_id;
      const existing = devices.get(deviceId);
      const stats =
        existing ??
        ({
          device_id: deviceId,
          device_name: connection.app_device_name,
          platform: connection.app_platform,
          app_name: connection.app_name,
          app_version: connection.app_version,
          connection_count: 0,
          active_connections: 0,
          trusted_connections: 0,
          encrypted_connections: 0,
          connection_attempts: 0,
          bytes_in: 0,
          bytes_out: 0,
          messages_in: 0,
          messages_out: 0,
          current_path: connection.transport.current_path,
          ip: connection.network.ip,
          ip_source: connection.network.ip_source,
          ip_history: [],
          private_network_hash: connection.network.private_network_hash,
          first_seen_at: connection.timing.first_seen_at,
          last_seen_at: connection.timing.last_seen_at,
          last_message_at: connection.timing.last_message_at,
        } satisfies DeviceConnectionStats);

      stats.device_name = connection.app_device_name ?? stats.device_name;
      stats.platform = connection.app_platform ?? stats.platform;
      stats.app_name = connection.app_name ?? stats.app_name;
      stats.app_version = connection.app_version ?? stats.app_version;
      stats.connection_count += 1;
      if (connection.state === "active") {
        stats.active_connections += 1;
      }
      if (connection.trusted) {
        stats.trusted_connections += 1;
      }
      if (connection.security.encrypted) {
        stats.encrypted_connections += 1;
      }
      stats.connection_attempts += connection.counters.connection_attempts;
      stats.bytes_in += connection.counters.bytes_in;
      stats.bytes_out += connection.counters.bytes_out;
      stats.messages_in += connection.counters.messages_in;
      stats.messages_out += connection.counters.messages_out;
      stats.current_path = mergeTransportPath(
        stats.current_path,
        connection.transport.current_path,
      );
      if (connection.network.ip) {
        stats.ip = connection.network.ip;
        stats.ip_source = connection.network.ip_source;
      }
      for (const ip of connection.network.ip_history) {
        if (!stats.ip_history.includes(ip)) {
          stats.ip_history.push(ip);
        }
      }
      stats.private_network_hash =
        connection.network.private_network_hash ?? stats.private_network_hash;
      stats.first_seen_at = Math.min(
        stats.first_seen_at,
        connection.timing.first_seen_at,
      );
      stats.last_seen_at = Math.max(
        stats.last_seen_at,
        connection.timing.last_seen_at,
      );
      if (
        connection.timing.last_message_at &&
        (!stats.last_message_at ||
          connection.timing.last_message_at > stats.last_message_at)
      ) {
        stats.last_message_at = connection.timing.last_message_at;
      }
      devices.set(deviceId, stats);
    }
    return [...devices.values()].sort(
      (a, b) => b.last_seen_at - a.last_seen_at,
    );
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

  private findByAppInstanceId(
    appInstanceId: string,
  ): AgentObservedAppConnection | undefined {
    const connectionId = this.byAppInstanceId.get(appInstanceId);
    return connectionId ? this.byConnectionId.get(connectionId) : undefined;
  }

  private findRuntimeKeyByAppInstanceId(
    appInstanceId: string,
  ): string | undefined {
    for (const [runtimeKey, connectionId] of this.byRuntimeKey.entries()) {
      const connection = this.byConnectionId.get(connectionId);
      if (connection?.app_instance_id === appInstanceId) {
        return runtimeKey;
      }
    }
    return undefined;
  }

  private runtimeKey(appInfo: AppInfoPayload): string {
    return `${appInfo.instance_id}:${appInfo.runtime_id}`;
  }

  private recordObservations(
    connection: AgentObservedAppConnection,
    observations: AppConnectionObservation[],
  ): void {
    for (const observation of observations) {
      connection.observations.push(this.cloneObservation(observation));
      const network = observation.network;
      const observedIp = network?.remote_ip ?? network?.public_ip;
      if (observedIp) {
        connection.network.ip = observedIp;
        connection.network.ip_source =
          network?.ip_source ?? observationSourceToIpSource(observation.source);
        if (!connection.network.ip_history.includes(observedIp)) {
          connection.network.ip_history.push(observedIp);
        }
      }
      if (network?.private_network_hash) {
        connection.network.private_network_hash = network.private_network_hash;
      }
    }
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
      app_name: options.appInfo.app?.name ?? "OmniWork App",
      app_device_name: options.appInfo.device?.name,
      app_platform: options.appInfo.device?.platform,
      app_version: options.appInfo.app?.version,
      observations: [],
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
        ip_history: [],
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
        connection_attempts: 0,
        bytes_in: 0,
        bytes_out: 0,
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

  private cloneObservation(
    observation: AppConnectionObservation,
  ): AppConnectionObservation {
    return JSON.parse(JSON.stringify(observation)) as AppConnectionObservation;
  }
}

function observationSourceToIpSource(
  source: AppConnectionObservation["source"],
): IpSource {
  if (source === "app") {
    return "app_reported";
  }
  if (source === "agent") {
    return "agent_observed";
  }
  if (source === "p2p") {
    return "p2p_observed";
  }
  return "unknown";
}

function appInfoToObservation(
  appInfo: AppInfoPayload,
  observedAt: number,
): AppConnectionObservation {
  return {
    source: "app",
    observed_at: new Date(observedAt).toISOString(),
    ...(appInfo.device
      ? {
          device: {
            name: appInfo.device.name,
            platform: appInfo.device.platform,
            os: appInfo.device.os,
            os_version: appInfo.device.os_version,
          },
          ...(appInfo.device.private_network_hash
            ? {
                network: {
                  private_network_hash: appInfo.device.private_network_hash,
                  ip_source: "app_reported",
                },
              }
            : {}),
        }
      : {}),
    ...(appInfo.app
      ? {
          app: {
            name: appInfo.app.name,
            version: appInfo.app.version,
            runtime_id: appInfo.runtime_id,
          },
        }
      : {}),
  };
}

function mergeTransportPath(
  current: ConnectionMethod,
  next: TransportPathWithUnknown,
): ConnectionMethod {
  if (current === next) {
    return current;
  }
  if (current === "unknown") {
    return next;
  }
  if (next === "unknown") {
    return current;
  }
  return "mixed";
}
