import { strict as assert } from "node:assert";
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
import { RelayServer } from "../src/relayServer.ts";
import {
  renderRelayAdminLoginPage,
  renderRelayAdminPage,
} from "../src/adminPage.ts";

{
  const config = loadRelayServerConfig({
    OMNIWORK_RELAY_HOST: "127.0.0.1",
  });

  assert.equal(config.admin.tokenDir, join(process.cwd(), ".omniwork-relay"));
  assert.equal(
    config.admin.controlsDbPath,
    join(process.cwd(), ".omniwork-relay", "admin-controls.sqlite"),
  );
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

interface FakeSocket {
  sent: MessageEnvelope[];
  closed: { code?: number; reason?: string }[];
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: () => void): () => void;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

// Relay Admin 页面作为静态资源管理，必须能被 server 读取并包含关键 API。
{
  const html = renderRelayAdminPage();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /OmniWork Relay/);
  assert.match(html, /\/admin\/api\/status/);
  assert.match(html, /\/admin\/api\/agents/);
  assert.match(html, /\/admin\/api\/agent-connections/);
  assert.match(html, /\/admin\/api\/controls\/agents\/agent-op/);
  assert.match(html, /\/admin\/api\/controls\/ip-bans/);
  assert.doesNotMatch(html, /localStorage/);
  assert.doesNotMatch(html, /Authorization: Bearer/);
  const loginHtml = renderRelayAdminLoginPage();
  assert.match(loginHtml, /Relay Admin Login/);
  assert.match(loginHtml, /\/admin\/api\/login/);
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
    name?: string;
    platform?: AppInfoPayload["platform"];
    version?: string;
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
    name: "OmniWork",
    platform: "ios",
    version: "0.1.0",
  });
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    agentsByDevice: Map<string, unknown>;
    mobilesByDevice: Map<string, Set<unknown>>;
    admin: {
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
  internals.agentsByDevice.set(agent.deviceId, agent);
  internals.mobilesByDevice.set(agent.deviceId, new Set([mobile]));

  const agents = internals.admin.agentsSnapshot();
  const apps = internals.admin.agentAppsSnapshot(agent.id);

  assert.equal(agents.summary.agent_count, 1);
  assert.equal(agents.summary.app_count, 1);
  assert.equal(agents.agents[0]?.device_id, "device_admin");
  assert.equal(agents.agents[0]?.connection_id, "conn_agent_admin");
  assert.equal(agents.agents[0]?.app_count, 1);
  assert.equal(apps.connection_id, "conn_agent_admin");
  assert.equal(apps.device_id, "device_admin");
  assert.equal(apps.summary.app_count, 1);
  assert.equal(apps.apps[0]?.app_info?.platform, "ios");
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
    agentsByDevice: Map<string, unknown>;
    mobilesByDevice: Map<string, Set<unknown>>;
    admin: {
      disableAgentInstance(agentInstanceId: string, rule: unknown): void;
    };
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(agent.deviceId, agent);
  internals.mobilesByDevice.set(agent.deviceId, new Set([mobile]));

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
    agentsByDevice: Map<string, unknown>;
    handleRawMessage(connection: unknown, raw: string): void;
  };
  internals.connections.set(agent.id, agent);
  internals.connections.set(mobile.id, mobile);
  internals.agentsByDevice.set(deviceId, agent);

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
