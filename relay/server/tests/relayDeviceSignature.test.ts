import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";

import { E2E_SUPPORT_V1, PROTOCOL_SUPPORT_V1 } from "@omniwork/protocol-ts";
import type { AgentHelloPayload } from "@omniwork/protocol-ts";

import {
  relayDeviceSignaturePayload,
  verifyRelayDeviceSignature,
} from "../src/relayDeviceSignature.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const timestamp = Date.now();
const nonce = "nonce-12345678901234567890";
const hello: AgentHelloPayload = {
  v: 1,
  device_id: "device-1",
  agent_instance_id: "agent-1",
  key_id: "key-1",
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
  protocol: PROTOCOL_SUPPORT_V1,
  e2e: E2E_SUPPORT_V1,
  hostname: "host",
  platform: "darwin",
  agent_version: "0.1.0",
  capabilities: [],
};

assert.deepEqual(
  verifyRelayDeviceSignature({
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    hello,
    skewMs: 60_000,
    now: timestamp,
  }),
  { ok: true },
);

assert.equal(
  verifyRelayDeviceSignature({
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    hello: { ...hello, device_id: "other-device" },
    skewMs: 60_000,
    now: timestamp,
  }).ok,
  false,
);

console.log("relay device signature tests passed");
