import type { AppInfoPayload, MessageEnvelope } from "@omniwork/protocol-ts";

import type { RelayConnection, RelayAppInfo } from "./relayTypes.ts";

export interface RelayTrafficCounters {
  bytes_in: number;
  bytes_out: number;
  messages_in: number;
  messages_out: number;
  messages_in_by_type: Record<string, number>;
  messages_out_by_type: Record<string, number>;
}

export type RelayLinkStateName =
  | "pairing"
  | "authenticated"
  | "e2e_handshaking"
  | "e2e_ready"
  | "p2p"
  | "closed";

export interface RelayAgentConnectionState {
  connection_id: string;
  device_id: string;
  agent_instance_id?: string;
  key_id?: string;
  remote_ip: string;
  connected_at: number;
  last_seen_at: number;
  state: string;
  business_security_mode: string;
  transport_path: string;
  counters: RelayTrafficCounters;
}

export interface RelayAppConnectionState {
  connection_id: string;
  device_id: string;
  app_info?: AppInfoPayload;
  remote_ip: string;
  connected_at: number;
  last_seen_at: number;
  state: string;
  auth_state: string;
  transport_preference?: string;
  transport_path: string;
  counters: RelayTrafficCounters;
}

export interface RelayLinkState {
  link_id: string;
  device_id: string;
  agent_connection_id: string;
  app_connection_id: string;
  state: RelayLinkStateName;
  created_at: number;
  last_seen_at: number;
  e2e_session_id?: string;
  transport_path: string;
  counters: RelayTrafficCounters;
}

export interface RelayAppConnectionSnapshot
  extends Omit<RelayAppConnectionState, "connected_at" | "last_seen_at"> {
  connected_at: string;
  last_seen_at: string;
}

export interface RelayAgentConnectionSnapshot
  extends Omit<RelayAgentConnectionState, "connected_at" | "last_seen_at"> {
  connected_at: string;
  last_seen_at: string;
  app_count: number;
}

export interface RelayLinkSnapshot
  extends Omit<RelayLinkState, "created_at" | "last_seen_at"> {
  created_at: string;
  last_seen_at: string;
}

export interface RelayDeviceState {
  device_id: string;
  agents: Set<string>;
  apps: Set<string>;
  links: Set<string>;
  first_seen_at: number;
  last_seen_at: number;
  status: "online" | "degraded" | "offline";
  counters: RelayTrafficCounters;
}

export interface RelayRuntimeSnapshot {
  runtime: {
    started_at: string;
    uptime_ms: number;
  };
  totals: {
    device_count: number;
    agent_count: number;
    app_connection_count: number;
    link_count: number;
    connection_count: number;
  };
  traffic: RelayTrafficCounters;
  auth: {
    failed: number;
  };
  routing: {
    dropped: number;
  };
  protocol: {
    errors_sent: number;
  };
}

export interface RelayStateSnapshot extends RelayRuntimeSnapshot {
  devices: ReturnType<RelayStateStore["devicesSnapshot"]>["devices"];
  agents: RelayAgentConnectionSnapshot[];
  apps: RelayAppConnectionSnapshot[];
  links: RelayLinkSnapshot[];
}

export class RelayStateStore {
  readonly startedAt = Date.now();
  private readonly counters = emptyCounters();
  private readonly auth = { failed: 0 };
  private readonly routing = { dropped: 0 };
  private readonly protocol = { errors_sent: 0 };
  private readonly devices = new Map<string, RelayDeviceState>();
  private readonly connections = new Map<string, RelayConnection>();
  private readonly agents = new Map<string, RelayAgentConnectionState>();
  private readonly apps = new Map<string, RelayAppConnectionState>();
  private readonly links = new Map<string, RelayLinkState>();
  private readonly linkByApp = new Map<string, string>();

  registerConnection(connection: RelayConnection): void {
    this.connections.set(connection.id, connection);
  }

  closeConnection(connection: RelayConnection): void {
    const now = Date.now();
    const agent = this.agents.get(connection.id);
    if (agent) {
      agent.state = "closed";
      agent.last_seen_at = now;
      this.refreshDeviceStatus(agent.device_id, now);
    }
    const app = this.apps.get(connection.id);
    if (app) {
      app.state = "closed";
      app.last_seen_at = now;
      const linkId = this.linkByApp.get(connection.id);
      if (linkId) {
        const link = this.links.get(linkId);
        if (link) {
          link.state = "closed";
          link.last_seen_at = now;
        }
      }
      this.refreshDeviceStatus(app.device_id, now);
    }
  }

