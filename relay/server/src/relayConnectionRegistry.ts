import { randomUUID } from "node:crypto";

import type { RelayStateStore } from "./relayStateStore.ts";
import type {
  PendingAuth,
  RelayConnection,
  RelayConnectionLocation,
  RelayEndpoint,
  RelaySocket,
} from "./relayTypes.ts";

export interface RelayConnectionRegistryOptions {
  state: RelayStateStore;
  pendingAuth: Map<string, PendingAuth>;
  onRawMessage(connection: RelayConnection, raw: string): void;
  onAgentDisconnected(deviceId: string): void;
  onMobileDisconnected(deviceId: string, connection: RelayConnection): void;
}

export class RelayConnectionRegistry {
  readonly connections = new Map<string, RelayConnection>();
  readonly agentsByDevice = new Map<string, Set<RelayConnection>>();
  readonly primaryAgentByDevice = new Map<string, RelayConnection>();
  readonly mobilesByDevice = new Map<string, Set<RelayConnection>>();

  private readonly options: RelayConnectionRegistryOptions;

  constructor(options: RelayConnectionRegistryOptions) {
    this.options = options;
  }

  register(
    socket: RelaySocket,
    endpoint: RelayEndpoint,
    options: {
      remoteIp?: string;
      userId?: string;
      location?: RelayConnectionLocation;
      observations?: RelayConnection["observations"];
    } = {},
  ): RelayConnection {
    const now = Date.now();
    const connection: RelayConnection = {
      id: `conn_${randomUUID()}`,
      endpoint,
      role: "unknown",
      state: "socket_connected",
      socket,
      userId: options.userId,
      authenticated: false,
      remoteIp: options.remoteIp ?? "unknown",
      location: options.location,
      observations: options.observations ?? [],
      connectedAt: now,
      lastSeenAt: now,
      authState: "none",
      transportPath: "relay",
    };
    this.connections.set(connection.id, connection);
    this.options.state.registerConnection(connection);

    socket.onMessage((raw) => this.options.onRawMessage(connection, raw));
    socket.onClose(() => this.unregister(connection));
    return connection;
  }

  unregister(connection: RelayConnection): void {
    connection.state = "closed";
    this.connections.delete(connection.id);
    this.options.pendingAuth.delete(connection.id);
    if (connection.role === "agent" && connection.deviceId) {
      const agents = this.agentsByDevice.get(connection.deviceId);
      agents?.delete(connection);
      if (agents && agents.size === 0) {
        this.agentsByDevice.delete(connection.deviceId);
      }
      if (this.primaryAgentByDevice.get(connection.deviceId) === connection) {
        const next = agents?.values().next().value;
        if (next) {
          this.primaryAgentByDevice.set(connection.deviceId, next);
        } else {
          this.primaryAgentByDevice.delete(connection.deviceId);
          this.options.onAgentDisconnected(connection.deviceId);
        }
      }
    }
    if (connection.role === "mobile" && connection.deviceId) {
      this.mobilesByDevice.get(connection.deviceId)?.delete(connection);
      this.options.onMobileDisconnected(connection.deviceId, connection);
    }
    this.options.state.closeConnection(connection);
  }

  closeDeviceConnections(deviceId: string): void {
    for (const connection of this.connections.values()) {
      if (connection.deviceId === deviceId) {
        connection.socket.close(4403, "device_revoked");
      }
    }
  }

  getConnection(connectionId: string | undefined): RelayConnection | undefined {
    return connectionId ? this.connections.get(connectionId) : undefined;
  }

  getPrimaryAgent(deviceId: string | undefined): RelayConnection | undefined {
    return deviceId ? this.primaryAgentByDevice.get(deviceId) : undefined;
  }

  addAgentToDevice(deviceId: string, connection: RelayConnection): void {
    const agents =
      this.agentsByDevice.get(deviceId) ?? new Set<RelayConnection>();
    agents.add(connection);
    this.agentsByDevice.set(deviceId, agents);
    if (!this.primaryAgentByDevice.has(deviceId)) {
      this.primaryAgentByDevice.set(deviceId, connection);
    }
  }

  addMobileToDevice(deviceId: string, connection: RelayConnection): void {
    const mobiles =
      this.mobilesByDevice.get(deviceId) ?? new Set<RelayConnection>();
    mobiles.add(connection);
    this.mobilesByDevice.set(deviceId, mobiles);
  }
}
