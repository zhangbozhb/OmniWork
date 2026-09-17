import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptInitiatorHandshake,
  createInitiatorHandshake,
  type E2ESession,
} from "@omni-work/e2e-noise";
import {
  E2E_SUPPORT_V2,
  INNER_PROTOCOL_VERSION,
  SIGNATURE_DOMAINS,
  agentAuthOkSignatureFields,
  appAuthSignatureFields,
  createMessage,
  generateIdentityKeyPair,
  signIdentityFields,
  verifyIdentityFields,
  type AuthChallengePayload,
  type AuthOkPayload,
  type AuthProofPayload,
  type InnerEnvelope,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";
import { MobileRelaySession } from "../src/lib/relay-client/mobileRelaySession.ts";

const agentIdentity = generateIdentityKeyPair("agent");
const appIdentity = generateIdentityKeyPair("app");
const pairing = {
  relayUrl: "wss://relay.test",
  deviceId: agentIdentity.id,
  appInstanceId: "app_test_1",
};

async function createSessionPair(): Promise<{
  appSession: E2ESession;
  agentSession: E2ESession;
}> {
  const context = {
    deviceId: pairing.deviceId,
    agentPublicKey: agentIdentity.publicKey,
    appId: appIdentity.id,
    appPublicKey: appIdentity.publicKey,
    agentConnectionId: "conn_agent_1",
    appConnectionId: "conn_app_1",
    handshakeId: "hs_test",
  };
  const initiator = await createInitiatorHandshake({
    ...context,
    signApp: (fields) =>
      signIdentityFields(
        appIdentity.privateKey,
        SIGNATURE_DOMAINS.e2eInit,
        fields,
      ),
  });
  const responder = acceptInitiatorHandshake(
    {
      ...context,
      agentPrivateKey: agentIdentity.privateKey,
    },
    initiator.init,
  );
  return {
    appSession: initiator.complete(responder.reply),
    agentSession: responder.session,
  };
}

function createReadyRelaySession(
  appSession: E2ESession,
): MobileRelaySession {
  const relaySession = new MobileRelaySession(pairing);
  const internals = relaySession as unknown as {
    e2eSession: E2ESession;
    e2ePeerReady: boolean;
    appConnectionId: string;
  };
  internals.e2eSession = appSession;
  internals.e2ePeerReady = true;
  internals.appConnectionId = "conn_app_1";
  return relaySession;
}

function makeInner(type: InnerEnvelope["type"]): InnerEnvelope {
  return {
    v: INNER_PROTOCOL_VERSION,
    id: `inner_${type}`,
    type,
    created_at: "2026-06-03T00:00:00.000Z",
    session_id: "sess_1",
    seq: 7,
    payload:
      type === "terminal.frame"
        ? { data: "frame", snapshot: true }
        : { data: "ls\n" },
  };
}

test("encodeForP2p encrypts business messages as e2e.message", async () => {
  const { appSession, agentSession } = await createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const input = createMessage(
    "terminal.input",
    { data: "ls\n" },
    { device_id: pairing.deviceId, session_id: "sess_1", seq: 3 },
  );

  const encoded = relaySession.encodeForP2p(input);

  assert.ok(encoded, "P2P encoding should return an envelope");
  assert.equal(encoded.type, "e2e.message");
  const decrypted = agentSession.decrypt(
    encoded.payload as Parameters<E2ESession["decrypt"]>[0],
  );
  assert.equal(decrypted.type, "terminal.input");
  assert.equal(decrypted.seq, 3);
});

test("receiveFromP2p decrypts e2e.message before dispatching business messages", async () => {
  const { appSession, agentSession } = await createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const received: MessageEnvelope[] = [];
  relaySession.onMessage((message) => received.push(message));
  const encrypted = agentSession.encrypt(makeInner("terminal.frame"));
  const outer = createMessage("e2e.message", encrypted.payload, {
    device_id: pairing.deviceId,
  });

  relaySession.receiveFromP2p(outer);
  await Promise.resolve();

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "terminal.frame");
  assert.equal(received[0]?.seq, 7);
});

