import { strict as assert } from "node:assert";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProbeToken } from "../src/config/probeToken.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-probe-token-"));
const path = join(dir, "nested", "probe-token.json");
const generated = resolveProbeToken(path);

assert.ok(generated.length >= 32);
assert.equal(resolveProbeToken(path), generated);
assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
assert.equal(statSync(path).mode & 0o777, 0o600);

const configured = "configured-probe-token-that-is-long-enough";
assert.equal(resolveProbeToken(path, configured), configured);
assert.equal(resolveProbeToken(path), configured);
assert.throws(
  () => resolveProbeToken(path, "too-short"),
  /at least 32 characters/u,
);

writeFileSync(path, '{"version":1,"token":"short","createdAt":"now"}\n');
assert.throws(() => resolveProbeToken(path), /is invalid/u);

console.log("probe token tests passed");
