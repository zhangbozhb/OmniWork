#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildTargets = [
  { name: "@omni-work/protocol-ts", path: "packages/protocol-ts" },
  { name: "@omni-work/relay-client", path: "packages/relay-client" },
  { name: "@omni-work/terminal-core", path: "packages/terminal-core" },
  { name: "@omni-work/e2e-noise", path: "packages/e2e-noise" },
  { name: "@omni-work/relay-server", path: "relay/server" },
  { name: "@omni-work/desktop-agent", path: "desktop/agent" },
];

for (const target of buildTargets) {
  rmSync(join(repoRoot, target.path, "dist"), {
    force: true,
    recursive: true,
  });
  run("pnpm", ["--filter", target.name, "build"]);
}

run(process.execPath, ["packages/web-app/scripts/build.mjs"]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}
