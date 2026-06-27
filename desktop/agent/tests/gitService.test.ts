import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { WorkspaceDefinition } from "@omniwork/protocol-ts";
import { GitService } from "../src/git/gitService.ts";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function createRepo(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  await runGit(workspacePath, ["init"]);
  await runGit(workspacePath, ["config", "user.email", "test@example.com"]);
  await runGit(workspacePath, ["config", "user.name", "OmniWork Test"]);
  await writeFile(join(workspacePath, "tracked.txt"), "tracked\n");
  await runGit(workspacePath, ["add", "tracked.txt"]);
  await runGit(workspacePath, ["commit", "-m", "initial"]);
  return workspacePath;
}

function workspace(path: string): WorkspaceDefinition {
  return {
    path,
    name: "repo",
    isGitRepository: true,
    status: "available",
    source: "session",
  };
}

// Large untracked files should not be read into memory just to compute line stats.
{
  const workspacePath = await createRepo("omniwork-git-large-");
  await writeFile(join(workspacePath, "small.txt"), "one\ntwo\n");
  await writeFile(join(workspacePath, "large.log"), "x".repeat(300 * 1024));

  const payload = await new GitService().status(workspace(workspacePath));
  const small = payload.status.files.find((file) => file.path === "small.txt");
  const large = payload.status.files.find((file) => file.path === "large.log");

  assert.equal(small?.status, "untracked");
  assert.equal(small?.unstagedAdditions, 2);
  assert.equal(large?.status, "untracked");
  assert.equal(large?.unstagedAdditions, 0);
}

// Binary untracked files are listed, but their contents are not treated as text.
{
  const workspacePath = await createRepo("omniwork-git-binary-");
  await writeFile(join(workspacePath, "binary.txt"), Buffer.from([0, 1, 2, 3]));

  const payload = await new GitService().status(workspace(workspacePath));
  const binary = payload.status.files.find(
    (file) => file.path === "binary.txt",
  );

  assert.equal(binary?.status, "untracked");
  assert.equal(binary?.unstagedAdditions, 0);
}

// Lock files are listed, but their generated content is not read for line stats.
{
  const workspacePath = await createRepo("omniwork-git-lock-");
  await writeFile(
    join(workspacePath, "package-lock.json"),
    '{\n  "lockfileVersion": 3\n}\n',
  );

  const payload = await new GitService().status(workspace(workspacePath));
  const lock = payload.status.files.find(
    (file) => file.path === "package-lock.json",
  );

  assert.equal(lock?.status, "untracked");
  assert.equal(lock?.unstagedAdditions, 0);
}

// Untracked line stats are capped so a noisy workspace cannot spawn unbounded IO.
{
  const workspacePath = await createRepo("omniwork-git-many-");
  for (let index = 0; index < 205; index += 1) {
    await writeFile(
      join(workspacePath, `bulk-${String(index).padStart(3, "0")}.txt`),
      "line\n",
    );
  }

  const payload = await new GitService().status(workspace(workspacePath));
  const bulkFiles = payload.status.files.filter((file) =>
    file.path.startsWith("bulk-"),
  );
  const stattedCount = bulkFiles.filter(
    (file) => file.unstagedAdditions === 1,
  ).length;
  const skippedCount = bulkFiles.filter(
    (file) => file.unstagedAdditions === 0,
  ).length;

  assert.equal(bulkFiles.length, 205);
  assert.equal(stattedCount, 200);
  assert.equal(skippedCount, 5);
}

console.log("gitService tests passed");
