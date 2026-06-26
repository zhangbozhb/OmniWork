import type { AppInfoPayload, MessageEnvelope } from "@omniwork/protocol-ts";

import type {
  RelayAppInfo,
  RelayConnection,
  RelayConnectionLocation,
} from "./relayTypes.ts";

export interface RelayTrafficCounters {
  bytes_in: number;
  bytes_out: number;
  messages_in: number;
  messages_out: number;
  messages_in_by_type: Record<string, number>;
  messages_out_by_type: Record<string, number>;
}

export interface RelayLinkDirectionCounters {
  app_to_agent_bytes: number;
  agent_to_app_bytes: number;
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
  location?: RelayConnectionLocation;
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
  location?: RelayConnectionLocation;
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
  directional_counters: RelayLinkDirectionCounters;
}

export interface RelayAppConnectionSnapshot extends Omit<
  RelayAppConnectionState,
  "connected_at" | "last_seen_at"
> {
  connected_at: string;
  last_seen_at: string;
}

export interface RelayAgentConnectionSnapshot extends Omit<
  RelayAgentConnectionState,
  "connected_at" | "last_seen_at"
> {
  connected_at: string;
  last_seen_at: string;
  app_count: number;
}

export interface RelayLinkSnapshot extends Omit<
  RelayLinkState,
  "created_at" | "last_seen_at"
