import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import {
  createMessage,
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
  type MessageEnvelope,
  type AppInfoPayload,
  type TunnelUpgradeOfferPayload,
} from "@omniwork/protocol-ts";
import { loadRelayServerConfig } from "../src/config.ts";
import { RelayServer, resolveRemoteIp } from "../src/relayServer.ts";
import { RelayStateStore } from "../src/relayStateStore.ts";
import {
  readRelayAdminAsset,
  renderRelayAdminLoginPage,
  renderRelayAdminPage,
} from "../src/adminPage.ts";
import type {
  RelayConnection,
  RelayConnectionLocation,
} from "../src/relayTypes.ts";

{
  const config = loadRelayServerConfig({
    OMNIWORK_RELAY_HOST: "127.0.0.1",
  });

  assert.equal(config.admin.tokenDir, join(process.cwd(), ".omniwork-relay"));
  assert.equal(
    config.admin.controlsDbPath,
    join(process.cwd(), ".omniwork-relay", "admin-controls.sqlite"),
  );
  assert.equal(config.admin.webEnabled, false);
}

{
  const config = loadRelayServerConfig({
    OMNIWORK_RELAY_HOST: "127.0.0.1",
    OMNIWORK_RELAY_ADMIN_WEB_ENABLED: "true",
  });

  assert.equal(config.admin.webEnabled, true);
}

{
  const config = loadRelayServerConfig({
    OMNIWORK_RELAY_HOST: "127.0.0.1",
    OMNIWORK_RELAY_RUNTIME_DIR: "/tmp/omniwork-relay-runtime",
  });

  assert.equal(config.admin.tokenDir, "/tmp/omniwork-relay-runtime");
  assert.equal(
    config.admin.controlsDbPath,
    "/tmp/omniwork-relay-runtime/admin-controls.sqlite",
  );
}

// X-Forwarded-For 只有来自可信 proxy 时才可作为客户端 IP，避免直连伪造。
{
  const request = {
    headers: { "x-forwarded-for": "203.0.113.50" },
  } as unknown as IncomingMessage;
  const socket = { remoteAddress: "198.51.100.10" } as Socket;

  assert.deepEqual(
    resolveRemoteIp(request, socket, {
      trustProxy: false,
      trustedProxyIps: new Set(["198.51.100.10"]),
    }),
    { ip: "198.51.100.10", source: "socket_remote_address" },
  );
  assert.deepEqual(
    resolveRemoteIp(request, socket, {
      trustProxy: true,
      trustedProxyIps: new Set(["198.51.100.10"]),
    }),
    { ip: "203.0.113.50", source: "x_forwarded_for" },
  );
}

interface FakeSocket {
  sent: MessageEnvelope[];
  closed: { code?: number; reason?: string }[];
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: () => void): () => void;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

// Admin Web 只有一份源码：生产默认 /admin/，relay dev 渲染时注入 /admin/web。
{
  const rootAdminHtml = join(process.cwd(), "web/admin/index.html");
  const packageAdminHtml = join(process.cwd(), "../../web/admin/index.html");
  const sourceHtml = readFileSync(
    existsSync(rootAdminHtml) ? rootAdminHtml : packageAdminHtml,
    "utf8",
  );
  assert.match(sourceHtml, /data-admin-base="\/admin\/"/);
  assert.match(sourceHtml, /data-admin-login="\/admin\/login\.html"/);
  assert.doesNotMatch(sourceHtml, /\/admin\/web/);

  const html = renderRelayAdminPage();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /OmniWork Relay/);
  assert.match(html, /data-admin-base="\/admin\/web"/);
  assert.match(html, /data-admin-login="\/admin\/web"/);
  assert.match(html, /\/admin\/api\/status/);
  assert.match(html, /\/admin\/api\/agents/);
  assert.match(html, /\/admin\/api\/traffic-map/);
  assert.match(html, /world-land-110m\.geojson/);
  assert.match(html, /\/admin\/api\/agent-connections/);
  assert.match(html, /\/admin\/api\/controls\/agents\/agent-op/);
  assert.match(html, /\/admin\/api\/controls\/ip-bans/);
  assert.doesNotMatch(html, /localStorage/);
  assert.doesNotMatch(html, /Authorization: Bearer/);
  const loginHtml = renderRelayAdminLoginPage();
  assert.match(loginHtml, /Relay Admin Login/);
  assert.match(loginHtml, /data-admin-base="\/admin\/web"/);
  assert.match(loginHtml, /\/admin\/api\/login/);
  const worldLand = readRelayAdminAsset("world-land-110m.geojson");
  assert.ok(worldLand);
  assert.equal(worldLand.contentType, "application/geo+json; charset=utf-8");
  assert.match(worldLand.body.toString("utf8", 0, 80), /FeatureCollection/);
}

