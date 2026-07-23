import { strict as assert } from "node:assert";

import {
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
  createMessage,
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
  remoteIp: "203.0.113.10",
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
      subject: { userId: "user-1", deviceId: "device-1" },
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
  send: (_connection, message) => {
    sent.push(message);
  },
});

const hello = createMessage<AgentHelloPayload>(
  "agent.hello",
  {
    v: 1,
    device_id: "device-1",
    relay_auth: {
      method: "device_signature",
      timestamp: Date.now(),
      challenge: "challenge-placeholder",
      signature: "signature-placeholder",
    },
    protocol: PROTOCOL_SUPPORT_V1,
    e2e: E2E_SUPPORT_V1,
    hostname: "host",
    platform: "darwin",
    agent_version: "0.1.0",
    capabilities: [],
  },
  { device_id: "device-1" },
);

admission.handleAgentHello(connection, hello);
admission.handleAgentHello(connection, hello);

assert.equal(closed, null);
assert.equal(addedToTopology, 1);
assert.equal(registered, 1);
assert.equal(sent.length, 1);

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
      subject: { userId: "user-1", deviceId: "device-1" },
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
    v: 1,
    device_id: "device-1",
    device_public_key: "public-key-placeholder",
    timestamp: Date.now(),
    signature: "signature-placeholder",
  },
  { device_id: "device-1" },
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
      subject: { userId: "user-1", deviceId: "device-1" },
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
