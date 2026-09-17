import { strict as assert } from "node:assert";

import {
  E2E_SUPPORT_V2,
  PROTOCOL_VERSION,
  RELAY_AGENT_IP_BANNED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
  PROTOCOL_SUPPORT_V2,
  SIGNATURE_DOMAINS,
  agentRelayInitSignatureFields,
  agentRelayProofSignatureFields,
  createMessage,
  generateIdentityKeyPair,
  signIdentityFields,
  type AgentAuthInitPayload,
  type AgentHelloPayload,
  type MobileConnectPayload,
} from "@omni-work/protocol-ts";

import { createStatelessAgentAuthChallenge } from "../src/relayDeviceSignature.ts";
import type {
  RelayAuthDevice,
  RelayAuthUser,
} from "../src/relayUserAuthStore.ts";
import { RelayAuthGuard } from "../src/auth/guard.ts";
import { AgentControlPolicy } from "../src/auth/policies/agentControlPolicy.ts";
import { AgentDeviceIdentityPolicy } from "../src/auth/policies/agentDeviceIdentityPolicy.ts";
import { IpBanPolicy } from "../src/auth/policies/ipBanPolicy.ts";
import { MobileEmailLinkPolicy } from "../src/auth/policies/mobileEmailLinkPolicy.ts";

const CHALLENGE_SECRET = Buffer.from("auth-guard-test-secret");
const AGENT_CONNECTION_ID = "conn-agent-test";
const AGENT_REMOTE_IP = "203.0.113.20";
const AGENT_IDENTITY = generateIdentityKeyPair("agent");
const APP_IDENTITY = generateIdentityKeyPair("app");

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
    activeDisabledAgentDevice: () => ({ reason: "test" }),
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", createAgentHello()),
    connectionId: AGENT_CONNECTION_ID,
    remoteIp: AGENT_REMOTE_IP,
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
    connectionId: AGENT_CONNECTION_ID,
    remoteIp: AGENT_REMOTE_IP,
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
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: "invalid",
      created_at: 1,
    }),
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", createAgentHello()),
    connectionId: AGENT_CONNECTION_ID,
    remoteIp: AGENT_REMOTE_IP,
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "public_key_mismatch");
    assert.equal(decision.action.kind, "close_ws");
    if (decision.action.kind === "close_ws") {
      assert.equal(decision.action.reason, "public_key_mismatch");
    }
  }
}

{
  const { hello, publicKey } = createSignedAgentHello();
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => ({
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: publicKey,
      created_at: 1,
    }),
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", hello),
    connectionId: "other-connection",
    remoteIp: AGENT_REMOTE_IP,
  });

  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, "invalid_challenge");
  }
}

{
  const { hello, publicKey } = createSignedAgentHello();
  let seenDeviceId: string | null = null;
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => ({
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: publicKey,
      created_at: 1,
    }),
    markDeviceSeen: (deviceId) => {
      seenDeviceId = deviceId;
    },
  });

  const decision = guard.authorize({
    surface: "agent_hello",
    message: createMessage("agent.hello", hello),
    connectionId: AGENT_CONNECTION_ID,
    remoteIp: AGENT_REMOTE_IP,
  });

  assert.deepEqual(decision, {
    ok: true,
    subject: {
      userId: "user-1",
      deviceId: AGENT_IDENTITY.id,
    },
  });
  assert.equal(seenDeviceId, AGENT_IDENTITY.id);
}

{
  const { init, publicKey } = createSignedAgentAuthInit();
  const guard = createAgentHelloGuard({
    authMode: "email_link",
    getDevice: () => ({
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: publicKey,
      created_at: 1,
    }),
  });

  const decision = guard.authorize({
    surface: "agent_auth_init",
    message: createMessage("agent.auth.init", init),
    connectionId: AGENT_CONNECTION_ID,
    remoteIp: AGENT_REMOTE_IP,
  });

  assert.deepEqual(decision, {
    ok: true,
    subject: {
      userId: "user-1",
      deviceId: AGENT_IDENTITY.id,
    },
  });
}

