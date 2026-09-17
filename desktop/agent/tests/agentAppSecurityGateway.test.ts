import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SIGNATURE_DOMAINS,
  appAuthSignatureFields,
  createMessage,
  generateIdentityKeyPair,
  signIdentityFields,
  type AppAuthorizationScope,
  type AuthVerifyPayload,
  type MessageEnvelope,
  messageToInner,
  type E2EHandshakeReplyPayload,
} from "@omni-work/protocol-ts";
import { createInitiatorHandshake } from "@omni-work/e2e-noise";

import type { AgentConfig } from "../src/config/config.ts";
import { TrustedAppStore } from "../src/config/trustedAppStore.ts";
import { AgentAppSecurityGateway } from "../src/core/agentAppSecurityGateway.ts";
import { AppConnectionRegistry } from "../src/core/appConnectionRegistry.ts";
import type { Logger } from "../src/telemetry/logger.ts";
import type { AgentSessionTransport } from "../src/transport/index.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-security-gateway-"));
const agentIdentity = generateIdentityKeyPair("agent");
const appIdentity = generateIdentityKeyPair("app");
const trustedApps = new TrustedAppStore(join(dir, "trusted-apps-v2.json"));
const appConnections = new AppConnectionRegistry({
  heartbeatIntervalMs: 10_000,
  staleTimeoutMs: 30_000,
  disconnectTimeoutMs: 90_000,
});
const sent: MessageEnvelope[] = [];
const detached: string[] = [];
const transport = {
  send(message: MessageEnvelope) {
    sent.push(message);
  },
} as AgentSessionTransport;
const logger = {
  info() {},
  warn() {},
} as unknown as Logger;
const config = {
  deviceId: agentIdentity.id,
  identity: agentIdentity,
  appAuthorizationMode: "manual",
} as AgentConfig;
const gateway = new AgentAppSecurityGateway({
  config,
  logger,
  appConnections,
  trustedApps,
  getTransport: () => transport,
  getAgentConnectionId: () => "conn_agent_1",
  dispatchMessage: async () => undefined,
  onSupersededConnection: (connectionId) => detached.push(connectionId),
});

function createAuthVerify(
  connectionId: string,
  nonce: string,
): MessageEnvelope<AuthVerifyPayload> {
  const requestedScopes: AppAuthorizationScope[] = ["device.control"];
  const unsigned = {
    nonce,
    connection_id: connectionId,
    agent_connection_id: "conn_agent_1",
    device_id: agentIdentity.id,
    agent_public_key: agentIdentity.publicKey,
    app_id: appIdentity.id,
    app_public_key: appIdentity.publicKey,
    app_info: {
      instance_id: appIdentity.id,
      runtime_id: `runtime_${connectionId}`,
      device: {
        name: "Alice iPhone",
        platform: "ios" as const,
        os: "iOS",
        os_version: "26.0",
      },
      app: { name: "OmniWork", version: "0.1.1" },
    },
    requested_scopes: requestedScopes,
    timestamp: Date.now(),
    observations: [
      {
        source: "relay" as const,
        observed_at: new Date().toISOString(),
        network: {
          remote_ip: "8.8.8.8",
          ip_source: "socket_remote_address" as const,
        },
      },
    ],
  };
  return createMessage<AuthVerifyPayload>(
    "auth.verify",
    {
      ...unsigned,
      signature: signIdentityFields(
        appIdentity.privateKey,
        SIGNATURE_DOMAINS.appAuth,
        appAuthSignatureFields(unsigned),
      ),
    },
    {
      device_id: agentIdentity.id,
      app_connection_id: connectionId,
    },
  );
}

const staleAgentConnection = createAuthVerify(
  "conn_app_stale",
  "nonce_stale",
);
staleAgentConnection.payload.agent_connection_id = "conn_agent_stale";
gateway.handleAuthVerify(staleAgentConnection);
assert.equal(sent.at(-1)?.type, "auth.failed");
assert.equal(
  (sent.at(-1)?.payload as { reason?: string }).reason,
  "identity_mismatch",
);

gateway.handleAuthVerify(createAuthVerify("conn_app_1", "nonce_1"));
assert.equal(sent.at(-1)?.type, "auth.pending");
const [request] = gateway.listPendingPairings();
assert.ok(request);
assert.equal(request.appId, appIdentity.id);
assert.equal(request.appName, "OmniWork");
assert.equal(request.deviceName, "Alice iPhone");
assert.equal(request.platform, "ios");
assert.equal(request.os, "iOS");
assert.equal(request.osVersion, "26.0");
assert.equal(request.remoteIp, "8.8.8.8");
assert.equal(request.ipSource, "socket_remote_address");

gateway.handleAuthVerify(createAuthVerify("conn_app_1_retry", "nonce_1_retry"));
assert.equal(sent.at(-1)?.type, "auth.pending");
const [retriedRequest] = gateway.listPendingPairings();
assert.ok(retriedRequest);
assert.equal(gateway.listPendingPairings().length, 1);
assert.equal(retriedRequest.requestId, request.requestId);
assert.equal(retriedRequest.connectionId, "conn_app_1_retry");

