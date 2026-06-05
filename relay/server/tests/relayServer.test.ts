import { strict as assert } from "node:assert";

import {
  createMessage,
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
  type MessageEnvelope,
  type TunnelUpgradeOfferPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import { loadRelayServerConfig } from "../src/config.ts";
import { RelayServer } from "../src/relayServer.ts";

interface FakeSocket {
  sent: MessageEnvelope[];
  closed: { code?: number; reason?: string }[];
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: () => void): () => void;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

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