{
  const guard = createMobileConnectGuard({
    authMode: "email_link",
    authenticateUserToken: () => null,
    getDevice: () => ({
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: AGENT_IDENTITY.publicKey,
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
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: AGENT_IDENTITY.publicKey,
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
      id: AGENT_IDENTITY.id,
      user_id: "user-1",
      public_key: AGENT_IDENTITY.publicKey,
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
      deviceId: AGENT_IDENTITY.id,
    },
  });
}

console.log("auth guard tests passed");

function createConfig(authMode: "none" | "email_link") {
  return {
    auth: {
      mode: authMode,
      agentAuthClockSkewMs: 60_000,
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
  activeDisabledAgentDevice?: (deviceId: string) => unknown;
  getDevice?: (deviceId: string) => RelayAuthDevice | null;
  markDeviceSeen?: (deviceId: string) => void;
}) {
  return new RelayAuthGuard({
    policies: {
      agentAuthInit: [
        new AgentDeviceIdentityPolicy({
          config: createConfig(options.authMode),
          challengeSecret: CHALLENGE_SECRET,
          getDevice: options.getDevice ?? (() => null),
          markDeviceSeen: options.markDeviceSeen ?? (() => {}),
        }),
      ],
      agentHello: [
        new AgentControlPolicy({
          activeDisabledAgentDevice:
            options.activeDisabledAgentDevice ?? (() => null),
        }),
        new AgentDeviceIdentityPolicy({
          config: createConfig(options.authMode),
          challengeSecret: CHALLENGE_SECRET,
          getDevice: options.getDevice ?? (() => null),
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
    v: PROTOCOL_VERSION,
    device_id: AGENT_IDENTITY.id,
    device_public_key: AGENT_IDENTITY.publicKey,
    relay_auth: {
      method: "device_signature",
      timestamp: Date.now(),
      challenge: "challenge-placeholder",
      signature: "signature-placeholder",
    },
    protocol: PROTOCOL_SUPPORT_V2,
    e2e: E2E_SUPPORT_V2,
    hostname: "host",
    platform: "darwin",
    system_type: "Darwin",
    uname: "Darwin host 25.6.0 Darwin Kernel Version 25.6.0 arm64",
    agent_version: "0.1.0",
    capabilities: [],
    ...overrides,
  };
}

function createMobileConnect(
  overrides: Partial<MobileConnectPayload> = {},
): MobileConnectPayload {
  return {
    v: PROTOCOL_VERSION,
    device_id: AGENT_IDENTITY.id,
    app_id: APP_IDENTITY.id,
    app_public_key: APP_IDENTITY.publicKey,
    app_info: {
      instance_id: "app-instance",
      runtime_id: "app-runtime",
    },
    protocol: PROTOCOL_SUPPORT_V2,
    e2e: E2E_SUPPORT_V2,
    session_token: "session-token",
    ...overrides,
  };
}

function createSignedAgentAuthInit(): {
  init: AgentAuthInitPayload;
  publicKey: string;
} {
  const timestamp = Date.now();
  const init: AgentAuthInitPayload = {
    v: PROTOCOL_VERSION,
    device_id: AGENT_IDENTITY.id,
    device_public_key: AGENT_IDENTITY.publicKey,
    timestamp,
    signature: signIdentityFields(
      AGENT_IDENTITY.privateKey,
      SIGNATURE_DOMAINS.agentRelayInit,
      agentRelayInitSignatureFields({
        deviceId: AGENT_IDENTITY.id,
        devicePublicKey: AGENT_IDENTITY.publicKey,
        timestamp,
      }),
    ),
  };
  return {
    init,
    publicKey: AGENT_IDENTITY.publicKey,
  };
}

function createSignedAgentHello(): {
  hello: AgentHelloPayload;
  publicKey: string;
} {
  const timestamp = Date.now();
  const challenge = createStatelessAgentAuthChallenge({
    deviceId: AGENT_IDENTITY.id,
    connectionId: AGENT_CONNECTION_ID,
    secret: CHALLENGE_SECRET,
    ttlMs: 60_000,
    now: timestamp,
  });
  const hello = createAgentHello({
    relay_auth: {
      method: "device_signature",
      timestamp,
      challenge,
      signature: signIdentityFields(
        AGENT_IDENTITY.privateKey,
        SIGNATURE_DOMAINS.agentRelayProof,
        agentRelayProofSignatureFields({
          deviceId: AGENT_IDENTITY.id,
          timestamp,
          challenge,
        }),
      ),
    },
  });
  return {
    hello,
    publicKey: AGENT_IDENTITY.publicKey,
  };
}