assert.equal(gateway.approvePairing(retriedRequest.requestId), true);
assert.equal(sent.at(-1)?.type, "auth.ok");
assert.equal(trustedApps.get(appIdentity.id)?.status, "active");
assert.equal(
  appConnections.hasAuthenticatedConnection("conn_app_1_retry"),
  true,
);

gateway.handleAuthVerify(createAuthVerify("conn_app_2", "nonce_2"));
assert.equal(sent.at(-1)?.type, "auth.ok");
assert.deepEqual(detached, ["conn_app_1_retry"]);
assert.equal(appConnections.hasAuthenticatedConnection("conn_app_2"), true);

assert.equal(gateway.revokeApp(appIdentity.id), true);
assert.equal(sent.at(-1)?.type, "auth.failed");
assert.equal(
  (sent.at(-1)?.payload as { reason?: string }).reason,
  "revoked",
);
assert.deepEqual(detached, ["conn_app_1_retry", "conn_app_2"]);
assert.equal(appConnections.hasAuthenticatedConnection("conn_app_2"), false);
assert.equal(trustedApps.get(appIdentity.id)?.status, "revoked");

gateway.handleAuthVerify(createAuthVerify("conn_app_3", "nonce_3"));
assert.equal(sent.at(-1)?.type, "auth.pending");
const [reapproval] = gateway.listPendingPairings();
assert.ok(reapproval);
assert.equal(gateway.approvePairing(reapproval.requestId), true);
assert.equal(sent.at(-1)?.type, "auth.ok");
assert.equal(trustedApps.get(appIdentity.id)?.status, "active");

const handshake = await createInitiatorHandshake({
  deviceId: agentIdentity.id,
  agentPublicKey: agentIdentity.publicKey,
  appId: appIdentity.id,
  appPublicKey: appIdentity.publicKey,
  agentConnectionId: "conn_agent_1",
  appConnectionId: "conn_app_3",
  signApp: (fields) => signIdentityFields(
    appIdentity.privateKey, SIGNATURE_DOMAINS.e2eInit, fields,
  ),
});
gateway.handleE2EHandshakeInit(createMessage("e2e.handshake.init", handshake.init));
const reply = sent.filter((message) => message.type === "e2e.handshake.reply").at(-1);
assert.ok(reply);
const e2e = handshake.complete(reply.payload as E2EHandshakeReplyPayload);
gateway.handleE2EReady(createMessage("e2e.ready", e2e.readyPayload()));
appConnections.sweep(Date.now() + 100_000);
assert.equal(appConnections.hasAuthenticatedConnection("conn_app_3"), false);
const heartbeat = createMessage("app.connection.heartbeat", {
  sent_at: new Date().toISOString(), seq: 1, current_path: "relay",
});
await gateway.handleE2EMessage(createMessage(
  "e2e.message", e2e.encrypt(messageToInner(heartbeat)).payload,
));
assert.equal(appConnections.hasAuthenticatedConnection("conn_app_3"), true);
await gateway.handleE2EMessage(createMessage("e2e.message", {
  ...e2e.encrypt(messageToInner(heartbeat)).payload,
  ciphertext: "invalid!",
}));
assert.equal(sent.at(-1)?.type, "e2e.failed");
assert.equal(gateway.hasReadyE2EPeer("conn_app_3"), false);
assert.equal(appConnections.hasAuthenticatedConnection("conn_app_3"), false);

assert.equal(gateway.removeApp(appIdentity.id), true);
assert.equal(trustedApps.get(appIdentity.id), null);
assert.equal(appConnections.list().length, 0);
assert.equal(appConnections.devices().length, 0);
assert.equal(gateway.removeApp(appIdentity.id), false);

gateway.handleAuthVerify(createAuthVerify("conn_app_4", "nonce_4"));
assert.equal(sent.at(-1)?.type, "auth.pending");

const automaticTrustedApps = new TrustedAppStore(
  join(dir, "automatic-trusted-apps-v2.json"),
);
const automaticConnections = new AppConnectionRegistry({
  heartbeatIntervalMs: 10_000,
  staleTimeoutMs: 30_000,
  disconnectTimeoutMs: 90_000,
});
const automaticSent: MessageEnvelope[] = [];
const automaticGateway = new AgentAppSecurityGateway({
  config: { ...config, appAuthorizationMode: "automatic" },
  logger,
  appConnections: automaticConnections,
  trustedApps: automaticTrustedApps,
  getTransport: () =>
    ({
      send(message: MessageEnvelope) {
        automaticSent.push(message);
      },
    }) as AgentSessionTransport,
  getAgentConnectionId: () => "conn_agent_1",
  dispatchMessage: async () => undefined,
  onSupersededConnection: () => undefined,
});
automaticGateway.handleAuthVerify(
  createAuthVerify("conn_app_automatic", "nonce_automatic"),
);
assert.equal(automaticSent.at(-1)?.type, "auth.ok");
assert.equal(automaticGateway.listPendingPairings().length, 0);
assert.equal(automaticTrustedApps.get(appIdentity.id)?.status, "active");
assert.equal(
  automaticConnections.hasAuthenticatedConnection("conn_app_automatic"),
  true,
);

console.log("Agent App security gateway tests passed");
