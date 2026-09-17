import { strict as assert } from "node:assert";

import {
  E2E_SUPPORT_V2,
  PROTOCOL_SUPPORT_V2,
  PROTOCOL_VERSION,
  SIGNATURE_DOMAINS,
  agentRelayInitSignatureFields,
  agentRelayProofSignatureFields,
  generateIdentityKeyPair,
  signIdentityFields,
  type AgentAuthInitPayload,
  type AgentHelloPayload,
} from "@omni-work/protocol-ts";

import {
  createStatelessAgentAuthChallenge,
  sameRelayDevicePublicKey,
  verifyRelayDeviceInitSignature,
  verifyRelayDeviceSignature,
} from "../src/relayDeviceSignature.ts";

const identity = generateIdentityKeyPair("agent");
const timestamp = Date.now();
const challengeSecret = Buffer.from("test-secret");
const connectionId = "conn-agent-1";
const challenge = createStatelessAgentAuthChallenge({
  deviceId: identity.id,
  connectionId,
  secret: challengeSecret,
  ttlMs: 60_000,
  now: timestamp,
});
const init: AgentAuthInitPayload = {
  v: PROTOCOL_VERSION,
  device_id: identity.id,
  device_public_key: identity.publicKey,
  timestamp,
  signature: signIdentityFields(
    identity.privateKey,
    SIGNATURE_DOMAINS.agentRelayInit,
    agentRelayInitSignatureFields({
      deviceId: identity.id,
      devicePublicKey: identity.publicKey,
      timestamp,
    }),
  ),
};
const hello: AgentHelloPayload = {
  v: PROTOCOL_VERSION,
  device_id: identity.id,
  device_public_key: identity.publicKey,
  relay_auth: {
    method: "device_signature",
    timestamp,
    challenge,
    signature: signIdentityFields(
      identity.privateKey,
      SIGNATURE_DOMAINS.agentRelayProof,
      agentRelayProofSignatureFields({
        deviceId: identity.id,
        timestamp,
        challenge,
      }),
    ),
  },
  protocol: PROTOCOL_SUPPORT_V2,
  e2e: E2E_SUPPORT_V2,
  hostname: "host",
  platform: "darwin",
  system_type: "Darwin",
  uname: "Darwin host 25.6.0 Darwin Kernel Version 25.6.0 arm64",
  agent_version: "0.1.0",
  capabilities: [],
};

assert.deepEqual(
  verifyRelayDeviceInitSignature({
    publicKey: identity.publicKey,
    init,
    skewMs: 60_000,
    now: timestamp,
  }),
  { ok: true },
);

assert.equal(
  sameRelayDevicePublicKey(identity.publicKey, identity.publicKey),
  true,
);
assert.equal(
  sameRelayDevicePublicKey(
    identity.publicKey,
    generateIdentityKeyPair("agent").publicKey,
  ),
  false,
);

assert.deepEqual(
  verifyRelayDeviceSignature({
    publicKey: identity.publicKey,
    hello,
    skewMs: 60_000,
    challengeSecret,
    connectionId,
    now: timestamp,
  }),
  { ok: true },
);

assert.equal(
  verifyRelayDeviceSignature({
    publicKey: identity.publicKey,
    hello: { ...hello, device_id: generateIdentityKeyPair("agent").id },
    skewMs: 60_000,
    challengeSecret,
    connectionId,
    now: timestamp,
  }).ok,
  false,
);

assert.equal(
  verifyRelayDeviceSignature({
    publicKey: identity.publicKey,
    hello,
    skewMs: 60_000,
    challengeSecret,
    connectionId: "other-connection",
    now: timestamp,
  }).ok,
  false,
);

console.log("relay device signature tests passed");
