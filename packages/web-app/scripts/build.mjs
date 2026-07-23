#!/usr/bin/env node
import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repoRoot = resolve(packageDir, "../..");
const appDir = resolve(repoRoot, "app");
const sourceDist = resolve(appDir, "dist/web");
const targetDist = resolve(packageDir, "dist");

const result = spawnSync("pnpm", ["--dir", appDir, "web:build"], {
  stdio: "inherit",
  env: { ...process.env, GENERATE_SOURCEMAP: "false" },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await rm(targetDist, { recursive: true, force: true });
await cp(sourceDist, targetDist, { recursive: true });
