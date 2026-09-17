import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateIdentityKeyPair } from "@omni-work/protocol-ts";

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
  const identity = generateIdentityKeyPair("agent");
  const device = store.consumeDeviceEnrollment({
    token: enrollment.token,
    deviceId: identity.id,
    publicKey: identity.publicKey,
    name: "MacBook",
    maxDevicesPerUser: 10,
    now: 1500,
  });
  assert.ok(device);
  assert.equal(device.user_id, user.id);
  assert.equal(device.name, "MacBook");
  assert.equal(store.getDevice(device.id)?.id, device.id);
  const retryToken = store.createDeviceEnrollment({ userId: user.id, ttlMs: 1000, now: 1501 });
  assert.equal(store.consumeDeviceEnrollment({
    token: retryToken.token,
    deviceId: identity.id,
    publicKey: identity.publicKey,
    maxDevicesPerUser: 1,
    now: 1600,
  })?.id, device.id);
  assert.equal(store.revokeDevice(device.id, user.id, 1700), true);
  assert.ok(store.getDevice(device.id)?.revoked_at);

  const restoreToken = store.createDeviceEnrollment({ userId: user.id, ttlMs: 1000, now: 1800 });
  assert.equal(store.consumeDeviceEnrollment({
    token: restoreToken.token,
    deviceId: identity.id,
    publicKey: identity.publicKey,
    maxDevicesPerUser: 1,
    now: 1900,
  })?.id, device.id);
  assert.equal(store.getDevice(device.id)?.revoked_at, null);
  assert.equal(store.consumeDeviceEnrollment({
    token: restoreToken.token, deviceId: identity.id, publicKey: identity.publicKey,
    maxDevicesPerUser: 1, now: 1901,
  }), null);

  const otherLink = store.createEmailLink({ email: "other@example.com", ttlMs: 1000, now: 2000 });
  const otherUser = store.consumeEmailLink(otherLink.token, 2001)!;
  const otherToken = store.createDeviceEnrollment({ userId: otherUser.id, ttlMs: 1000, now: 2002 });
  assert.equal(store.consumeDeviceEnrollment({
    token: otherToken.token, deviceId: identity.id, publicKey: identity.publicKey,
    maxDevicesPerUser: 10, now: 2003,
  }), null);
  assert.equal(store.getDevice(device.id)?.user_id, user.id);

  console.log("relay user auth store tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