  registerAgent(connection: RelayConnection): void {
    if (!connection.deviceId) return;
    const device = this.ensureDevice(connection.deviceId, connection.lastSeenAt);
    device.agents.add(connection.id);
    device.last_seen_at = connection.lastSeenAt;
    device.status = "online";
    this.agents.set(connection.id, {
      connection_id: connection.id,
      device_id: connection.deviceId,
      agent_instance_id: connection.agentInstanceId,
      key_id: connection.keyId,
      remote_ip: connection.remoteIp,
      connected_at: connection.connectedAt,
      last_seen_at: connection.lastSeenAt,
      state: connection.state,
      business_security_mode:
        connection.businessSecurityMode ?? "e2e_required",
      transport_path: connection.transportPath,
      counters: emptyCounters(),
    });
  }

  registerApp(connection: RelayConnection): void {
    if (!connection.deviceId) return;
    const device = this.ensureDevice(connection.deviceId, connection.lastSeenAt);
    device.apps.add(connection.id);
    device.last_seen_at = connection.lastSeenAt;
    this.apps.set(connection.id, {
      connection_id: connection.id,
      device_id: connection.deviceId,
      app_info: connection.appInfo
        ? appInfoToPayload(connection.appInfo)
        : undefined,
      remote_ip: connection.remoteIp,
      connected_at: connection.connectedAt,
      last_seen_at: connection.lastSeenAt,
      state: connection.state,
      auth_state: connection.authState,
      transport_preference: connection.transportPreference,
      transport_path: connection.transportPath,
      counters: emptyCounters(),
    });
  }

  authenticateApp(app: RelayConnection, agent?: RelayConnection): void {
    this.registerApp(app);
    const appState = this.apps.get(app.id);
    if (appState) {
      appState.state = app.state;
      appState.auth_state = app.authState;
      appState.last_seen_at = app.lastSeenAt;
    }
    if (app.deviceId && agent?.id) {
      this.createOrUpdateLink({
        deviceId: app.deviceId,
        agentConnectionId: agent.id,
        appConnectionId: app.id,
        state: "authenticated",
        transportPath: app.transportPath,
      });
    }
  }

  createOrUpdateLink(input: {
    deviceId: string;
    agentConnectionId: string;
    appConnectionId: string;
    state: RelayLinkStateName;
    transportPath: RelayConnection["transportPath"];
    e2eSessionId?: string;
  }): RelayLinkState {
    const now = Date.now();
    const existingId = this.linkByApp.get(input.appConnectionId);
    const linkId =
      existingId ??
      `link_${input.deviceId}_${input.agentConnectionId}_${input.appConnectionId}`;
    let link = this.links.get(linkId);
    if (!link) {
      link = {
        link_id: linkId,
        device_id: input.deviceId,
        agent_connection_id: input.agentConnectionId,
        app_connection_id: input.appConnectionId,
        state: input.state,
        created_at: now,
        last_seen_at: now,
        transport_path: input.transportPath,
        counters: emptyCounters(),
      };
    }
    link.state = input.state;
    link.last_seen_at = now;
    link.transport_path = input.transportPath;
    link.e2e_session_id = input.e2eSessionId;
    this.links.set(linkId, link);
    this.linkByApp.set(input.appConnectionId, linkId);
    const device = this.ensureDevice(input.deviceId, now);
    device.links.add(linkId);
    device.last_seen_at = now;
    return link;
  }

  recordIngress(
    connection: RelayConnection,
    message: MessageEnvelope,
    bytes: number,
  ): void {
    this.recordTraffic(connection, "in", message, bytes);
  }

  recordEgress(
    connection: RelayConnection,
    message: MessageEnvelope,
    bytes: number,
  ): void {
    this.recordTraffic(connection, "out", message, bytes);
  }

  recordAuthFailed(): void {
    this.auth.failed += 1;
  }

  recordRouteDropped(): void {
    this.routing.dropped += 1;
  }

  recordProtocolErrorSent(): void {
    this.protocol.errors_sent += 1;
  }

