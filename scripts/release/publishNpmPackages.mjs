#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = parseArgs(process.argv.slice(2));
const registry = args.registry ?? "https://registry.npmjs.org/";
const dryRun = Boolean(args.dryRun);
const skipBuild = Boolean(args.skipBuild);
const tag = args.tag ?? "latest";
const access = args.access ?? "public";

const publishPackages = [
  { name: "@omni-work/protocol-ts", path: "packages/protocol-ts" },
  { name: "@omni-work/relay-client", path: "packages/relay-client" },
  { name: "@omni-work/terminal-core", path: "packages/terminal-core" },
  { name: "@omni-work/e2e-noise", path: "packages/e2e-noise" },
  { name: "@omni-work/surface-hook-post", path: "packages/surface-hook-post" },
  {
    name: "@omni-work/surface-hook-record",
    path: "packages/surface-hook-record",
  },
  { name: "@omni-work/relay-server", path: "relay/server" },
  { name: "@omni-work/desktop-agent", path: "desktop/agent" },
  { name: "@omni-work/web-app", path: "packages/web-app" },
];

if (!skipBuild) {
  run(process.execPath, ["scripts/release/buildNpmPackages.mjs"], repoRoot);
}
run(process.execPath, ["scripts/release/verifyNpmPackages.mjs"], repoRoot);

for (const target of publishPackages) {
  const packageDir = join(repoRoot, target.path);
  const packageJson = readPackageJson(packageDir);
  if (packageJson.name !== target.name) {
    throw new Error(
      `[publish:npm] Expected ${target.name} at ${target.path}, got ${packageJson.name}.`,
    );
  }
  if (packageJson.private) {
    throw new Error(`[publish:npm] ${target.name} is private.`);
  }
  assertNoWorkspaceDependencies(packageJson, target.name);

  const publishArgs = [
    "publish",
    "--registry",
    registry,
    "--access",
    access,
    "--tag",
    tag,
  ];
  if (dryRun) {
    publishArgs.push("--dry-run");
  }
  if (args.otp) {
    publishArgs.push("--otp", args.otp);
  }
  if (args.provenance) {
    publishArgs.push("--provenance");
  }

  run("npm", publishArgs, packageDir);
}

function readPackageJson(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
}

function assertNoWorkspaceDependencies(packageJson, packageName) {
  const dependencyGroups = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  for (const group of dependencyGroups) {
    const dependencies = packageJson[group] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (String(version).startsWith("workspace:")) {
        throw new Error(
          `[publish:npm] ${packageName} has workspace dependency ${name}: ${version}.`,
        );
      }
    }
  }
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `[publish:npm] Command failed: ${command} ${commandArgs.join(" ")}`,
    );
  }
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`[publish:npm] Unexpected argument: ${token}`);
    }
    const [key, inlineValue] = token.slice(2).split("=", 2);
    const value =
      inlineValue ??
      (!rawArgs[index + 1] || rawArgs[index + 1].startsWith("--")
        ? "true"
        : rawArgs[(index += 1)]);
    parsed[toCamelCase(key)] = value === "true" ? true : value;
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
