import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  E2E_SUPPORT_V1,
  RELAY_AGENT_IP_BANNED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
  PROTOCOL_SUPPORT_V1,
  createMessage,
  type AgentHelloPayload,
  type MobileConnectPayload,
} from "@omniwork/protocol-ts";

import { relayDeviceSignaturePayload } from "../src/relayDeviceSignature.ts";
import type {
  RelayAuthDevice,
  RelayAuthUser,
} from "../src/relayUserAuthStore.ts";
import { RelayAuthGuard } from "../src/auth/guard.ts";
import { AgentControlPolicy } from "../src/auth/policies/agentControlPolicy.ts";
import { AgentEmailLinkPolicy } from "../src/auth/policies/agentEmailLinkPolicy.ts";
import { IpBanPolicy } from "../src/auth/policies/ipBanPolicy.ts";
import { MobileEmailLinkPolicy } from "../src/auth/policies/mobileEmailLinkPolicy.ts";

{
  const guard = createRelayWsGuard(() => ({ reason: "test" }));
  const decision = guard.authorize({
    surface: "relay_ws_upgrade",
    endpoint: "agent",
    remoteIp: "203.0.113.10",
  });

  assert.deepEqual(decision, {
    ok: false,
    reason: "ip_banned",
    action: {
      kind: "close_ws",
      code: RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
      reason: RELAY_AGENT_IP_BANNED_CLOSE_REASON,
    },
    audit: {
      surface: "relay_ws_upgrade",
      endpoint: "agent",
      remoteIp: "203.0.113.10",
    },
  });
}

{
  const guard = createRelayWsGuard(() => ({ reason: "test" }));
  const decision = guard.authorize({
    surface: "relay_ws_upgrade",
    endpoint: "mobile",
    remoteIp: "203.0.113.10",
  });

  assert.deepEqual(decision, {
    ok: false,
    reason: "ip_banned",
    action: {
      kind: "reject_http",
      statusCode: 403,
      message: "ip_banned",
    },
    audit: {
      surface: "relay_ws_upgrade",
      endpoint: "mobile",
      remoteIp: "203.0.113.10",
    },
  });
}

{
  const guard = createRelayWsGuard(() => null);
  const decision = guard.authorize({
    surface: "relay_ws_upgrade",
    endpoint: "agent",
    remoteIp: "203.0.113.10",
  });

  assert.deepEqual(decision, { ok: true });
}

{
  const guard = createAgentHelloGuard({
    authMode: "none",
    activeDisabledAgentInstance: () => ({ reason: "test" }),
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", createAgentHello()),
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "agent_disabled");
    assert.deepEqual(decision.action, {
      kind: "close_ws",
      code: RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
      reason: "agent_disabled",
    });
  }
}

{
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => null,
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", createAgentHello()),
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "device_not_registered");
    assert.deepEqual(decision.action, {
      kind: "close_ws",
      code: 4403,
      reason: "device_not_registered",
    });
  }
}

{
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => ({
      id: "device-1",
      user_id: "user-1",
      public_key: "invalid",
      created_at: 1,
    }),
    rememberNonce: () => true,
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", createAgentHello()),
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "invalid_signature");
    assert.equal(decision.action.kind, "close_ws");
    if (decision.action.kind === "close_ws") {
      assert.equal(decision.action.reason, "missing_relay_auth");
    }
  }
}

{
  const { hello, publicKey } = createSignedAgentHello();
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => ({
      id: "device-1",
      user_id: "user-1",
      public_key: publicKey,
      created_at: 1,
    }),
    rememberNonce: () => false,
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", hello),
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "replayed_nonce");
  }
}

{
  const { hello, publicKey } = createSignedAgentHello();
  let seenDeviceId: string | null = null;
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => ({
      id: "device-1",
      user_id: "user-1",
      public_key: publicKey,
      created_at: 1,
    }),
    rememberNonce: () => true,
    markDeviceSeen: (deviceId) => {
      seenDeviceId = deviceId;
    },
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", hello),
  });

  assert.deepEqual(decision, {
    ok: true,
    subject: {
      userId: "user-1",
      deviceId: "device-1",
      agentInstanceId: "agent-1",
    },
  });
  assert.equal(seenDeviceId, "device-1");
}

{
  const guard = createMobileConnectGuard({
    authMode: "email_link",
    authenticateUserToken: () => null,
    getDevice: () => ({
      id: "device-1",
      user_id: "user-1",
      public_key: "unused",
      created_at: 1,
    }),
  });

  const decision = guard.authorize({
    surface: "mobile_connect",
    message: createMessage("mobile.connect", createMobileConnect()),
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "invalid_session");
    assert.deepEqual(decision.action, {
      kind: "send_auth_failed",
      authReason: "malformed_proof",
      retryAfterMs: 2000,
    });
  }
}

