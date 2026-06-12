import { strict as assert } from "node:assert";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCheckFactorHash,
  createIdentityChecksum,
  resolveAgentDeviceId,
  type AgentIdentityRecord,
} from "../src/config/deviceIdentity.ts";

assert.equal(
  createCheckFactorHash({ ipAddress: "10.0.0.2", hostname: "test-host" }),
  "664b98f90a299830d6ea10e4d4442209f8088241c75a1434586d3407a3d4cf25",
);
assert.equal(
  createIdentityChecksum("dev_test", {
    ipAddress: "10.0.0.2",
    hostname: "test-host",
  }),
  "17239d90c3f705495eafd31a33fb4dbe71ce13cd713778cdd07150c5ccc39cc7",
);

const dir = await mkdtemp(join(tmpdir(), "omniwork-device-"));
const identityPath = join(dir, ".omniwork", "agent.json");
const options = {
  identityPath,
  ipAddress: "10.0.0.2",
  hostname: "test-host",
  keychainEnabled: false,
  now: new Date("2026-06-12T00:00:00.000Z"),
};

const firstDeviceId = resolveAgentDeviceId(options);
assert.match(firstDeviceId, /^dev_[0-9a-f]{16}$/);
assert.equal(resolveAgentDeviceId(options), firstDeviceId);
assert.equal((await stat(join(dir, ".omniwork"))).mode & 0o777, 0o700);
assert.equal((await stat(identityPath)).mode & 0o777, 0o600);

const raw = await readFile(identityPath, "utf8");
const record = JSON.parse(raw) as AgentIdentityRecord;
assert.equal(record.version, 1);
assert.equal(record.deviceId, firstDeviceId);
assert.equal(record.createdAt, "2026-06-12T00:00:00.000Z");
assert.equal(record.updatedAt, "2026-06-12T00:00:00.000Z");
assert.equal(
  record.checksum,
  createIdentityChecksum(firstDeviceId, options),
);

await writeFile(
  identityPath,
  `${JSON.stringify({ ...record, checksum: "bad" }, null, 2)}\n`,
);
const secondDeviceId = resolveAgentDeviceId({
  ...options,
  now: new Date("2026-06-12T00:01:00.000Z"),
});
assert.match(secondDeviceId, /^dev_[0-9a-f]{16}$/);
assert.notEqual(secondDeviceId, firstDeviceId);

console.log("device identity tests passed");
