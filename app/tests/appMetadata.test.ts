import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createAppInfo } from "../src/app/appMetadata.ts";
import { createPrivateNetworkHash } from "../src/lib/relay-client/mobileRelaySession.ts";

test("createAppInfo groups device and app metadata", () => {
  const appInfo = createAppInfo("app-1", "runtime-1", {
    deviceName: "Alice iPhone",
    privateNetworkHash: "private-network-hash",
  });

  assert.equal(appInfo.instance_id, "app-1");
  assert.equal(appInfo.runtime_id, "runtime-1");
  assert.equal(appInfo.device?.name, "Alice iPhone");
  assert.equal(appInfo.device?.private_network_hash, "private-network-hash");
  assert.equal(appInfo.app?.name, "OmniWork");
  assert.ok(appInfo.device?.platform);
  assert.ok(appInfo.app?.version);
});

test("createPrivateNetworkHash hashes sorted joined IP strings", () => {
  const expected = createHash("sha256")
    .update("10.0.0.2,192.168.1.20,fd00::1")
    .digest("hex");
  assert.equal(
    createPrivateNetworkHash(["fd00::1", "192.168.1.20", "10.0.0.2"]),
    expected,
  );
  assert.equal(createPrivateNetworkHash([]), undefined);
});
