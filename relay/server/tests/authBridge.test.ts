import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  E2E_SUPPORT_V2,
  PROTOCOL_SUPPORT_V2,
  createMessage,
  generateIdentityKeyPair,
  type AuthChallengePayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import { AppAdmission } from "../src/app-agent/appAdmission.ts";
import { AppAuthBridge } from "../src/app-agent/authBridge.ts";
import type { PendingAuth, RelayConnection } from "../src/relayTypes.ts";

test("mobile admission resolves the Agent key from the online connection", () => {
  const agentIdentity = generateIdentityKeyPair("agent");
  const appIdentity = generateIdentityKeyPair("app");
  const pendingAuth = new Map<string, PendingAuth>();
  const sent: MessageEnvelope[] = [];
  const mobile = {
    id: "conn_app_1",
    role: "unknown",
    remoteIp: "203.0.113.10",
  } as RelayConnection;
  const agent = {
    id: "conn_agent_1",
    role: "agent",
    deviceId: agentIdentity.id,
    devicePublicKey: agentIdentity.publicKey,
  } as RelayConnection;
  const admission = new AppAdmission({
    config: {
      state: { pendingAuthTtlMs: 60_000 },
    } as never,
    authGuard: {
      authorize: () => ({ ok: true }),
    } as never,
    authExecutor: {} as never,
    topology: {
      getPrimaryAgent: () => agent,
    } as never,
    state: {
      registerApp: () => undefined,
    } as never,
    pendingAuth,
    send: (_connection, message) => sent.push(message),
  });

  admission.handleMobileConnect(
    mobile,
    createMessage("mobile.connect", {
      v: 2,
      device_id: agentIdentity.id,
      app_id: appIdentity.id,
      app_public_key: appIdentity.publicKey,
      app_info: {
        instance_id: appIdentity.id,
        runtime_id: "runtime_1",
      },
      protocol: PROTOCOL_SUPPORT_V2,
      e2e: E2E_SUPPORT_V2,
    }),
  );

  assert.equal(pendingAuth.get(mobile.id)?.agentPublicKey, agentIdentity.publicKey);
  assert.equal(sent.at(-1)?.type, "auth.challenge");
  assert.equal(
    (sent.at(-1)?.payload as AuthChallengePayload).agent_public_key,
    agentIdentity.publicKey,
  );
});

test("auth.pending extends Relay state to the Agent approval deadline", () => {
  const pendingAuth = new Map<string, PendingAuth>([
    [
      "conn_app_1",
      {
        deviceId: "device_1",
        agentPublicKey: "agent_public_key",
        appId: "app_1",
        appPublicKey: "app_public_key",
        agentConnectionId: "conn_agent_1",
        nonce: "nonce_1",
        appInfo: {
          instanceId: "app_instance_1",
          runtimeId: "runtime_1",
        },
        expiresAt: 1,
      },
    ],
  ]);
  const sent: MessageEnvelope[] = [];
  const mobile = {
    id: "conn_app_1",
    role: "mobile",
    deviceId: "device_1",
  } as RelayConnection;
  const agent = {
    id: "conn_agent_1",
    role: "agent",
    deviceId: "device_1",
  } as RelayConnection;
  const bridge = new AppAuthBridge({
    config: {} as never,
    topology: {
      getConnection: (id: string) => (id === mobile.id ? mobile : undefined),
    } as never,
    state: {} as never,
    pendingAuth,
    authLimiter: {} as never,
    send: (_connection, message) => sent.push(message),
  });
  const expiresAt = "2100-01-01T00:00:00.000Z";

  bridge.handleAuthResult(
    agent,
    createMessage("auth.pending", {
      connection_id: mobile.id,
      request_id: "request_1",
      expires_at: expiresAt,
    }),
  );

  assert.equal(pendingAuth.get(mobile.id)?.expiresAt, Date.parse(expiresAt));
  assert.equal(pendingAuth.get(mobile.id)?.approvalPending, true);
  assert.equal(sent.at(-1)?.type, "auth.pending");
});
