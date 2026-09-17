import assert from "node:assert/strict";
import test from "node:test";
import {
  agentAuthInitPayloadSchema,
  agentRelayInitSignatureFields,
  generateIdentityKeyPair,
  signIdentityFields,
  SIGNATURE_DOMAINS,
  verifyIdentityFields,
} from "../src/index.ts";

test("signed wire identities reject aliases that would split authorization keys", () => {
  const identity = generateIdentityKeyPair("agent");
  for (const deviceId of [
    identity.id,
    identity.id.toLowerCase(),
    identity.id.replaceAll("-", ""),
    ` ${identity.id} `,
  ]) {
    const fields = agentRelayInitSignatureFields({
      deviceId,
      devicePublicKey: identity.publicKey,
      timestamp: 1,
    });
    const signature = signIdentityFields(
      identity.privateKey, SIGNATURE_DOMAINS.agentRelayInit, fields,
    );
    assert.equal(verifyIdentityFields(
      identity.publicKey, SIGNATURE_DOMAINS.agentRelayInit, fields, signature,
    ), true);
    assert.equal(agentAuthInitPayloadSchema.safeParse({
      v: 2,
      device_id: deviceId,
      device_public_key: identity.publicKey,
      timestamp: 1,
      signature,
    }).success, deviceId === identity.id);
  }
});
