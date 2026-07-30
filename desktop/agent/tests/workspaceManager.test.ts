import assert from "node:assert/strict";
import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceManager } from "../src/workspace/workspaceManager.ts";

test("resolveCreateCwd creates a missing working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omniwork-workspace-"));
  const cwd = join(root, "new", "project");
  const manager = new WorkspaceManager({ defaultCwd: root });

  const resolved = await manager.resolveCreateCwd({ cwd });
  const canonicalCwd = await realpath(cwd);

  assert.equal((await stat(cwd)).isDirectory(), true);
  assert.equal(resolved.cwd, canonicalCwd);
  assert.equal(resolved.workspace?.path, canonicalCwd);
  assert.equal(resolved.workspace?.status, "available");
});

test("resolveCreateCwd creates a missing workspace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "omniwork-workspace-"));
  const workspacePath = join(root, "workspace");
  const manager = new WorkspaceManager({ defaultCwd: root });

  const resolved = await manager.resolveCreateCwd({
    workspace_path: workspacePath,
  });
  const canonicalWorkspacePath = await realpath(workspacePath);

  assert.equal((await stat(workspacePath)).isDirectory(), true);
  assert.equal(resolved.cwd, canonicalWorkspacePath);
  assert.equal(resolved.workspace?.path, canonicalWorkspacePath);
});

test("resolveCreateCwd rejects a path that is not a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omniwork-workspace-"));
  const filePath = join(root, "file.txt");
  await writeFile(filePath, "not a directory");
  const manager = new WorkspaceManager({ defaultCwd: root });

  await assert.rejects(
    manager.resolveCreateCwd({ cwd: filePath }),
    /Working directory is not a directory/u,
  );
});

test("resolveCreateCwd fails when the directory cannot be created", async () => {
  const root = await mkdtemp(join(tmpdir(), "omniwork-workspace-"));
  const parentFile = join(root, "parent");
  await writeFile(parentFile, "blocks mkdir");
  const manager = new WorkspaceManager({ defaultCwd: root });

  await assert.rejects(
    manager.resolveCreateCwd({ cwd: join(parentFile, "child") }),
    /Failed to create working directory/u,
  );
});
