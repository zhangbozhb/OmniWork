import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";

import { E2E_SUPPORT_V1, PROTOCOL_SUPPORT_V1 } from "@omniwork/protocol-ts";
import type {
  AgentAuthInitPayload,
  AgentHelloPayload,
} from "@omniwork/protocol-ts";

import {
  createStatelessAgentAuthChallenge,
  relayDeviceInitSignaturePayload,
  relayDeviceProofSignaturePayload,
  sameRelayDevicePublicKey,
  verifyRelayDeviceInitSignature,
  verifyRelayDeviceSignature,
} from "../src/relayDeviceSignature.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const timestamp = Date.now();
const devicePublicKey = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const challengeSecret = Buffer.from("test-secret");
const connectionId = "conn-agent-1";
const challenge = createStatelessAgentAuthChallenge({
  deviceId: "device-1",
  connectionId,
  secret: challengeSecret,
  ttlMs: 60_000,
  now: timestamp,
});
const init: AgentAuthInitPayload = {
  v: 1,
  device_id: "device-1",
  device_public_key: devicePublicKey,
  timestamp,
  signature: sign(
    null,
    relayDeviceInitSignaturePayload({
      deviceId: "device-1",
      devicePublicKey,
      timestamp,
    }),
    privateKey,
  ).toString("base64url"),
};
const hello: AgentHelloPayload = {
  v: 1,
  device_id: "device-1",
  relay_auth: {
    method: "device_signature",
    timestamp,
    challenge,
    signature: sign(
      null,
      relayDeviceProofSignaturePayload({
        deviceId: "device-1",
        timestamp,
        challenge,
      }),
      privateKey,
    ).toString("base64url"),
  },
  protocol: PROTOCOL_SUPPORT_V1,
  e2e: E2E_SUPPORT_V1,
  hostname: "host",
  platform: "darwin",
  agent_version: "0.1.0",
  capabilities: [],
};

assert.deepEqual(
  verifyRelayDeviceInitSignature({
    publicKey: devicePublicKey,
    init,
    skewMs: 60_000,
    now: timestamp,
  }),
  { ok: true },
);

assert.equal(
  sameRelayDevicePublicKey(
    devicePublicKey,
    devicePublicKey.replace(/\n/g, "\r\n"),
  ),
  true,
);

assert.deepEqual(
  verifyRelayDeviceSignature({
    publicKey: devicePublicKey,
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
    publicKey: devicePublicKey,
    hello: { ...hello, device_id: "other-device" },
    skewMs: 60_000,
    challengeSecret,
    connectionId,
    now: timestamp,
  }).ok,
  false,
);

assert.equal(
  verifyRelayDeviceSignature({
    publicKey: devicePublicKey,
    hello,
    skewMs: 60_000,
    challengeSecret,
    connectionId: "other-connection",
    now: timestamp,
  }).ok,
  false,
);

console.log("relay device signature tests passed");