> {
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

interface TrafficMapLocation {
  location_id: string;
  label: string;
  latitude: number;
  longitude: number;
  accuracy: "city" | "region" | "country" | "private" | "reserved" | "unknown";
  source: RelayConnectionLocation["source"] | "fallback";
  country_code?: string;
  country?: string;
  region?: string;
  city?: string;
}

interface TrafficMapLocationBuilder extends TrafficMapLocation {
  connection_count: number;
  agent_count: number;
  app_count: number;
  deviceIds: Set<string>;
  counters: RelayTrafficCounters;
}

interface TrafficMapFlowBuilder {
  flow_id: string;
  from_location_id: string;
  to_location_id: string;
  link_count: number;
  deviceIds: Set<string>;
  app_to_agent_bytes: number;
  agent_to_app_bytes: number;
  total_bytes: number;
  transport_paths: Record<string, number>;
  last_seen_at: number;
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
    const device = this.ensureDevice(
      connection.deviceId,
      connection.lastSeenAt,
    );
    device.agents.add(connection.id);
    device.last_seen_at = connection.lastSeenAt;
    device.status = "online";
    this.agents.set(connection.id, {
      connection_id: connection.id,
      device_id: connection.deviceId,
      agent_instance_id: connection.agentInstanceId,
      key_id: connection.keyId,
      remote_ip: connection.remoteIp,
      location: connection.location,
      connected_at: connection.connectedAt,
      last_seen_at: connection.lastSeenAt,
      state: connection.state,
      business_security_mode: connection.businessSecurityMode ?? "e2e_required",
      transport_path: connection.transportPath,
      counters: emptyCounters(),
    });
  }

  registerApp(connection: RelayConnection): void {
    if (!connection.deviceId) return;
    const device = this.ensureDevice(
      connection.deviceId,
      connection.lastSeenAt,
    );
    device.apps.add(connection.id);
    device.last_seen_at = connection.lastSeenAt;
    this.apps.set(connection.id, {
      connection_id: connection.id,
      device_id: connection.deviceId,
      app_info: connection.appInfo
        ? appInfoToPayload(connection.appInfo)
        : undefined,
      remote_ip: connection.remoteIp,
      location: connection.location,
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
        directional_counters: emptyLinkDirectionCounters(),
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

  trafficMapSnapshot() {
    const nodes = new Map<string, TrafficMapLocationBuilder>();
    const flowBuilders = new Map<string, TrafficMapFlowBuilder>();
    const connectionsById = new Map<
      string,
      RelayAgentConnectionState | RelayAppConnectionState
    >();
    for (const [id, agent] of this.agents) {
      connectionsById.set(id, agent);
    }
    for (const [id, app] of this.apps) {
      connectionsById.set(id, app);
    }
    const activeAgents = [...this.agents.values()].filter(
      (agent) => agent.state !== "closed",
    );
    const activeApps = [...this.apps.values()].filter(
      (app) => app.state !== "closed",
    );

    for (const agent of activeAgents) {
      addConnectionToTrafficMap(nodes, agent, "agent");
    }
    for (const app of activeApps) {
      addConnectionToTrafficMap(nodes, app, "app");
    }

    for (const link of [...this.links.values()].filter(
      (item) => item.state !== "closed",
    )) {
      const agent = connectionsById.get(link.agent_connection_id);
      const app = connectionsById.get(link.app_connection_id);
      if (!agent || !app) {
        continue;
      }
      const from = trafficLocationFromConnection(app);
      const to = trafficLocationFromConnection(agent);
      addLinkToTrafficMapFlows(flowBuilders, link, from, to);
    }

    const trafficNodes = [...nodes.values()]
      .map((node) => ({
        ...node,
        counters: cloneCounters(node.counters),
        device_count: node.deviceIds.size,
      }))
      .map(({ deviceIds: _deviceIds, ...node }) => node)
      .sort((a, b) => b.connection_count - a.connection_count);
    const flows = [...flowBuilders.values()]
      .map((flow) => ({
        flow_id: flow.flow_id,
        from_location_id: flow.from_location_id,
        to_location_id: flow.to_location_id,
        link_count: flow.link_count,
        device_count: flow.deviceIds.size,
        app_to_agent_bytes: flow.app_to_agent_bytes,
        agent_to_app_bytes: flow.agent_to_app_bytes,
        total_bytes: flow.total_bytes,
        transport_paths: { ...flow.transport_paths },
        last_seen_at: toIso(flow.last_seen_at),
      }))
      .sort((a, b) => b.total_bytes - a.total_bytes);

    return {
      generated_at: toIso(Date.now()),
      nodes: trafficNodes,
      locations: trafficNodes,
      flows,
      summary: {
        node_count: trafficNodes.length,
        location_count: trafficNodes.length,
        flow_count: flows.length,
        city_node_count: trafficNodes.filter((node) => node.accuracy === "city")
          .length,
        country_node_count: trafficNodes.filter(
          (node) => node.accuracy === "country",
        ).length,
        unknown_node_count: trafficNodes.filter(
          (node) => node.accuracy === "unknown",
        ).length,
        app_to_agent_bytes: flows.reduce(
          (total, flow) => total + flow.app_to_agent_bytes,
          0,
        ),
        agent_to_app_bytes: flows.reduce(
          (total, flow) => total + flow.agent_to_app_bytes,
          0,
        ),
      },
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
    const linkId = this.linkIdForTraffic(connection, message.app_connection_id);
    if (linkId) {
      const link = this.links.get(linkId);
      if (link) {
        update(link.counters);
        if (direction === "in") {
          incrementLinkDirection(link.directional_counters, connection, bytes);
        }
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

  private serializeApp(
    app: RelayAppConnectionState,
  ): RelayAppConnectionSnapshot {
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

function emptyLinkDirectionCounters(): RelayLinkDirectionCounters {
  return {
    app_to_agent_bytes: 0,
    agent_to_app_bytes: 0,
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

function incrementLinkDirection(
  counters: RelayLinkDirectionCounters,
  connection: RelayConnection,
  bytes: number,
): void {
  if (connection.role === "mobile") {
    counters.app_to_agent_bytes += bytes;
  } else if (connection.role === "agent") {
    counters.agent_to_app_bytes += bytes;
  }
}

function addConnectionToTrafficMap(
  locations: Map<string, TrafficMapLocationBuilder>,
  connection: RelayAgentConnectionState | RelayAppConnectionState,
  role: "agent" | "app",
): void {
  const base = trafficLocationFromConnection(connection);
  let location = locations.get(base.location_id);
  if (!location) {
    location = {
      ...base,
      connection_count: 0,
      agent_count: 0,
      app_count: 0,
      deviceIds: new Set<string>(),
      counters: emptyCounters(),
    };
    locations.set(base.location_id, location);
  }
  location.connection_count += 1;
  if (role === "agent") {
    location.agent_count += 1;
  } else {
    location.app_count += 1;
  }
  location.deviceIds.add(connection.device_id);
  mergeCounters(location.counters, connection.counters);
}

function addLinkToTrafficMapFlows(
  flows: Map<string, TrafficMapFlowBuilder>,
  link: RelayLinkState,
  from: TrafficMapLocation,
  to: TrafficMapLocation,
): void {
  const flowId = `${from.location_id}->${to.location_id}`;
  let flow = flows.get(flowId);
  if (!flow) {
    flow = {
      flow_id: flowId,
      from_location_id: from.location_id,
      to_location_id: to.location_id,
      link_count: 0,
      deviceIds: new Set<string>(),
      app_to_agent_bytes: 0,
      agent_to_app_bytes: 0,
      total_bytes: 0,
      transport_paths: {},
      last_seen_at: link.last_seen_at,
    };
    flows.set(flowId, flow);
  }
  flow.link_count += 1;
  flow.deviceIds.add(link.device_id);
  flow.app_to_agent_bytes += link.directional_counters.app_to_agent_bytes;
  flow.agent_to_app_bytes += link.directional_counters.agent_to_app_bytes;
  flow.total_bytes = flow.app_to_agent_bytes + flow.agent_to_app_bytes;
  flow.transport_paths[link.transport_path] =
    (flow.transport_paths[link.transport_path] ?? 0) + 1;
  flow.last_seen_at = Math.max(flow.last_seen_at, link.last_seen_at);
}

function trafficLocationFromConnection(
  connection: RelayAgentConnectionState | RelayAppConnectionState,
): TrafficMapLocation {
  if (connection.location) {
    return {
      location_id: connection.location.location_id,
      label: connection.location.label,
      latitude: connection.location.latitude,
      longitude: connection.location.longitude,
      accuracy: connection.location.accuracy,
      source: connection.location.source,
      country_code: connection.location.country_code,
      country: connection.location.country,
      region: connection.location.region,
      city: connection.location.city,
    };
  }
  return trafficLocationFromIp(connection.remote_ip);
}

function trafficLocationFromIp(remoteIp: string): TrafficMapLocation {
  const ip = normalizeIpForTrafficMap(remoteIp);
  if (isLoopbackIp(ip) || isPrivateIp(ip)) {
    return {
      location_id: "private-network",
      label: "Private / Loopback",
      latitude: 1.35,
      longitude: 103.82,
      accuracy: "private",
      source: "fallback",
    };
  }
  if (isReservedDocumentationIp(ip)) {
    return {
      location_id: "reserved-documentation",
      label: "Reserved Test Network",
      latitude: 37.77,
      longitude: -122.42,
      accuracy: "reserved",
      source: "fallback",
    };
  }
  return {
    location_id: "unknown-internet",
    label: "Unknown Internet",
    latitude: 20,
    longitude: 0,
    accuracy: "unknown",
    source: "fallback",
  };
}

function normalizeIpForTrafficMap(remoteIp: string): string {
  const trimmed = remoteIp.trim().toLowerCase();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

function isPrivateIp(ip: string): boolean {
  if (ip === "unknown") {
    return false;
  }
  if (
    ip === "10" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80:")
  ) {
    return true;
  }
  const parts = ip.split(".").map((part) => Number(part));
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part)) &&
    ((parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 169 && parts[1] === 254))
  );
}

function isReservedDocumentationIp(ip: string): boolean {
  return (
    ip.startsWith("192.0.2.") ||
    ip.startsWith("198.51.100.") ||
    ip.startsWith("203.0.113.")
  );
}

function mergeCounters(
  target: RelayTrafficCounters,
  source: RelayTrafficCounters,
): void {
  target.bytes_in += source.bytes_in;
  target.bytes_out += source.bytes_out;
  target.messages_in += source.messages_in;
  target.messages_out += source.messages_out;
  mergeCounterMap(target.messages_in_by_type, source.messages_in_by_type);
  mergeCounterMap(target.messages_out_by_type, source.messages_out_by_type);
}

function mergeCounterMap(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
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