test("encodeForP2p does not send business messages before E2E is ready", () => {
  const relaySession = new MobileRelaySession(pairing);
  const input = createMessage("terminal.input", { data: "pwd\n" }, {
    device_id: pairing.deviceId,
  });

  assert.equal(relaySession.encodeForP2p(input), null);
});

test("auth challenge supplies and binds the target Agent public key", async () => {
  const relaySession = new MobileRelaySession(pairing);
  const sent: MessageEnvelope[] = [];
  const { privateKey: _privateKey, ...appRecord } = appIdentity;
  const internals = relaySession as unknown as {
    agentPublicKey: string | null;
    appIdentity: {
      record: typeof appRecord;
      sign(domain: string, fields: readonly string[]): Promise<string>;
    };
    appInfoCache: {
      instance_id: string;
      runtime_id: string;
    };
    client: { send(message: MessageEnvelope): void };
    handleAuthChallenge(challenge: AuthChallengePayload): Promise<void>;
  };
  internals.appIdentity = {
    record: appRecord,
    sign: async (domain, fields) =>
      signIdentityFields(appIdentity.privateKey, domain, fields),
  };
  internals.appInfoCache = {
    instance_id: pairing.appInstanceId,
    runtime_id: "runtime_test",
  };
  internals.client = {
    send: (message) => sent.push(message),
  };

  await internals.handleAuthChallenge({
    nonce: "nonce_1",
    expires_at: "2026-09-16T01:00:00.000Z",
    connection_id: "conn_app_1",
    agent_connection_id: "conn_agent_1",
    agent_public_key: agentIdentity.publicKey,
  });

  assert.equal(internals.agentPublicKey, agentIdentity.publicKey);
  assert.equal(sent.length, 1);
  const proof = sent[0]?.payload as AuthProofPayload;
  const { signature, ...unsigned } = proof;
  assert.equal(proof.agent_public_key, agentIdentity.publicKey);
  assert.equal(proof.app_id, appIdentity.id);
  assert.equal(
    verifyIdentityFields(
      appIdentity.publicKey,
      SIGNATURE_DOMAINS.appAuth,
      appAuthSignatureFields(unsigned),
      signature,
    ),
    true,
  );
});

test("auth challenge rejects an Agent key that does not derive the target ID", async () => {
  const relaySession = new MobileRelaySession(pairing);
  const otherAgent = generateIdentityKeyPair("agent");
  const internals = relaySession as unknown as {
    handleAuthChallenge(challenge: AuthChallengePayload): Promise<void>;
  };

  await assert.rejects(
    internals.handleAuthChallenge({
      nonce: "nonce_1",
      expires_at: "2026-09-16T01:00:00.000Z",
      connection_id: "conn_app_1",
      agent_connection_id: "conn_agent_1",
      agent_public_key: otherAgent.publicKey,
    }),
    /does not match the pairing target/u,
  );
});

