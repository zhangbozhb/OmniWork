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

console.log("auth-key tests passed");