  runtimeSnapshot(now = Date.now()): RelayRuntimeSnapshot {
    const activeConnections = [...this.connections.values()].filter(
      (connection) => connection.state !== "closed",
    );
    const activeAgents = [...this.agents.values()].filter(
      (agent) => agent.state !== "closed",
    );
    const activeApps = [...this.apps.values()].filter(
      (app) => app.state !== "closed",
    );
    const activeLinks = [...this.links.values()].filter(
      (link) => link.state !== "closed",
    );
    return {
      runtime: {
        started_at: toIso(this.startedAt),
        uptime_ms: now - this.startedAt,
      },
      totals: {
        device_count: this.devices.size,
        agent_count: activeAgents.length,
        app_connection_count: activeApps.length,
        link_count: activeLinks.length,
        connection_count: activeConnections.length,
      },
      traffic: cloneCounters(this.counters),
      auth: { ...this.auth },
      routing: { ...this.routing },
      protocol: { ...this.protocol },
    };
  }

  devicesSnapshot() {
    const devices = [...this.devices.values()]
      .sort((a, b) => a.device_id.localeCompare(b.device_id))
      .map((device) => ({
        device_id: device.device_id,
        agent_count: activeCount(device.agents, this.agents),
        app_count: activeCount(device.apps, this.apps),
        link_count: activeCount(device.links, this.links),
        first_seen_at: toIso(device.first_seen_at),
        last_seen_at: toIso(device.last_seen_at),
        status: device.status,
        counters: cloneCounters(device.counters),
      }));
    return {
      devices,
      summary: {
        device_count: devices.length,
        agent_count: devices.reduce(
          (total, device) => total + device.agent_count,
          0,
        ),
        app_count: devices.reduce(
          (total, device) => total + device.app_count,
          0,
        ),
        link_count: devices.reduce(
          (total, device) => total + device.link_count,
          0,
        ),
      },
    };
  }

  agentsSnapshot() {
    const agents = [...this.agents.values()]
      .filter((agent) => agent.state !== "closed")
      .sort((a, b) => a.device_id.localeCompare(b.device_id))
      .map((agent) => ({
        ...agent,
        connected_at: toIso(agent.connected_at),
        last_seen_at: toIso(agent.last_seen_at),
        app_count: this.appsForDevice(agent.device_id).length,
        counters: cloneCounters(agent.counters),
      }));
    return {
      agents,
      summary: {
        agent_count: agents.length,
        app_count: agents.reduce((total, agent) => total + agent.app_count, 0),
      },
    };
  }

  agentAppsSnapshot(connectionId: string) {
    const agent = this.agents.get(connectionId);
    if (!agent || agent.state === "closed") {
      return {
        connection_id: connectionId,
        device_id: undefined,
        agent_instance_id: undefined,
        apps: [],
        summary: { app_count: 0 },
      };
    }
    const apps = this.appsForDevice(agent.device_id);
    return {
      connection_id: connectionId,
      device_id: agent.device_id,
      agent_instance_id: agent.agent_instance_id,
      apps,
      summary: { app_count: apps.length },
    };
  }

  linksSnapshot() {
    const links = [...this.links.values()]
      .filter((link) => link.state !== "closed")
      .sort((a, b) => a.created_at - b.created_at)
      .map((link) => ({
        ...link,
        created_at: toIso(link.created_at),
        last_seen_at: toIso(link.last_seen_at),
        counters: cloneCounters(link.counters),
      }));
    return {
      links,
      summary: { link_count: links.length },
    };
  }

  trafficTop(limit = 20) {
    const connections = [...this.agents.values(), ...this.apps.values()]
      .filter((connection) => connection.state !== "closed")
      .sort(
        (a, b) =>
          b.counters.bytes_in +
          b.counters.bytes_out -
          (a.counters.bytes_in + a.counters.bytes_out),
      )
      .slice(0, limit);
    return { connections };
  }

  snapshot(): RelayStateSnapshot {
    const runtime = this.runtimeSnapshot();
    return {
      ...runtime,
      devices: this.devicesSnapshot().devices,
      agents: this.agentsSnapshot().agents,
      apps: this.appsSnapshot(),
      links: this.linksSnapshot().links,
    };
  }

