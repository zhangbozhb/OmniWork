import assert from "node:assert/strict";
import test from "node:test";
import { INNER_PROTOCOL_VERSION, type InnerEnvelope } from "@omniwork/protocol-ts";
import {
  E2ENoiseError,
  acceptInitiatorHandshake,
  createInitiatorHandshake,
  deriveNoisePsk,
} from "../src/index.ts";

const context = {
  pairingKey: "test-pairing-key-32-bytes",
  deviceId: "mac_test",
  keyId: "key_test",
  agentInstanceId: "agent_test",
  handshakeId: "hs_test",
};

function makeInner(id = "inner_1"): InnerEnvelope {
  return {
    v: INNER_PROTOCOL_VERSION,
    id,
    type: "terminal.input",
    created_at: "2026-05-31T00:00:00.000Z",
    session_id: "sess_1",
    payload: {
      kind: "text",
      data: "ls\n",
    },
  };
}

function createSessionPair() {
  const initiator = createInitiatorHandshake(context);
  const responder = acceptInitiatorHandshake(context, initiator.init);
  const appSession = initiator.complete(responder.reply);
  return {
    appSession,
    agentSession: responder.session,
  };
}

test("derives stable PSK from pairing context", () => {
  assert.deepEqual(deriveNoisePsk(context), deriveNoisePsk(context));
  assert.notDeepEqual(
    deriveNoisePsk(context),
    deriveNoisePsk({ ...context, deviceId: "mac_other" }),
  );
});

test("completes NNpsk0 handshake with matching transcript hash", () => {
  const { appSession, agentSession } = createSessionPair();

  assert.equal(appSession.sessionId, agentSession.sessionId);
  assert.equal(appSession.transcriptHash, agentSession.transcriptHash);
  assert.deepEqual(appSession.readyPayload(), agentSession.readyPayload());
});

test("encrypts app to agent and agent to app inner envelopes", () => {
  const { appSession, agentSession } = createSessionPair();

  const request = makeInner("inner_request");
  const encryptedRequest = appSession.encrypt(request);
  assert.equal(encryptedRequest.payload.seq, 1);
  assert.notEqual(encryptedRequest.payload.ciphertext, JSON.stringify(request));
  assert.deepEqual(agentSession.decrypt(encryptedRequest.payload), request);

  const response = makeInner("inner_response");
  const encryptedResponse = agentSession.encrypt(response);
  assert.equal(encryptedResponse.payload.seq, 1);
  assert.deepEqual(appSession.decrypt(encryptedResponse.payload), response);
});

test("rejects key mismatch when decrypting traffic", () => {
  const initiator = createInitiatorHandshake(context);
  const responder = acceptInitiatorHandshake(
    { ...context, pairingKey: "different-key" },
    initiator.init,
  );
  const appSession = initiator.complete(responder.reply);
  const encrypted = appSession.encrypt(makeInner());

  assert.throws(
    () => responder.session.decrypt(encrypted.payload),
    (error) =>
      error instanceof E2ENoiseError && error.code === "decrypt_failed",
  );
});

test("rejects tampered ciphertext", () => {
  const { appSession, agentSession } = createSessionPair();
  const encrypted = appSession.encrypt(makeInner());
  const raw = Buffer.from(encrypted.payload.ciphertext, "base64url");
  raw[0] ^= 1;

  assert.throws(
    () =>
      agentSession.decrypt({
        ...encrypted.payload,
        ciphertext: raw.toString("base64url"),
      }),
    (error) =>
      error instanceof E2ENoiseError && error.code === "decrypt_failed",
  );
});

test("rejects replayed message sequence", () => {
  const { appSession, agentSession } = createSessionPair();
  const encrypted = appSession.encrypt(makeInner());

  assert.deepEqual(agentSession.decrypt(encrypted.payload), makeInner());
  assert.throws(
    () => agentSession.decrypt(encrypted.payload),
    (error) =>
      error instanceof E2ENoiseError && error.code === "replay_detected",
  );
});

test("rejects out-of-order message sequence", () => {
  const { appSession, agentSession } = createSessionPair();
  const first = appSession.encrypt(makeInner("first"));
  const second = appSession.encrypt(makeInner("second"));

  assert.throws(
    () => agentSession.decrypt(second.payload),
    (error) =>
      error instanceof E2ENoiseError && error.code === "replay_detected",
  );
  assert.deepEqual(agentSession.decrypt(first.payload), makeInner("first"));
});
