import { strict as assert } from "node:assert";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isValidIdentityId,
  validateIdentityKeyPair,
} from "@omni-work/protocol-ts";

import {
  resolveAgentIdentity,
  safeKeychainAvailable,
  type AgentIdentityRecord,
} from "../src/config/deviceIdentity.ts";

const dir = await mkdtemp(join(tmpdir(), "omniwork-device-identity-"));
const identityPath = join(dir, ".omniwork", "identity-v2.json");
const createdAt = new Date("2026-09-16T00:00:00.000Z");
const options = {
  identityPath,
  keychainEnabled: false,
  now: createdAt,
};

const first = resolveAgentIdentity(options);
const second = resolveAgentIdentity({
  ...options,
  now: new Date("2026-09-16T00:01:00.000Z"),
});

assert.deepEqual(second, first);
assert.equal(isValidIdentityId(first.id, "agent"), true);
assert.equal(validateIdentityKeyPair(first, "agent"), true);
assert.equal(first.createdAt, createdAt.toISOString());
assert.equal((await stat(join(dir, ".omniwork"))).mode & 0o777, 0o700);
assert.equal((await stat(identityPath)).mode & 0o777, 0o600);

const stored = JSON.parse(
  await readFile(identityPath, "utf8"),
) as AgentIdentityRecord;
assert.deepEqual(stored, first);

await writeFile(
  identityPath,
  `${JSON.stringify({ ...stored, id: stored.id.slice(0, -1) }, null, 2)}\n`,
);
assert.throws(
  () => resolveAgentIdentity(options),
  /identity .* is invalid/u,
);

assert.equal(
  safeKeychainAvailable({
    platform: "linux",
    execFile() {
      throw new Error("should not be called");
    },
  }),
  false,
);

const securityCalls: Array<{ command: string; args: string[] }> = [];
assert.equal(
  safeKeychainAvailable({
    platform: "darwin",
    homeDir: "/Users/test",
    exists(path) {
      return path === "/Users/test/Library/Keychains/login.keychain-db";
    },
    execFile(command, args) {
      securityCalls.push({ command, args });
      return args[0] === "default-keychain"
        ? "\"~/Library/Keychains/login.keychain-db\"\n"
        : "";
    },
  }),
  true,
);
assert.deepEqual(securityCalls, [
  {
    command: "security",
    args: ["default-keychain", "-d", "user"],
  },
  {
    command: "security",
    args: [
      "show-keychain-info",
      "/Users/test/Library/Keychains/login.keychain-db",
    ],
  },
]);

console.log("device identity tests passed");
