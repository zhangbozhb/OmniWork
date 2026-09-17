import assert from "node:assert/strict";
import test from "node:test";
import type { AppIdentity } from "../src/features/auth/appIdentity.ts";
import { createAppIdentityStore } from "../src/platform/identity/appIdentityStoreCache.ts";

const identity = (id: string): AppIdentity => ({
  record: {
    id, version: 1, algorithm: "Ed25519", role: "app",
    publicKey: "test", createdAt: new Date(0).toISOString(),
  },
  sign: async () => "signature",
});

test("concurrent identity readers share a single initialization", async () => {
  let loads = 0;
  const store = createAppIdentityStore(async () => {
    loads += 1;
    await Promise.resolve();
    return identity(`identity_${loads}`);
  }, async () => {});
  const [connection, settings] = await Promise.all([
    store.getOrCreateAppIdentity(),
    store.getOrCreateAppIdentity(),
  ]);
  assert.equal(loads, 1);
  assert.equal(connection, settings);
  assert.equal(await store.getOrCreateAppIdentity(), connection);
});

test("identity reset waits for an in-flight initialization", async () => {
  let resolveLoad!: (value: AppIdentity) => void;
  const initial = new Promise<AppIdentity>((resolve) => {
    resolveLoad = resolve;
  });
  let loads = 0;
  let removed = false;
  const store = createAppIdentityStore(
    async () => ++loads === 1 ? initial : identity("after_reset"),
    async () => { removed = true; },
  );
  const oldReader = store.getOrCreateAppIdentity();
  const resetting = store.resetAppIdentity();
  const newReader = store.getOrCreateAppIdentity();
  await Promise.resolve();
  assert.equal(removed, false);
  resolveLoad(identity("before_reset"));
  assert.equal((await oldReader).record.id, "before_reset");
  assert.equal((await resetting).record.id, "after_reset");
  assert.equal(await newReader, await resetting);
  assert.equal(removed, true);
  assert.equal(loads, 2);
});

test("failed identity initialization can retry", async () => {
  let loads = 0;
  const store = createAppIdentityStore(async () => {
    if (++loads === 1) {
      throw new Error("storage temporarily unavailable");
    }
    return identity("recovered");
  }, async () => {});
  await assert.rejects(store.getOrCreateAppIdentity(), /unavailable/u);
  assert.equal((await store.getOrCreateAppIdentity()).record.id, "recovered");
});