// 生产默认不暴露 Node 内置 admin web，但 admin API 始终由 Relay 提供。
{
  const server = createServer();
  const internals = server as unknown as {
    admin: {
      matches(pathname: string): boolean;
    };
  };

  assert.equal(internals.admin.matches("/admin/web"), false);
  assert.equal(
    internals.admin.matches("/admin/web/world-land-110m.geojson"),
    false,
  );
  assert.equal(internals.admin.matches("/admin/api/status"), true);
}

type TestRelayConnection = {
  id: string;
  endpoint: "agent" | "mobile";
  role: "unknown" | "agent" | "mobile";
  state:
    | "socket_connected"
    | "registered_agent"
    | "mobile_connected"
    | "relay_pairing_verified"
    | "e2e_handshaking"
    | "e2e_ready"
    | "closed";
  socket: FakeSocket;
  authenticated: boolean;
  remoteIp: string;
  location?: RelayConnectionLocation;
  connectedAt: number;
  lastSeenAt: number;
  authState: "none" | "pending" | "verified" | "failed";
  transportPath: "relay" | "p2p" | "mixed" | "unknown";
  deviceId?: string;
  agentInstanceId?: string;
  keyId?: string;
  businessSecurityMode?: "e2e_required" | "plaintext_allowed";
  e2e?: typeof E2E_SUPPORT_V1;
  appInfo?: {
    instanceId: AppInfoPayload["instance_id"];
    runtimeId: AppInfoPayload["runtime_id"];
    device?: AppInfoPayload["device"];
    app?: AppInfoPayload["app"];
  };
  agentE2EPeers?: Map<
    string,
    { handshakeId: string; transcriptHash?: string; state: "ready" }
  >;
  e2eHandshakeId?: string;
  e2eTranscriptHash?: string;
};

type TestAgentConnection = TestRelayConnection & {
  role: "agent";
  deviceId: string;
  agentInstanceId: string;
};

// 入站协议边界必须拒绝已知类型的畸形 payload，避免后续业务逻辑依赖类型断言。
{
  const server = createServer();
  const mobileSocket = createFakeSocket();
  const mobile = {
    id: "conn_mobile_invalid",
    endpoint: "mobile",
    role: "unknown",
    state: "socket_connected",
    socket: mobileSocket,
    authenticated: false,
    remoteIp: "127.0.0.1",
  };

  const internals = server as unknown as {
    handleRawMessage(connection: unknown, raw: string): void;
  };
  const malformed = createMessage("mobile.connect", {
    v: PROTOCOL_SUPPORT_V1.current,
    device_id: "device_1",
    protocol: PROTOCOL_SUPPORT_V1,
    e2e: E2E_SUPPORT_V1,
  });

  internals.handleRawMessage(mobile, JSON.stringify(malformed));

  assert.deepEqual(mobileSocket.closed[0], {
    code: 1003,
    reason: "invalid protocol message",
  });
}

