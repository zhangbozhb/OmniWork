import { strict as assert } from "node:assert";

import {
  E2E_SUPPORT_V2,
  PROTOCOL_VERSION,
  PROTOCOL_SUPPORT_V2,
  RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE,
  RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON,
  createMessage,
  generateIdentityKeyPair,
  type AgentAuthInitPayload,
  type AgentHelloPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import { AgentAdmission } from "../src/app-agent/agentAdmission.ts";
import { TokenBucketLimiter } from "../src/tokenBucket.ts";

const sent: MessageEnvelope[] = [];
let registered = 0;
let addedToTopology = 0;
let closed: { code?: number; reason?: string } | null = null;
let authorizationInput: Record<string, unknown> | null = null;
const identity = generateIdentityKeyPair("agent");

const connection = {
  id: "conn-agent-1",
  endpoint: "agent",
  role: "unknown",
  state: "socket_connected",
  socket: {
    close(code?: number, reason?: string) {
      closed = { code, reason };
    },
  },
  authenticated: false,
  remoteIp: "8.8.8.8",
  observations: [],
  connectedAt: 1,
  lastSeenAt: 1,
  authState: "pending",
  transportPath: "relay",
} as never;

const admission = new AgentAdmission({
  config: {
    auth: {
      mode: "email_link",
      agentAuthChallengeTtlMs: 60_000,
      agentAuthClockSkewMs: 60_000,
      nonceTtlMs: 60_000,
    },
    authRateLimit: { blockMs: 60_000 },
  } as never,
  challengeSecret: Buffer.from("test-secret"),
  authGuard: {
    authorize: () => ({
      ok: true,
      subject: { userId: "user-1", deviceId: identity.id },
    }),
  } as never,
  authExecutor: { execute: () => undefined } as never,
  authLimiter: new TokenBucketLimiter({
    capacity: 5,
    refillPerSecond: 1,
    blockMs: 60_000,
  }),
  topology: {
    addAgentToDevice: () => {
      addedToTopology += 1;
    },
  } as never,
  state: {
    registerAgent: () => {
      registered += 1;
    },
  } as never,
  authorizeAgent: (input) => {
    authorizationInput = input;
    return { ok: true };
  },
  send: (_connection, message) => {
    sent.push(message);
  },
});

const hello = createMessage<AgentHelloPayload>(
  "agent.hello",
  {
    v: PROTOCOL_VERSION,
    device_id: identity.id,
    device_public_key: identity.publicKey,
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
  },
  { device_id: identity.id },
);

admission.handleAgentHello(connection, hello);
admission.handleAgentHello(connection, hello);

assert.equal(closed, null);
assert.equal(addedToTopology, 1);
assert.equal(registered, 1);
assert.equal(sent.length, 1);
assert.deepEqual(authorizationInput, {
  deviceId: identity.id,
  devicePublicKey: identity.publicKey,
  remoteIp: "8.8.8.8",
  publicRemoteIp: "8.8.8.8",
  hostname: "host",
  systemType: "Darwin",
  uname: "Darwin host 25.6.0 Darwin Kernel Version 25.6.0 arm64",
  agentVersion: "0.1.0",
});

let pendingAuthorizationClose:
  | { code?: number; reason?: string }
  | undefined;
let pendingAuthorizationRegistered = false;
const pendingAuthorizationAdmission = new AgentAdmission({
  config: {
    auth: {
      mode: "none",
      agentAuthChallengeTtlMs: 60_000,
      agentAuthClockSkewMs: 60_000,
      nonceTtlMs: 60_000,
    },
    authRateLimit: { blockMs: 60_000 },
  } as never,
  challengeSecret: Buffer.from("test-secret"),
  authGuard: {
    authorize: () => ({ ok: true }),
  } as never,
  authExecutor: { execute: () => undefined } as never,
  authLimiter: new TokenBucketLimiter({
    capacity: 5,
    refillPerSecond: 1,
    blockMs: 60_000,
  }),
  topology: { addAgentToDevice: () => undefined } as never,
  state: {
    registerAgent: () => {
      pendingAuthorizationRegistered = true;
    },
  } as never,
  authorizeAgent: () => ({
    ok: false,
    reason: "agent_approval_required",
  }),
  send: () => undefined,
});
const pendingAuthorizationConnection = {
  id: "conn-agent-pending",
  endpoint: "agent",
  role: "unknown",
  state: "socket_connected",
  authState: "pending",
  socket: {
    close(code?: number, reason?: string) {
      pendingAuthorizationClose = { code, reason };
    },
  },
  authenticated: false,
  remoteIp: "203.0.113.11",
  observations: [],
  connectedAt: 1,
  lastSeenAt: 1,
  transportPath: "relay",
} as never;

pendingAuthorizationAdmission.handleAgentHello(
  pendingAuthorizationConnection,
  hello,
);

assert.deepEqual(pendingAuthorizationClose, {
  code: RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE,
  reason: RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON,
});
assert.equal(pendingAuthorizationRegistered, false);

const initMessages: MessageEnvelope[] = [];
const initClosures: Array<{ code?: number; reason?: string }> = [];
const initAdmission = new AgentAdmission({
  config: {
    auth: {
      mode: "email_link",
      agentAuthChallengeTtlMs: 60_000,
      agentAuthClockSkewMs: 60_000,
      nonceTtlMs: 60_000,
    },
    authRateLimit: { blockMs: 60_000 },
  } as never,
  challengeSecret: Buffer.from("test-secret"),
  authGuard: {
    authorize: () => ({
      ok: true,
      subject: { userId: "user-1", deviceId: identity.id },
    }),
  } as never,
  authExecutor: { execute: () => undefined } as never,
  authLimiter: new TokenBucketLimiter({
    capacity: 1,
    refillPerSecond: 0,
    blockMs: 60_000,
  }),
  topology: { addAgentToDevice: () => undefined } as never,
  state: { registerAgent: () => undefined } as never,
  authorizeAgent: () => ({ ok: true }),
  send: (_connection, message) => {
    initMessages.push(message);
  },
});

function createInitConnection(id: string) {
  return {
    id,
    endpoint: "agent",
    role: "unknown",
    state: "socket_connected",
    socket: {
      close(code?: number, reason?: string) {
        initClosures.push({ code, reason });
      },
    },
    authenticated: false,
    remoteIp: "8.8.8.8",
    observations: [],
    connectedAt: 1,
    lastSeenAt: 1,
    authState: "none",
    transportPath: "relay",
  } as never;
}

const init = createMessage<AgentAuthInitPayload>(
  "agent.auth.init",
  {
    v: PROTOCOL_VERSION,
    device_id: identity.id,
    device_public_key: identity.publicKey,
    timestamp: Date.now(),
    signature: "signature-placeholder",
  },
  { device_id: identity.id },
);

initAdmission.handleAgentAuthInit(createInitConnection("conn-init-1"), init);
initAdmission.handleAgentAuthInit(createInitConnection("conn-init-2"), init);

assert.equal(initMessages.length, 1);
assert.deepEqual(initClosures, [{ code: 4403, reason: "too_many_attempts" }]);

const privateInitMessages: MessageEnvelope[] = [];
const privateInitClosures: Array<{ code?: number; reason?: string }> = [];
const privateInitAdmission = new AgentAdmission({
  config: {
    auth: {
      mode: "email_link",
      agentAuthChallengeTtlMs: 60_000,
      agentAuthClockSkewMs: 60_000,
      nonceTtlMs: 60_000,
    },
    authRateLimit: { blockMs: 60_000 },
  } as never,
  challengeSecret: Buffer.from("test-secret"),
  authGuard: {
    authorize: () => ({
      ok: true,
      subject: { userId: "user-1", deviceId: identity.id },
    }),
  } as never,
  authExecutor: { execute: () => undefined } as never,
  authLimiter: new TokenBucketLimiter({
    capacity: 1,
    refillPerSecond: 0,
    blockMs: 60_000,
  }),
  topology: { addAgentToDevice: () => undefined } as never,
  state: { registerAgent: () => undefined } as never,
  authorizeAgent: () => ({ ok: true }),
  send: (_connection, message) => {
    privateInitMessages.push(message);
  },
});

function createPrivateInitConnection(id: string) {
  return {
    id,
    endpoint: "agent",
    role: "unknown",
    state: "socket_connected",
    socket: {
      close(code?: number, reason?: string) {
        privateInitClosures.push({ code, reason });
      },
    },
    authenticated: false,
    remoteIp: "10.0.0.2",
    observations: [],
    connectedAt: 1,
    lastSeenAt: 1,
    authState: "none",
    transportPath: "relay",
  } as never;
}

privateInitAdmission.handleAgentAuthInit(
  createPrivateInitConnection("conn-private-init-1"),
  init,
);
privateInitAdmission.handleAgentAuthInit(
  createPrivateInitConnection("conn-private-init-2"),
  init,
);

assert.equal(privateInitMessages.length, 2);
assert.deepEqual(privateInitClosures, []);

console.log("agent admission tests passed");
