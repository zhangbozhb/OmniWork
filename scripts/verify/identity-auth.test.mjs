import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROTOCOL_VERSION,
  SIGNATURE_DOMAINS,
  appAuthSignatureFields,
  createPairingLink,
  deriveIdentityId,
  generateIdentityKeyPair,
  identityMatchesPublicKey,
  parsePairingLink,
  signIdentityFields,
  verifyIdentityFields,
} from "../../packages/protocol-ts/dist/index.js";

test("target links contain location data but no identity credentials", () => {
  const agent = generateIdentityKeyPair("agent");
  const link = createPairingLink({
    v: PROTOCOL_VERSION,
    relay_url: "wss://relay.example/relay/ws/mobile",
    device_id: agent.id,
    display_name: "Agent Host",
  });

  assert.deepEqual(parsePairingLink(link), {
    v: PROTOCOL_VERSION,
    relay_url: "wss://relay.example/relay/ws/mobile",
    device_id: agent.id,
    display_name: "Agent Host",
  });
  assert.equal(link.includes("public_key"), false);
  assert.equal(link.includes("ticket"), false);
  assert.equal(link.includes("session_token"), false);
});

test("App auth proof binds both public identities and App metadata", () => {
  const agent = generateIdentityKeyPair("agent");
  const app = generateIdentityKeyPair("app");
  const unsigned = {
    nonce: "nonce_1",
    connection_id: "conn_app_1",
    agent_connection_id: "conn_agent_1",
    device_id: agent.id,
    agent_public_key: agent.publicKey,
    app_id: app.id,
    app_public_key: app.publicKey,
    app_info: {
      instance_id: app.id,
      runtime_id: "runtime_1",
      device: {
        name: "Test Device",
        platform: "web",
      },
    },
    requested_scopes: ["device.control"],
    timestamp: 1,
  };
  const fields = appAuthSignatureFields(unsigned);
  const signature = signIdentityFields(
    app.privateKey,
    SIGNATURE_DOMAINS.appAuth,
    fields,
  );

  assert.equal(
    verifyIdentityFields(
      app.publicKey,
      SIGNATURE_DOMAINS.appAuth,
      fields,
      signature,
    ),
    true,
  );
  assert.equal(
    verifyIdentityFields(
      app.publicKey,
      SIGNATURE_DOMAINS.appAuth,
      appAuthSignatureFields({
        ...unsigned,
        device_id: generateIdentityKeyPair("agent").id,
      }),
      signature,
    ),
    false,
  );
});

test("role-scoped IDs are derived from public keys", () => {
  const agent = generateIdentityKeyPair("agent");
  const app = generateIdentityKeyPair("app");

  assert.equal(deriveIdentityId("agent", agent.publicKey), agent.id);
  assert.equal(deriveIdentityId("app", app.publicKey), app.id);
  assert.equal(
    identityMatchesPublicKey("agent", agent.id, app.publicKey),
    false,
  );
});