test("invalid authenticated control messages close the Relay session", async () => {
  const relaySession = new MobileRelaySession(pairing);
  const otherAgent = generateIdentityKeyPair("agent");
  const closed: Array<{ code?: number; reason?: string }> = [];
  const internals = relaySession as unknown as {
    client: {
      close(code?: number, reason?: string): void;
    };
    handleIncomingMessage(message: MessageEnvelope): void;
  };
  internals.client = {
    close: (code, reason) => closed.push({ code, reason }),
  };

  internals.handleIncomingMessage(
    createMessage<AuthChallengePayload>("auth.challenge", {
      nonce: "nonce_1",
      expires_at: "2026-09-16T01:00:00.000Z",
      connection_id: "conn_app_1",
      agent_connection_id: "conn_agent_1",
      agent_public_key: otherAgent.publicKey,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(closed, [
    { code: 1008, reason: "secure_protocol_validation_failed" },
  ]);
});

test("auth.ok must echo the challenged Relay connection ids", async () => {
  const relaySession = new MobileRelaySession(pairing);
  const sent: MessageEnvelope[] = [];
  const { privateKey: _privateKey, ...appRecord } = appIdentity;
  const internals = relaySession as unknown as {
    appIdentity: {
      record: typeof appRecord;
      sign(domain: string, fields: readonly string[]): Promise<string>;
    };
    appInfoCache: {
      instance_id: string;
      runtime_id: string;
    };
    client: { send(message: MessageEnvelope): void };
    handleAuthChallenge(challenge: AuthChallengePayload): Promise<void>;
    handleAuthOk(payload: AuthOkPayload): Promise<void>;
  };
  internals.appIdentity = {
    record: appRecord,
    sign: async (domain, fields) =>
      signIdentityFields(appIdentity.privateKey, domain, fields),
  };
  internals.appInfoCache = {
    instance_id: pairing.appInstanceId,
    runtime_id: "runtime_test",
  };
  internals.client = {
    send: (message) => sent.push(message),
  };
  await internals.handleAuthChallenge({
    nonce: "nonce_1",
    expires_at: "2026-09-16T01:00:00.000Z",
    connection_id: "conn_app_1",
    agent_connection_id: "conn_agent_1",
    agent_public_key: agentIdentity.publicKey,
  });

  const unsigned: Omit<AuthOkPayload, "signature" | "e2e"> = {
    nonce: "nonce_1",
    device_id: agentIdentity.id,
    agent_public_key: agentIdentity.publicKey,
    app_id: appIdentity.id,
    agent_connection_id: "conn_agent_other",
    connection_id: "conn_app_other",
    granted_scopes: ["device.control"],
    timestamp: Date.now(),
  };
  const payload: AuthOkPayload = {
    ...unsigned,
    signature: signIdentityFields(
      agentIdentity.privateKey,
      SIGNATURE_DOMAINS.agentAuthOk,
      agentAuthOkSignatureFields(unsigned),
    ),
    e2e: E2E_SUPPORT_V2,
  };

  await assert.rejects(
    internals.handleAuthOk(payload),
    /does not match this App/u,
  );
});

test("upgrade control dispatch is scoped to current app_connection_id", async () => {
  const { appSession } = await createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const received: MessageEnvelope[] = [];
  relaySession.onMessage((message) => received.push(message));
  const internals = relaySession as unknown as {
    dispatchRelayUpgradeControl: (message: MessageEnvelope) => void;
  };

  internals.dispatchRelayUpgradeControl(
    createMessage(
      "tunnel.upgrade.propose",
      {
        upgrade_id: "upgrade_other",
        app_connection_id: "conn_other",
        ice_servers: [],
        role: "offerer",
        strict: true,
      },
      { device_id: pairing.deviceId },
    ),
  );
  internals.dispatchRelayUpgradeControl(
    createMessage(
      "tunnel.upgrade.propose",
      {
        upgrade_id: "upgrade_self",
        app_connection_id: "conn_app_1",
        ice_servers: [],
        role: "offerer",
        strict: true,
      },
      { device_id: pairing.deviceId },
    ),
  );

  assert.equal(received.length, 1);
  assert.equal(
    (received[0]?.payload as { app_connection_id?: string }).app_connection_id,
    "conn_app_1",
  );
});

test("onBusinessReady fires when E2E peer becomes ready", async () => {
  const { appSession } = await createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const internals = relaySession as unknown as {
    e2eSession: E2ESession;
    e2ePeerReady: boolean;
    appConnectionId: string;
    handleE2EReady: (payload: ReturnType<E2ESession["readyPayload"]>) => void;
  };
  internals.e2ePeerReady = false;
  let readyCount = 0;
  relaySession.onBusinessReady(() => {
    readyCount += 1;
  });

  internals.handleE2EReady(internals.e2eSession.readyPayload());

  assert.equal(readyCount, 1);
});

test("relay_only does not probe WebRTC for private network hash", async () => {
  const previous = (
    globalThis as unknown as { RTCPeerConnection?: unknown }
  ).RTCPeerConnection;
  (
    globalThis as unknown as { RTCPeerConnection?: unknown }
  ).RTCPeerConnection = class {
    constructor() {
      throw new Error("should not probe WebRTC in relay_only mode");
    }
  };
  try {
    const relaySession = new MobileRelaySession(pairing, {
      transportPreference: "relay_only",
    });
    const internals = relaySession as unknown as {
      resolvePrivateNetworkHash: () => Promise<string | undefined>;
    };

    assert.equal(await internals.resolvePrivateNetworkHash(), undefined);
  } finally {
    (
      globalThis as unknown as { RTCPeerConnection?: unknown }
    ).RTCPeerConnection = previous;
  }
});

test("E2E failures close the session and discard queued work", async () => {
  for (const failure of ["ready", "ciphertext", "peer_failed"] as const) {
    const { appSession, agentSession } = await createSessionPair();
    const session = createReadyRelaySession(appSession);
    const closed: Array<{ code?: number; reason?: string }> = [];
    const internals = session as unknown as {
      client: { close(code?: number, reason?: string): void };
      pendingBusinessMessages: MessageEnvelope[];
      connectionHeartbeatTimer: ReturnType<typeof setInterval> | null;
      startConnectionHeartbeat(): void;
    };
    internals.client = {
      close: (code, reason) => closed.push({ code, reason }),
    };
    internals.pendingBusinessMessages = [
      createMessage("session.list", {}, { device_id: pairing.deviceId }),
    ];
    internals.startConnectionHeartbeat();
    const message =
      failure === "ready"
        ? createMessage("e2e.ready", {
            ...appSession.readyPayload(),
            transcript_hash: "tampered",
          })
        : failure === "ciphertext"
          ? createMessage("e2e.message", {
              ...agentSession.encrypt(makeInner("terminal.frame")).payload,
              ciphertext: "AA",
            })
          : createMessage("e2e.failed", {
              v: 2,
              e2e_version: 2,
              app_connection_id: "conn_app_1",
              handshake_id: appSession.handshakeId,
              reason: "handshake_failed",
            });
    session.receiveFromP2p(message);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, [
      { code: 1008, reason: "secure_protocol_validation_failed" },
    ], failure);
    assert.equal(session.getAppConnectionId(), null);
    assert.equal(internals.connectionHeartbeatTimer, null);
    assert.equal(internals.pendingBusinessMessages.length, 0);
  }
});

test("closing during App signing prevents a late auth proof", async () => {
  const session = new MobileRelaySession(pairing);
  const sent: MessageEnvelope[] = [];
  let finishSigning!: (signature: string) => void;
  const signature = new Promise<string>((resolve) => {
    finishSigning = resolve;
  });
  const { privateKey: _privateKey, ...record } = appIdentity;
  const internals = session as unknown as {
    appIdentity: {
      record: typeof record;
      sign(): Promise<string>;
    };
    appInfoCache: { instance_id: string; runtime_id: string };
    client: { send(message: MessageEnvelope): void; close(): void };
    handleAuthChallenge(challenge: AuthChallengePayload): Promise<void>;
    pendingBusinessMessages: MessageEnvelope[];
  };
  internals.appIdentity = { record, sign: () => signature };
  internals.appInfoCache = {
    instance_id: pairing.appInstanceId,
    runtime_id: "runtime_test",
  };
  internals.client = { send: (message) => sent.push(message), close() {} };
  const authenticating = internals.handleAuthChallenge({
    nonce: "closing_nonce",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    connection_id: "conn_app_1",
    agent_connection_id: "conn_agent_1",
    agent_public_key: agentIdentity.publicKey,
  });
  await Promise.resolve();
  session.close();
  finishSigning("late_signature");
  await authenticating;

  assert.equal(sent.length, 0);
  assert.equal(internals.pendingBusinessMessages.length, 0);
  assert.throws(() => session.send(createMessage("session.list", {})), /closed/u);
});
