import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RelayUserAuthStore } from "../src/relayUserAuthStore.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-relay-auth-"));

try {
  const store = new RelayUserAuthStore(join(dir, "relay-auth.sqlite"));
  const link = store.createEmailLink({
    email: "USER@example.com",
    ttlMs: 1000,
    requestIp: "127.0.0.1",
    now: 1000,
  });
  const user = store.consumeEmailLink(link.token, 1100);
  assert.ok(user);
  assert.equal(user.email, "user@example.com");
  assert.equal(store.consumeEmailLink(link.token, 1101), null);

  const session = store.createSession({
    userId: user.id,
    ttlMs: 1000,
    now: 1200,
  });
  assert.equal(store.authenticateSession(session.token, 1300)?.id, user.id);
  assert.equal(store.authenticateSession(session.token, 2301), null);

  const enrollment = store.createDeviceEnrollment({
    userId: user.id,
    ttlMs: 1000,
    now: 1400,
  });
  const { publicKey } = generateKeyPairSync("ed25519");
  const device = store.consumeDeviceEnrollment({
    token: enrollment.token,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    name: "MacBook",
    maxDevicesPerUser: 10,
    now: 1500,
  });
  assert.ok(device);
  assert.equal(device.user_id, user.id);
  assert.equal(device.name, "MacBook");
  assert.equal(store.getDevice(device.id)?.id, device.id);
  assert.equal(store.rememberNonce(device.id, "nonce-1", 1000, 1600), true);
  assert.equal(store.rememberNonce(device.id, "nonce-1", 1000, 1601), false);
  assert.equal(store.revokeDevice(device.id, user.id, 1700), true);
  assert.ok(store.getDevice(device.id)?.revoked_at);

  console.log("relay user auth store tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