// Relay Admin API 的只读统计应展示当前 Agent 数和每个 Agent 下的 App 数。
{
  const server = createServer();
  const agent = createAgentConnection("conn_agent_admin", "device_admin");
  const mobile = createMobileConnection("conn_mobile_admin", "device_admin", {
    instanceId: "app-1",
    runtimeId: "runtime-1",
    device: {
      platform: "ios",
    },
    app: {
      name: "OmniWork",
      version: "0.1.0",
    },
  });
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    agentsByDevice: Map<string, Set<unknown>>;
    primaryAgentByDevice: Map<string, unknown>;
    mobilesByDevice: Map<string, Set<unknown>>;
    state: {
      registerConnection(connection: TestRelayConnection): void;
      registerAgent(connection: TestAgentConnection): void;
      devicesSnapshot(): {
        summary: {
          device_count: number;
          agent_count: number;
          app_count: number;
          link_count: number;
        };
      };
      linksSnapshot(): { summary: { link_count: number } };
      trafficTop(): { connections: Array<{ connection_id: string }> };
      trafficMapSnapshot(): {
        locations: Array<{ location_id: string; connection_count: number }>;
        flows: Array<{
          app_to_agent_bytes: number;
          agent_to_app_bytes: number;
        }>;
        summary: {
          app_to_agent_bytes: number;
          agent_to_app_bytes: number;
        };
      };
      authenticateApp(
        app: TestRelayConnection,
        agent?: TestAgentConnection,
      ): void;
    };
    admin: {
      statusSnapshot(): {
        summary: {
          device_count: number;
          agent_count: number;
          app_count: number;
          link_count: number;
          connection_count: number;
        };
        traffic: { bytes_in: number; bytes_out: number };
      };
      agentsSnapshot(): {
        summary: { agent_count: number; app_count: number };
        agents: Array<{
          device_id: string;
          connection_id: string;
          agent_instance_id?: string;
          app_count: number;
        }>;
      };
      agentAppsSnapshot(connectionId: string): {
        connection_id: string;
        device_id?: string;
        agent_instance_id?: string;
        summary: { app_count: number };
        apps: Array<{ app_info?: AppInfoPayload; auth_state: string }>;
      };
    };
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(agent.deviceId, new Set([agent]));
  internals.primaryAgentByDevice.set(agent.deviceId, agent);
  internals.mobilesByDevice.set(agent.deviceId, new Set([mobile]));
  internals.state.registerConnection(agent);
  internals.state.registerConnection(mobile);
  internals.state.registerAgent(agent);
  internals.state.authenticateApp(mobile, agent);

  const agents = internals.admin.agentsSnapshot();
  const apps = internals.admin.agentAppsSnapshot(agent.id);
  const status = internals.admin.statusSnapshot();
  const devices = internals.state.devicesSnapshot();
  const links = internals.state.linksSnapshot();

  assert.equal(status.summary.device_count, 1);
  assert.equal(status.summary.connection_count, 2);
  assert.equal(status.summary.link_count, 1);
  assert.equal(status.summary.app_count, 1);
  assert.equal(status.traffic.bytes_in, 0);
  assert.equal(status.traffic.bytes_out, 0);
  assert.equal(devices.summary.device_count, 1);
  assert.equal(devices.summary.agent_count, 1);
  assert.equal(devices.summary.app_count, 1);
  assert.equal(devices.summary.link_count, 1);
  assert.equal(links.summary.link_count, 1);
  assert.equal(agents.summary.agent_count, 1);
  assert.equal(agents.summary.app_count, 1);
  assert.equal(agents.agents[0]?.device_id, "device_admin");
  assert.equal(agents.agents[0]?.connection_id, "conn_agent_admin");
  assert.equal(agents.agents[0]?.app_count, 1);
  assert.equal(apps.connection_id, "conn_agent_admin");
  assert.equal(apps.device_id, "device_admin");
  assert.equal(apps.summary.app_count, 1);
  assert.equal(apps.apps[0]?.app_info?.device?.platform, "ios");
  assert.equal(apps.apps[0]?.auth_state, "verified");
}

// 管理规则应立即关闭已在线 Agent 以及其下 App 连接。
{
  const server = createServer();
  const agent = createAgentConnection("conn_agent_disabled", "device_disabled");
  const mobile = createMobileConnection(
    "conn_mobile_disabled",
    "device_disabled",
  );
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    agentsByDevice: Map<string, Set<unknown>>;
    primaryAgentByDevice: Map<string, unknown>;
    mobilesByDevice: Map<string, Set<unknown>>;
    state: {
      registerAgent(connection: TestAgentConnection): void;
      authenticateApp(
        app: TestRelayConnection,
        agent?: TestAgentConnection,
      ): void;
    };
    admin: {
      disableAgentInstance(agentInstanceId: string, rule: unknown): void;
    };
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(agent.deviceId, new Set([agent]));
  internals.primaryAgentByDevice.set(agent.deviceId, agent);
  internals.mobilesByDevice.set(agent.deviceId, new Set([mobile]));
  internals.state.registerAgent(agent);
  internals.state.authenticateApp(mobile, agent);

  internals.admin.disableAgentInstance(agent.agentInstanceId, {
    id: "rule-1",
    createdAt: Date.now(),
    reason: "maintenance",
  });

  assert.deepEqual(agent.socket.closed[0], {
    code: 4403,
    reason: "agent_disabled",
  });
  assert.deepEqual(mobile.socket.closed[0], {
    code: 4403,
    reason: "agent_disabled",
  });
}

