import { strict as assert } from "node:assert";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentInstanceId,
  createAndPersistSessionKey,
  createKeyId,
  createProof,
  generateSessionKey,
  verifyProof,
} from "../src/auth-key/authKey.ts";
import { loadAgentConfig, type AgentConfig } from "../src/config/config.ts";
import { createPairingQrDetails } from "../src/pairing/pairingQr.ts";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  parsePairingLink,
} from "@omniwork/protocol-ts";

const key = generateSessionKey();
assert.equal(key.length, 32);
assert.match(key, /^[A-Za-z0-9_-]{32}$/);

const keyId = createKeyId(key);
assert.match(keyId, /^sha256:[0-9a-f]{12}$/);

const nonce = "nonce_for_test_123456";
const appInfo = {
  instance_id: "app_test_1",
  runtime_id: "runtime_test_1",
};
const proof = createProof(key, nonce, appInfo);
assert.equal(verifyProof(key, nonce, appInfo, proof), true);
assert.equal(
  verifyProof(key, nonce, { ...appInfo, instance_id: "app_test_2" }, proof),
  false,
);
assert.equal(
  verifyProof(key, nonce, appInfo, `${proof}x`),
  false,
);

const dir = await mkdtemp(join(tmpdir(), "omniwork-agent-"));
const path = join(dir, "nested", "session-key.json");
const record = await createAndPersistSessionKey({
  path,
  agentInstanceId: createAgentInstanceId(new Date("2026-05-12T00:00:00Z")),
  relayUrl: "wss://relay.example/relay/ws/agent",
  now: new Date("2026-05-12T00:00:00Z"),
});

const raw = await readFile(path, "utf8");
assert.equal(JSON.parse(raw).key_id, record.key_id);
assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
assert.equal((await stat(path)).mode & 0o777, 0o600);

const baseConfig: AgentConfig = {
  agentVersion: "test",
  deviceId: "test-mac",
  hostname: "test.local",
  relayUrl: "wss://relay.example/relay/ws/agent",
  adminEnabled: true,
  adminHost: "127.0.0.1",
  adminPort: 17668,
  connectionHeartbeatMs: 10000,
  connectionStaleMs: 30000,
  connectionDisconnectMs: 90000,
  relayReconnectMaxAttempts: 8,
  relayReconnectInitialDelayMs: 1000,
  relayReconnectMaxDelayMs: 30000,
  agentProviders: [...DEFAULT_AGENT_PROVIDER_DEFINITIONS],
  defaultCwd: dir,
  appSupportDir: dir,
  sessionKeyPath: path,
  sessionStorePath: join(dir, "sessions.sqlite"),
  terminalSize: { cols: 80, rows: 24 },
  businessSecurityMode: "e2e_required",
};

assert.equal(
  createPairingQrDetails(baseConfig, record)?.payload.relay_url,
  "wss://relay.example/relay/ws/mobile",
);
assert.equal(
  parsePairingLink(createPairingQrDetails(baseConfig, record)?.link ?? "")
    ?.relay_url,
  "wss://relay.example/relay/ws/mobile",
);

assert.throws(
  () => loadAgentConfig({ OMNIWORK_DEVICE_ID: "" }),
  /OMNIWORK_RELAY_URL is required/,
);
const configEnv = {
  OMNIWORK_RELAY_URL: "wss://relay.example/relay/ws/agent",
  OMNIWORK_AGENT_IDENTITY_PATH: join(dir, "agent.json"),
  OMNIWORK_AGENT_IDENTITY_KEYCHAIN: "0",
  OMNIWORK_AGENT_IDENTITY_IP: "10.0.0.2",
};
assert.match(
  loadAgentConfig({ ...configEnv, OMNIWORK_DEVICE_ID: "" }).deviceId,
  /^dev_[0-9a-f]{16}$/,
);
assert.equal(
  loadAgentConfig({
    ...configEnv,
    OMNIWORK_DEVICE_ID: "custom-device",
  }).deviceId,
  "custom-device",
);
assert.deepEqual(
  loadAgentConfig({
    ...configEnv,
    OMNIWORK_AGENT_PROVIDERS: JSON.stringify([
      {
        kind: "opencode",
        displayName: "OpenCode",
        command: "opencode",
      },
    ]),
  }).agentProviders,
  [
    {
      kind: "opencode",
      displayName: "OpenCode",
      capability: "opencode.cli",
      summary: "OpenCode CLI TUI session",
      defaultCommand: "opencode",
      creatable: true,
    },
  ],
);

console.log("auth-key tests passed");