  private recordTraffic(
    connection: RelayConnection,
    direction: "in" | "out",
    message: MessageEnvelope,
    bytes: number,
  ): void {
    const update = (counters: RelayTrafficCounters) =>
      incrementCounters(counters, direction, message.type, bytes);
    update(this.counters);
    if (connection.deviceId) {
      update(this.ensureDevice(connection.deviceId, Date.now()).counters);
    }
    const connectionState =
      connection.role === "agent"
        ? this.agents.get(connection.id)
        : connection.role === "mobile"
          ? this.apps.get(connection.id)
          : undefined;
    if (connectionState) {
      update(connectionState.counters);
      connectionState.last_seen_at = connection.lastSeenAt;
      connectionState.state = connection.state;
      connectionState.transport_path = connection.transportPath;
    }
    const linkId = this.linkIdForTraffic(
      connection,
      message.app_connection_id,
    );
    if (linkId) {
      const link = this.links.get(linkId);
      if (link) {
        update(link.counters);
        link.last_seen_at = connection.lastSeenAt;
        link.transport_path = connection.transportPath;
      }
    }
  }

  private linkIdForTraffic(
    connection: RelayConnection,
    appConnectionId: string | undefined,
  ): string | undefined {
    if (connection.role === "mobile") {
      return this.linkByApp.get(connection.id);
    }
    if (connection.role === "agent" && appConnectionId) {
      return this.linkByApp.get(appConnectionId);
    }
    return undefined;
  }

  private appsSnapshot(): RelayAppConnectionSnapshot[] {
    return [...this.apps.values()]
      .filter((app) => app.state !== "closed")
      .sort((a, b) => a.connected_at - b.connected_at)
      .map((app) => this.serializeApp(app));
  }

  private appsForDevice(deviceId: string): RelayAppConnectionSnapshot[] {
    return [...this.apps.values()]
      .filter((app) => app.device_id === deviceId && app.state !== "closed")
      .sort((a, b) => a.connected_at - b.connected_at)
      .map((app) => this.serializeApp(app));
  }

  private serializeApp(app: RelayAppConnectionState): RelayAppConnectionSnapshot {
    return {
      ...app,
      connected_at: toIso(app.connected_at),
      last_seen_at: toIso(app.last_seen_at),
      counters: cloneCounters(app.counters),
    };
  }

  private ensureDevice(deviceId: string, now: number): RelayDeviceState {
    const existing = this.devices.get(deviceId);
    if (existing) {
      return existing;
    }
    const device: RelayDeviceState = {
      device_id: deviceId,
      agents: new Set(),
      apps: new Set(),
      links: new Set(),
      first_seen_at: now,
      last_seen_at: now,
      status: "online",
      counters: emptyCounters(),
    };
    this.devices.set(deviceId, device);
    return device;
  }

  private refreshDeviceStatus(deviceId: string, now: number): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    device.last_seen_at = now;
    const agentCount = activeCount(device.agents, this.agents);
    const appCount = activeCount(device.apps, this.apps);
    if (agentCount > 0) {
      device.status = "online";
    } else if (appCount > 0) {
      device.status = "degraded";
    } else {
      device.status = "offline";
    }
  }
}

function emptyCounters(): RelayTrafficCounters {
  return {
    bytes_in: 0,
    bytes_out: 0,
    messages_in: 0,
    messages_out: 0,
    messages_in_by_type: {},
    messages_out_by_type: {},
  };
}

function incrementCounters(
  counters: RelayTrafficCounters,
  direction: "in" | "out",
  type: string,
  bytes: number,
): void {
  if (direction === "in") {
    counters.bytes_in += bytes;
    counters.messages_in += 1;
    counters.messages_in_by_type[type] =
      (counters.messages_in_by_type[type] ?? 0) + 1;
  } else {
    counters.bytes_out += bytes;
    counters.messages_out += 1;
    counters.messages_out_by_type[type] =
      (counters.messages_out_by_type[type] ?? 0) + 1;
  }
}

function cloneCounters(counters: RelayTrafficCounters): RelayTrafficCounters {
  return {
    bytes_in: counters.bytes_in,
    bytes_out: counters.bytes_out,
    messages_in: counters.messages_in,
    messages_out: counters.messages_out,
    messages_in_by_type: { ...counters.messages_in_by_type },
    messages_out_by_type: { ...counters.messages_out_by_type },
  };
}

function activeCount<T extends { state: string }>(
  ids: Set<string>,
  records: Map<string, T>,
): number {
  let count = 0;
  for (const id of ids) {
    if (records.get(id)?.state !== "closed") {
      count += 1;
    }
  }
  return count;
}

function appInfoToPayload(info: RelayAppInfo): AppInfoPayload {
  return {
    instance_id: info.instanceId,
    runtime_id: info.runtimeId,
    device: info.device,
    app: info.app,
  };
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