// IP 封禁应立即关闭匹配来源 IP 的现有连接。
{
  const server = createServer();
  const agent = createAgentConnection("conn_agent_banned_ip", "device_ip");
  agent.remoteIp = "203.0.113.10";
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    admin: {
      banIp(ip: string, rule: unknown): void;
    };
  };
  internals.connections.set(agent.id, agent);

  internals.admin.banIp("203.0.113.10", {
    id: "rule-2",
    createdAt: Date.now(),
  });

  assert.deepEqual(agent.socket.closed[0], {
    code: 4403,
    reason: "ip_banned",
  });
}

// Relay 控制面按连接、设备、链接三个层级累计 envelope 流量，不解析业务 payload。
{
  const state = new RelayStateStore();
  const agent = createAgentConnection("conn_agent_traffic", "device_traffic");
  const mobile = createMobileConnection(
    "conn_mobile_traffic",
    "device_traffic",
  );
  const relayAgent = agent as unknown as RelayConnection;
  const relayMobile = mobile as unknown as RelayConnection;
  state.registerConnection(relayAgent);
  state.registerConnection(relayMobile);
  state.registerAgent(relayAgent);
  state.authenticateApp(relayMobile, relayAgent);

  state.recordIngress(
    relayMobile,
    {
      type: "e2e.message",
      payload: {},
      device_id: mobile.deviceId,
      app_connection_id: mobile.id,
    } as MessageEnvelope,
    128,
  );
  state.recordEgress(
    relayAgent,
    {
      type: "e2e.message",
      payload: {},
      device_id: agent.deviceId,
      app_connection_id: mobile.id,
    } as MessageEnvelope,
    256,
  );

  const runtime = state.runtimeSnapshot();
  const links = state.linksSnapshot();
  const trafficMap = state.trafficMapSnapshot();
  assert.equal(runtime.traffic.bytes_in, 128);
  assert.equal(runtime.traffic.bytes_out, 256);
  assert.equal(links.links[0]?.counters.bytes_in, 128);
  assert.equal(links.links[0]?.counters.bytes_out, 256);
  assert.equal(trafficMap.summary.app_to_agent_bytes, 128);
  assert.equal(trafficMap.summary.agent_to_app_bytes, 0);
  assert.equal(trafficMap.nodes.length, 2);
  assert.equal(trafficMap.locations.length, 2);
  assert.equal(trafficMap.flows[0]?.app_to_agent_bytes, 128);

  state.recordIngress(
    relayAgent,
    {
      type: "terminal.frame",
      payload: {},
      device_id: agent.deviceId,
      app_connection_id: mobile.id,
    } as MessageEnvelope,
    512,
  );

  assert.equal(state.trafficMapSnapshot().summary.agent_to_app_bytes, 512);
}

// 地图节点和流量边按位置聚合，连接/link 只是聚合输入。
{
  const state = new RelayStateStore();
  const appLocation: RelayConnectionLocation = {
    location_id: "city:sg:unknown:singapore",
    label: "Singapore",
    latitude: 1.35,
    longitude: 103.82,
    source: "geoip",
    accuracy: "city",
    country_code: "SG",
    country: "Singapore",
    city: "Singapore",
  };
  const agentLocation: RelayConnectionLocation = {
    location_id: "city:cn:shanghai:shanghai",
    label: "Shanghai, China",
    latitude: 31.23,
    longitude: 121.47,
    source: "geoip",
    accuracy: "city",
    country_code: "CN",
    country: "China",
    region: "Shanghai",
    city: "Shanghai",
  };
  for (const index of [1, 2]) {
    const agent = createAgentConnection(
      `conn_agent_aggregate_${index}`,
      `device_aggregate_${index}`,
    );
    const mobile = createMobileConnection(
      `conn_mobile_aggregate_${index}`,
      `device_aggregate_${index}`,
    );
    agent.location = agentLocation;
    mobile.location = appLocation;
    const relayAgent = agent as unknown as RelayConnection;
    const relayMobile = mobile as unknown as RelayConnection;
    state.registerConnection(relayAgent);
    state.registerConnection(relayMobile);
    state.registerAgent(relayAgent);
    state.authenticateApp(relayMobile, relayAgent);
    state.recordIngress(
      relayMobile,
      {
        type: "e2e.message",
        payload: {},
        device_id: mobile.deviceId,
        app_connection_id: mobile.id,
      } as MessageEnvelope,
      index * 100,
    );
  }

  const trafficMap = state.trafficMapSnapshot();
  assert.equal(trafficMap.nodes.length, 2);
  assert.equal(trafficMap.summary.city_node_count, 2);
  assert.equal(trafficMap.flows.length, 1);
  assert.equal(trafficMap.flows[0]?.link_count, 2);
  assert.equal(trafficMap.flows[0]?.device_count, 2);
  assert.equal(trafficMap.flows[0]?.app_to_agent_bytes, 300);
  assert.deepEqual(trafficMap.flows[0]?.transport_paths, { relay: 2 });
}

