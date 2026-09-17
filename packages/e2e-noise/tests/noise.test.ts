import assert from "node:assert/strict";
import test from "node:test";

import {
  INNER_PROTOCOL_VERSION,
  SIGNATURE_DOMAINS,
  generateIdentityKeyPair,
  signIdentityFields,
  type InnerEnvelope,
} from "@omni-work/protocol-ts";
import {
  E2EError,
  acceptInitiatorHandshake,
  createInitiatorHandshake,
} from "../src/index.ts";

const agentIdentity = generateIdentityKeyPair("agent");
const appIdentity = generateIdentityKeyPair("app");
const context = {
  deviceId: agentIdentity.id,
  agentPublicKey: agentIdentity.publicKey,
  appId: appIdentity.id,
  appPublicKey: appIdentity.publicKey,
  agentConnectionId: "conn_agent_1",
  appConnectionId: "conn_app_1",
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

async function createSessionPair() {
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
    initiator,
    responder,
  };
}

test("completes a mutually authenticated signed X25519 handshake", async () => {
  const { appSession, agentSession } = await createSessionPair();

  assert.equal(appSession.sessionId, agentSession.sessionId);
  assert.equal(appSession.transcriptHash, agentSession.transcriptHash);
  assert.deepEqual(appSession.readyPayload(), agentSession.readyPayload());
});

test("encrypts app to agent and agent to app inner envelopes", async () => {
  const { appSession, agentSession } = await createSessionPair();

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

test("rejects an App handshake signed by another identity", async () => {
  const attacker = generateIdentityKeyPair("app");
  const initiator = await createInitiatorHandshake({
    ...context,
    signApp: (fields) =>
      signIdentityFields(
        attacker.privateKey,
        SIGNATURE_DOMAINS.e2eInit,
        fields,
      ),
  });

  assert.throws(
    () =>
      acceptInitiatorHandshake(
        {
          ...context,
          agentPrivateKey: agentIdentity.privateKey,
        },
        initiator.init,
      ),
    (error) =>
      error instanceof E2EError && error.code === "invalid_signature",
  );
});

test("rejects an Agent reply with a tampered identity signature", async () => {
  const { initiator, responder } = await createSessionPair();
  const signature = Buffer.from(responder.reply.signature, "base64url");
  signature[0] ^= 1;
  const tampered = {
    ...responder.reply,
    signature: signature.toString("base64url"),
  };

  assert.throws(
    () => initiator.complete(tampered),
    (error) =>
      error instanceof E2EError && error.code === "invalid_signature",
  );
});

test("binds traffic to the App connection id", async () => {
  const { appSession, agentSession } = await createSessionPair();
  const encrypted = appSession.encrypt(makeInner());

  assert.throws(
    () =>
      agentSession.decrypt({
        ...encrypted.payload,
        app_connection_id: "conn_other",
      }),
    (error) => error instanceof E2EError && error.code === "decrypt_failed",
  );
});

test("rejects tampered ciphertext", async () => {
  const { appSession, agentSession } = await createSessionPair();
  const encrypted = appSession.encrypt(makeInner());
  const raw = Buffer.from(encrypted.payload.ciphertext, "base64url");
  raw[0] ^= 1;

  assert.throws(
    () =>
      agentSession.decrypt({
        ...encrypted.payload,
        ciphertext: raw.toString("base64url"),
      }),
    (error) => error instanceof E2EError && error.code === "decrypt_failed",
  );
});

test("rejects replayed and out-of-order messages", async () => {
  const { appSession, agentSession } = await createSessionPair();
  const first = appSession.encrypt(makeInner("first"));
  const second = appSession.encrypt(makeInner("second"));

  assert.throws(
    () => agentSession.decrypt(second.payload),
    (error) => error instanceof E2EError && error.code === "replay_detected",
  );
  assert.deepEqual(agentSession.decrypt(first.payload), makeInner("first"));
  assert.throws(
    () => agentSession.decrypt(first.payload),
    (error) => error instanceof E2EError && error.code === "replay_detected",
  );
});