{
  const guard = createMobileConnectGuard({
    authMode: "email_link",
    authenticateUserToken: () => ({
      id: "user-2",
      email: "user@example.com",
      created_at: 1,
    }),
    getDevice: () => ({
      id: "device-1",
      user_id: "user-1",
      public_key: "unused",
      created_at: 1,
    }),
  });

  const decision = guard.authorize({
    surface: "mobile_connect",
    message: createMessage("mobile.connect", createMobileConnect()),
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "invalid_session");
  }
}

{
  const guard = createMobileConnectGuard({
    authMode: "email_link",
    authenticateUserToken: () => ({
      id: "user-1",
      email: "user@example.com",
      created_at: 1,
    }),
    getDevice: () => ({
      id: "device-1",
      user_id: "user-1",
      public_key: "unused",
      created_at: 1,
    }),
  });

  const decision = guard.authorize({
    surface: "mobile_connect",
    message: createMessage("mobile.connect", createMobileConnect()),
  });

  assert.deepEqual(decision, {
    ok: true,
    subject: {
      userId: "user-1",
      deviceId: "device-1",
    },
  });
}

console.log("auth guard tests passed");

function createConfig(authMode: "none" | "email_link") {
  return {
    auth: {
      mode: authMode,
      nonceTtlMs: 60_000,
    },
  } as never;
}

function createRelayWsGuard(activeIpBan: (ip: string) => unknown) {
  return new RelayAuthGuard({
    policies: {
      relayWsUpgrade: [new IpBanPolicy({ activeIpBan })],
    },
  });
}

function createAgentHelloGuard(options: {
  authMode: "none" | "email_link";
  activeDisabledAgentInstance?: (agentInstanceId: string) => unknown;
  getDevice?: (deviceId: string) => RelayAuthDevice | null;
  rememberNonce?: (deviceId: string, nonce: string, ttlMs: number) => boolean;
  markDeviceSeen?: (deviceId: string) => void;
}) {
  return new RelayAuthGuard({
    policies: {
      agentHello: [
        new AgentControlPolicy({
          activeDisabledAgentInstance:
            options.activeDisabledAgentInstance ?? (() => null),
        }),
        new AgentEmailLinkPolicy({
          config: createConfig(options.authMode),
          getDevice: options.getDevice ?? (() => null),
          rememberNonce: options.rememberNonce ?? (() => true),
          markDeviceSeen: options.markDeviceSeen ?? (() => {}),
        }),
      ],
    },
  });
}

function createMobileConnectGuard(options: {
  authMode: "none" | "email_link";
  authenticateUserToken?: (token: string | undefined) => RelayAuthUser | null;
  getDevice?: (deviceId: string) => RelayAuthDevice | null;
}) {
  return new RelayAuthGuard({
    policies: {
      mobileConnect: [
        new MobileEmailLinkPolicy({
          config: createConfig(options.authMode),
          authenticateUserToken: options.authenticateUserToken ?? (() => null),
          getDevice: options.getDevice ?? (() => null),
        }),
      ],
    },
  });
}

function createAgentHello(
  overrides: Partial<AgentHelloPayload> = {},
): AgentHelloPayload {
  return {
    v: 1,
    device_id: "device-1",
    agent_instance_id: "agent-1",
    key_id: "key-1",
    protocol: PROTOCOL_SUPPORT_V1,
    e2e: E2E_SUPPORT_V1,
    hostname: "host",
    platform: "darwin",
    agent_version: "0.1.0",
    capabilities: [],
    ...overrides,
  };
}

function createMobileConnect(
  overrides: Partial<MobileConnectPayload> = {},
): MobileConnectPayload {
  return {
    v: 1,
    device_id: "device-1",
    key_id: "key-1",
    app_info: {
      instance_id: "app-instance",
      runtime_id: "app-runtime",
    },
    protocol: PROTOCOL_SUPPORT_V1,
    e2e: E2E_SUPPORT_V1,
    session_token: "session-token",
    ...overrides,
  };
}

function createSignedAgentHello(): {
  hello: AgentHelloPayload;
  publicKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const timestamp = Date.now();
  const nonce = "nonce-12345678901234567890";
  const hello = createAgentHello({
    relay_auth: {
      method: "device_signature",
      timestamp,
      nonce,
      signature: sign(
        null,
        relayDeviceSignaturePayload({
          deviceId: "device-1",
          agentInstanceId: "agent-1",
          timestamp,
          nonce,
        }),
        privateKey,
      ).toString("base64url"),
    },
  });
  return {
    hello,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
