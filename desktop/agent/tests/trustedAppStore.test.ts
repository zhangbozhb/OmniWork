import { strict as assert } from "node:assert";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateIdentityKeyPair } from "@omni-work/protocol-ts";

import { TrustedAppStore } from "../src/config/trustedAppStore.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-trusted-apps-"));
const path = join(dir, "nested", "trusted-apps-v2.json");
const identity = generateIdentityKeyPair("app");
const store = new TrustedAppStore(path);

const approved = store.approve({
  appId: identity.id,
  publicKey: identity.publicKey,
  displayName: "Alice iPhone",
  platform: "ios",
  scopes: ["device.control"],
  now: new Date("2026-09-16T00:00:00.000Z"),
});
assert.equal(approved.status, "active");
assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
assert.equal(statSync(path).mode & 0o777, 0o600);

const reopened = new TrustedAppStore(path);
assert.deepEqual(reopened.get(identity.id), approved);
assert.equal(
  reopened.revoke(identity.id, new Date("2026-09-16T00:01:00.000Z")),
  true,
);
assert.equal(reopened.get(identity.id)?.status, "revoked");
assert.equal(reopened.revoke(identity.id), false);
assert.equal(reopened.remove(identity.id), true);
assert.equal(reopened.get(identity.id), null);
assert.equal(reopened.remove(identity.id), false);
assert.equal(new TrustedAppStore(path).get(identity.id), null);

const otherIdentity = generateIdentityKeyPair("app");
assert.throws(
  () =>
    reopened.approve({
      appId: identity.id,
      publicKey: otherIdentity.publicKey,
      scopes: ["device.control"],
    }),
  /does not match/u,
);

writeFileSync(
  path,
  `${JSON.stringify({
    version: 1,
    apps: [{ ...approved, status: "active", scopes: ["admin"] }],
  })}\n`,
);
assert.throws(() => new TrustedAppStore(path), /is invalid/u);

console.log("trusted App store tests passed");
