import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileService } from "../src/files/fileService.ts";

const root = await mkdtemp(join(tmpdir(), "omniwork-files-"));
await writeFile(join(root, ".DS_Store"), "metadata");
await writeFile(join(root, "target.txt"), "hello");
await mkdir(join(root, "target-dir"));
await symlink("target.txt", join(root, "linked-file"));
await symlink("target-dir", join(root, "linked-dir"));

const service = new FileService();
const result = await service.list(
  {
    path: root,
    isGitRepository: false,
    status: "available",
    source: "default",
  },
  "",
);

assert.equal(
  result.entries.some((entry) => entry.name === ".DS_Store"),
  false,
);

const linkedFile = result.entries.find((entry) => entry.name === "linked-file");
assert.ok(linkedFile);
assert.equal(linkedFile.type, "file");
assert.equal(linkedFile.isSymlink, true);

const linkedDir = result.entries.find((entry) => entry.name === "linked-dir");
assert.ok(linkedDir);
assert.equal(linkedDir.type, "directory");
assert.equal(linkedDir.isSymlink, true);