function createFakeSocket(): FakeSocket {
  return {
    sent: [],
    closed: [],
    onMessage: () => () => {},
    onClose: () => () => {},
    sendText(message: string): void {
      this.sent.push(JSON.parse(message) as MessageEnvelope);
    },
    close(code?: number, reason?: string): void {
      this.closed.push({ code, reason });
    },
  };
}

function createAgentConnection(
  id: string,
  deviceId: string,
): TestAgentConnection {
  return {
    id,
    endpoint: "agent",
    role: "agent",
    state: "registered_agent",
    socket: createFakeSocket(),
    deviceId,
    agentInstanceId: `${id}_instance`,
    keyId: "key_1",
    businessSecurityMode: "e2e_required",
    e2e: E2E_SUPPORT_V1,
    authenticated: true,
    remoteIp: "127.0.0.1",
    connectedAt: 1000,
    lastSeenAt: 2000,
    authState: "verified",
    transportPath: "relay",
  };
}

function createMobileConnection(
  id: string,
  deviceId: string,
  appInfo: TestRelayConnection["appInfo"] = {
    instanceId: "app-default",
    runtimeId: "runtime-default",
  },
): TestRelayConnection {
  return {
    id,
    endpoint: "mobile",
    role: "mobile",
    state: "e2e_ready",
    socket: createFakeSocket(),
    deviceId,
    authenticated: true,
    remoteIp: "198.51.100.10",
    connectedAt: 1100,
    lastSeenAt: 2100,
    authState: "verified",
    transportPath: "relay",
    appInfo,
  };
}

function createServer(): RelayServer {
  return new RelayServer(
    loadRelayServerConfig({
      OMNIWORK_RELAY_HOST: "127.0.0.1",
      OMNIWORK_UPGRADE_PROPOSE_DELAY_MS: "1",
      OMNIWORK_UPGRADE_ICE_SERVERS_JSON: "[]",
    }),
  );
}

