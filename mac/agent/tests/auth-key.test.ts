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
import { parsePairingLink } from "../../../packages/protocol-ts/src/index.ts";

const key = generateSessionKey();
assert.equal(key.length, 32);
assert.match(key, /^[A-Za-z0-9_-]{32}$/);

const keyId = createKeyId(key);
assert.match(keyId, /^sha256:[0-9a-f]{12}$/);

const nonce = "nonce_for_test_123456";
const proof = createProof(key, nonce);
assert.equal(verifyProof(key, nonce, proof), true);
assert.equal(verifyProof(key, nonce, `${proof}x`), false);

const dir = await mkdtemp(join(tmpdir(), "omniwork-agent-"));
const path = join(dir, "nested", "session-key.json");
const record = await createAndPersistSessionKey({
  path,
  agentInstanceId: createAgentInstanceId(new Date("2026-05-12T00:00:00Z")),
  relayUrl: "wss://relay.example/agent",
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
  relayUrl: "wss://relay.example/agent",
  pairingTransport: "websocket",
  codexCommand: "codex",
  claudeCommand: "claude",
  defaultCwd: dir,
  appSupportDir: dir,
  sessionKeyPath: path,
  sessionStorePath: join(dir, "sessions.json"),
  terminalSize: { cols: 80, rows: 24 },
};

assert.equal(
  createPairingQrDetails(baseConfig, record)?.payload.relay_url,
  "wss://relay.example/mobile",
);
assert.equal(
  createPairingQrDetails(baseConfig, record)?.payload.transport,
  "websocket",
);
assert.equal(
  parsePairingLink(createPairingQrDetails(baseConfig, record)?.link ?? "")
    ?.transport,
  "websocket",
);
assert.equal(
  parsePairingLink(
    "omniwork://pair?relay_url=ws%3A%2F%2Frelay.example%2Fmobile&device_id=test&key=abc&transport=relay",
  )?.transport,
  undefined,
);

const publicWebRtcPairing = createPairingQrDetails(
  {
    ...baseConfig,
    pairingRelayUrl: "ws://public.example:8790/mobile",
    pairingTransport: "webrtc",
  },
  record,
);
assert.equal(
  publicWebRtcPairing?.payload.relay_url,
  "ws://public.example:8790/mobile",
);
assert.equal(publicWebRtcPairing?.payload.transport, "webrtc");

assert.equal(
  loadAgentConfig({ OMNIWORK_PAIRING_TRANSPORT: "websocket" }).pairingTransport,
  "websocket",
);
assert.equal(
  loadAgentConfig({ OMNIWORK_PAIRING_TRANSPORT: "webrtc" }).pairingTransport,
  "webrtc",
);
assert.equal(
  loadAgentConfig({ OMNIWORK_DEVICE_ID: "" }).deviceId.includes(".local"),
  false,
);
assert.equal(
  loadAgentConfig({ OMNIWORK_DEVICE_ID: "custom-device" }).deviceId,
  "custom-device",
);

console.log("auth-key tests passed");
