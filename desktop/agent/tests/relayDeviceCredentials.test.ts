import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentConfig } from "../src/config/config.ts";
import {
  readRelayDeviceCredentials,
  writeRelayDeviceCredentials,
} from "../src/config/relayDeviceCredentials.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-relay-device-"));

try {
  const path = join(dir, "relay-device.json");
  writeRelayDeviceCredentials(path, {
    version: 1,
    relayUrl: "ws://relay.example/relay/ws/agent",
    deviceId: "dev_registered",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
    createdAt: "2026-06-27T00:00:00.000Z",
  });

  assert.equal((statSync(path).mode & 0o777), 0o600);
  assert.equal(readRelayDeviceCredentials(path)?.deviceId, "dev_registered");

  const config = loadAgentConfig(
    {
      OMNIWORK_APP_SUPPORT_DIR: dir,
      OMNIWORK_AGENT_RELAY_DEVICE_CREDENTIALS_PATH: path,
      OMNIWORK_TERMINAL_PROVIDERS: JSON.stringify([
        { kind: "terminal", displayName: "Terminal" },
      ]),
    },
    { commandExists: () => true },
  );
  assert.equal(config.relayUrl, "ws://relay.example/relay/ws/agent");
  assert.equal(config.deviceId, "dev_registered");
  assert.match(config.relayDevicePrivateKey ?? "", /BEGIN PRIVATE KEY/);

  console.log("relay device credentials tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