// P2P upgrade 信令是控制面消息：E2E ready 后必须允许明文透传，
// 否则 prefer_p2p 会在 offer/answer/candidate 阶段被 Relay 自己阻断。
{
  const server = createServer();
  const agentSocket = createFakeSocket();
  const mobileSocket = createFakeSocket();
  const appConnectionId = "conn_mobile_1";
  const deviceId = "device_1";
  const handshakeId = "handshake_1";
  const transcriptHash = "hash_1";

  const agent = {
    id: "conn_agent_1",
    endpoint: "agent",
    role: "agent",
    state: "registered_agent",
    socket: agentSocket,
    deviceId,
    keyId: "key_1",
    businessSecurityMode: "e2e_required",
    e2e: E2E_SUPPORT_V1,
    authenticated: true,
    remoteIp: "127.0.0.1",
    agentE2EPeers: new Map([
      [
        appConnectionId,
        {
          handshakeId,
          transcriptHash,
          state: "ready",
        },
      ],
    ]),
  };
  const mobile = {
    id: appConnectionId,
    endpoint: "mobile",
    role: "mobile",
    state: "e2e_ready",
    socket: mobileSocket,
    deviceId,
    authenticated: true,
    remoteIp: "127.0.0.1",
    e2eHandshakeId: handshakeId,
    e2eTranscriptHash: transcriptHash,
  };

  const internals = server as unknown as {
    connections: Map<string, unknown>;
    agentsByDevice: Map<string, Set<unknown>>;
    primaryAgentByDevice: Map<string, unknown>;
    handleRawMessage(connection: unknown, raw: string): void;
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(deviceId, new Set([agent]));
  internals.primaryAgentByDevice.set(deviceId, agent);

  const offer = createMessage<TunnelUpgradeOfferPayload>(
    "tunnel.upgrade.offer",
    {
      upgrade_id: "upgrade_1",
      app_connection_id: appConnectionId,
      sdp: "v=0\r\n",
    },
    { device_id: deviceId },
  );

  internals.handleRawMessage(mobile, JSON.stringify(offer));

  assert.equal(mobileSocket.sent.length, 0);
  assert.equal(agentSocket.sent.length, 1);
  assert.equal(agentSocket.sent[0]?.type, "tunnel.upgrade.offer");
  assert.equal(agentSocket.sent[0]?.app_connection_id, appConnectionId);
}

// Agent 请求 Relay 回源投递时只能提供内容；目标 App 由 Relay 根据此前转发的请求决定。
{
  const server = createServer();
  const agent = createAgentConnection("conn_agent_delivery", "device_delivery");
  const mobile = createMobileConnection(
    "conn_mobile_delivery",
    "device_delivery",
  );
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    agentsByDevice: Map<string, Set<unknown>>;
    primaryAgentByDevice: Map<string, unknown>;
    handleRawMessage(connection: unknown, raw: string): void;
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(agent.deviceId, new Set([agent]));
  internals.primaryAgentByDevice.set(agent.deviceId, agent);

  const request = createMessage(
    "terminal.input",
    { kind: "text", data: "pwd\n" },
    { id: "msg_plaintext_request", device_id: agent.deviceId },
  );
  internals.handleRawMessage(mobile, JSON.stringify(request));

  assert.equal(agent.socket.sent[0]?.type, "terminal.input");
  assert.equal(agent.socket.sent[0]?.app_connection_id, mobile.id);
  const relayContextId = agent.socket.sent[0]?.relay_context_id;
  assert.equal(typeof relayContextId, "string");

  const deliver = createMessage(
    "relay.app.deliver",
    {
      relay_context_id: relayContextId,
      message: {
        type: "protocol.error",
        payload: {
          v: PROTOCOL_SUPPORT_V1.current,
          code: "plaintext_business_rejected",
          detail: "plaintext rejected",
          retryable: false,
        },
      },
    },
    { device_id: agent.deviceId },
  );
  internals.handleRawMessage(agent, JSON.stringify(deliver));

  assert.equal(mobile.socket.sent.length, 1);
  assert.equal(mobile.socket.sent[0]?.type, "protocol.error");
  assert.equal(mobile.socket.sent[0]?.app_connection_id, mobile.id);
  assert.equal(
    (mobile.socket.sent[0]?.payload as { code?: string }).code,
    "plaintext_business_rejected",
  );
}

// Relay 回源句柄绑定到接收原始 App 请求的 Agent 连接，其他 Agent 不能消费。
{
  const server = createServer();
  const agent = createAgentConnection("conn_agent_owner", "device_owner");
  const otherAgent = createAgentConnection("conn_agent_other", "device_owner");
  const mobile = createMobileConnection("conn_mobile_owner", "device_owner");
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    agentsByDevice: Map<string, Set<unknown>>;
    primaryAgentByDevice: Map<string, unknown>;
    handleRawMessage(connection: unknown, raw: string): void;
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(otherAgent.id, otherAgent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(agent.deviceId, new Set([agent, otherAgent]));
  internals.primaryAgentByDevice.set(agent.deviceId, agent);

  const request = createMessage(
    "terminal.input",
    { kind: "text", data: "pwd\n" },
    { id: "msg_plaintext_owner", device_id: agent.deviceId },
  );
  internals.handleRawMessage(mobile, JSON.stringify(request));
  const relayContextId = agent.socket.sent[0]?.relay_context_id;
  assert.equal(typeof relayContextId, "string");

  const deliver = createMessage(
    "relay.app.deliver",
    {
      relay_context_id: relayContextId,
      message: {
        type: "protocol.error",
        payload: {
          v: PROTOCOL_SUPPORT_V1.current,
          code: "plaintext_business_rejected",
          retryable: false,
        },
      },
    },
    { device_id: otherAgent.deviceId },
  );
  internals.handleRawMessage(otherAgent, JSON.stringify(deliver));

  assert.equal(mobile.socket.sent.length, 0);
  assert.equal(otherAgent.socket.sent.length, 1);
  assert.equal(otherAgent.socket.sent[0]?.type, "protocol.error");
  assert.equal(
    (otherAgent.socket.sent[0]?.payload as { code?: string }).code,
    "route_not_found",
  );
}
