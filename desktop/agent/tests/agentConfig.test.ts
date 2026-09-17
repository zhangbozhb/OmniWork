import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadAgentConfig } from "../src/config/config.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-agent-config-"));
const configPath = join(dir, "config.yml");
const identityPath = join(dir, "identity-v2.json");

function loadConfig(
  appAuthorization = "",
  env: NodeJS.ProcessEnv = {},
) {
  writeFileSync(
    configPath,
    [
      "relay:",
      "  url: wss://relay.example/relay/ws/agent",
      "agent:",
      `  identityPath: ${identityPath}`,
      appAuthorization,
      "",
    ].join("\n"),
  );
  return loadAgentConfig(env, {
    configPath,
    keychainEnabled: false,
    commandExists: () => false,
  });
}

test("Desktop Agent App authorization defaults to manual", () => {
  assert.equal(loadConfig().appAuthorizationMode, "manual");
});

test("Desktop Agent App authorization can be automatic in YAML", () => {
  assert.equal(
    loadConfig("appAuthorization:\n  mode: automatic").appAuthorizationMode,
    "automatic",
  );
});

test("Desktop Agent rejects unsupported App authorization modes", () => {
  assert.throws(
    () => loadConfig("appAuthorization:\n  mode: permissive"),
    /Use manual or automatic/u,
  );
});
