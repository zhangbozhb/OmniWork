import assert from "node:assert/strict";
import test from "node:test";

import {
  appAuthSignatureFields,
  deriveIdentityId,
  generateIdentityKeyPair,
  identityMatchesPublicKey,
  isValidIdentityId,
  normalizeIdentityId,
  signIdentityFields,
  validateIdentityKeyPair,
  verifyIdentityFields,
} from "../src/index.ts";

test("generates stable role-scoped identity ids", () => {
  const identity = generateIdentityKeyPair(
    "agent",
    new Date("2026-09-16T00:00:00.000Z"),
  );

  assert.match(
    identity.id,
    /^DEV1-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{6}){5}$/u,
  );
  assert.equal(
    deriveIdentityId("agent", identity.publicKey),
    identity.id,
  );
  assert.notEqual(
    deriveIdentityId("app", identity.publicKey),
    identity.id,
  );
  assert.equal(validateIdentityKeyPair(identity, "agent"), true);
  assert.equal(identityMatchesPublicKey("agent", identity.id, identity.publicKey), true);
});

test("normalizes display ids and rejects checksum corruption", () => {
  const identity = generateIdentityKeyPair("app");
  assert.equal(normalizeIdentityId(identity.id.toLowerCase()), identity.id);
  assert.equal(isValidIdentityId(identity.id, "app"), true);
  assert.equal(isValidIdentityId(identity.id, "agent"), false);

  const replacement = identity.id.endsWith("0") ? "1" : "0";
  const corrupted = identity.id.slice(0, -1) + replacement;
  assert.equal(normalizeIdentityId(corrupted), null);
});

test("signatures are bound to their domain and ordered fields", () => {
  const identity = generateIdentityKeyPair("app");
  const fields = ["device-id", "app-id", "nonce"];
  const signature = signIdentityFields(
    identity.privateKey,
    "app-auth",
    fields,
  );

  assert.equal(
    verifyIdentityFields(identity.publicKey, "app-auth", fields, signature),
    true,
  );
  assert.equal(
    verifyIdentityFields(identity.publicKey, "agent-auth", fields, signature),
    false,
  );
  assert.equal(
    verifyIdentityFields(
      identity.publicKey,
      "app-auth",
      [...fields].reverse(),
      signature,
    ),
    false,
  );
});

test("authentication signatures canonicalize App metadata deterministically", () => {
  const agent = generateIdentityKeyPair("agent");
  const app = generateIdentityKeyPair("app");
  const base = {
    nonce: "nonce",
    connection_id: "conn_app",
    agent_connection_id: "conn_agent",
    device_id: agent.id,
    agent_public_key: agent.publicKey,
    app_id: app.id,
    app_public_key: app.publicKey,
    requested_scopes: ["device.control"] as ["device.control"],
    timestamp: 1,
  };

  assert.deepEqual(
    appAuthSignatureFields({
      ...base,
      app_info: {
        instance_id: "instance",
        runtime_id: "runtime",
        device: { name: "Phone", platform: "ios" },
      },
    }),
    appAuthSignatureFields({
      ...base,
      app_info: {
        device: { platform: "ios", name: "Phone" },
        runtime_id: "runtime",
        instance_id: "instance",
      },
    }),
  );
});
