import { strict as assert } from "node:assert";
import { stat, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countTextLines,
  isIgnoredDirectory,
  isIgnoredEntryName,
  isLikelyBinary,
  shouldCountUntrackedGitLines,
} from "../src/files/fileTypePolicy.ts";

const root = await mkdtemp(join(tmpdir(), "omniwork-file-policy-"));
const sourceFile = join(root, "source.ts");
const lockFile = join(root, "package-lock.json");
const archiveFile = join(root, "archive.zip");
await mkdir(join(root, "dist"));
const generatedFile = join(root, "dist", "bundle.js");

await writeFile(sourceFile, "one\ntwo\n");
await writeFile(lockFile, "{}\n");
await writeFile(archiveFile, "zip");
await writeFile(generatedFile, "compiled\n");

assert.equal(isIgnoredEntryName(".DS_Store"), true);
assert.equal(isIgnoredDirectory("node_modules", "directory"), true);
assert.equal(isIgnoredDirectory("coverage", "directory"), true);
assert.equal(isIgnoredDirectory("node_modules", "file"), false);

assert.equal(
  shouldCountUntrackedGitLines("source.ts", await stat(sourceFile)),
  true,
);
assert.equal(
  shouldCountUntrackedGitLines("package-lock.json", await stat(lockFile)),
  false,
);
assert.equal(
  shouldCountUntrackedGitLines("archive.zip", await stat(archiveFile)),
  false,
);
assert.equal(
  shouldCountUntrackedGitLines("dist/bundle.js", await stat(generatedFile)),
  false,
);

assert.equal(countTextLines(Buffer.from("one\ntwo\n")), 2);
assert.equal(countTextLines(Buffer.from("one\ntwo")), 2);
assert.equal(isLikelyBinary(Buffer.from([0, 1, 2, 3])), true);
assert.equal(isLikelyBinary(Buffer.from("plain text\n")), false);

console.log("fileTypePolicy tests passed");
