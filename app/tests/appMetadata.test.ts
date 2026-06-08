import assert from "node:assert/strict";
import test from "node:test";

import { createAppInfo } from "../src/app/appMetadata.ts";

test("createAppInfo includes platform and version metadata", () => {
  const appInfo = createAppInfo("app-1", "runtime-1");

  assert.equal(appInfo.instance_id, "app-1");
  assert.equal(appInfo.runtime_id, "runtime-1");
  assert.equal(appInfo.name, "OmniWork");
  assert.ok(appInfo.platform);
  assert.ok(appInfo.version);
});
