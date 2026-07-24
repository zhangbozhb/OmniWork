#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  accessSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseVersion = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).version;
const packagePaths = [
  "packages/protocol-ts",
  "packages/relay-client",
  "packages/terminal-core",
  "packages/e2e-noise",
  "packages/surface-hook-post",
  "packages/surface-hook-record",
  "relay/server",
  "desktop/agent",
  "packages/web-app",
];
const temporaryRoot = mkdtempSync(join(tmpdir(), "omniwork-npm-verify-"));
const tarballDir = join(temporaryRoot, "tarballs");
mkdirSync(tarballDir);

try {
  accessSync(join(repoRoot, "LICENSE"));
  const tarballs = packagePaths.map(packPackage);
  writeFileSync(
    join(temporaryRoot, "package.json"),
    JSON.stringify({ private: true }, null, 2),
  );
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--registry",
      "https://registry.npmjs.org/",
      ...tarballs,
    ],
    temporaryRoot,
  );

  writeFileSync(
    join(temporaryRoot, "verify.mjs"),
    createVerificationScript(),
  );
  run(process.execPath, ["verify.mjs"], temporaryRoot);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function packPackage(packagePath) {
  const packageDir = join(repoRoot, packagePath);
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  assertPackageMetadata(packageJson, packagePath);
  accessSync(join(packageDir, "LICENSE"));
  accessSync(join(packageDir, "README.md"));
  const output = run(
    "npm",
    ["pack", "--json", "--pack-destination", tarballDir],
    packageDir,
    true,
  );
  const packed = JSON.parse(output);
  if (!packed[0].files.some((file) => file.path === "LICENSE")) {
    throw new Error(`${packagePath} tarball does not contain LICENSE.`);
  }
  return join(tarballDir, packed[0].filename);
}

function assertPackageMetadata(packageJson, packagePath) {
  if (packageJson.version !== releaseVersion) {
    throw new Error(
      `${packagePath} version ${packageJson.version} does not match ${releaseVersion}.`,
    );
  }
  for (const field of [
    "description",
    "keywords",
    "license",
    "author",
    "repository",
    "homepage",
    "bugs",
  ]) {
    if (!packageJson[field]) {
      throw new Error(`${packagePath} is missing package.json field ${field}.`);
    }
  }
  for (const dependencies of [
    packageJson.dependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ]) {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      if (name.startsWith("@omni-work/") && version !== releaseVersion) {
        throw new Error(
          `${packagePath} dependency ${name} must use ${releaseVersion}.`,
        );
      }
    }
  }
}

function createVerificationScript() {
  return `
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

for (const packageName of [
  "@omni-work/protocol-ts",
  "@omni-work/relay-client",
  "@omni-work/terminal-core",
  "@omni-work/e2e-noise",
]) {
  await import(packageName);
}

await access("node_modules/@omni-work/web-app/dist/index.html");
runBinary("omniwork-agent", ["--check"]);
runBinary("omniwork-relay", ["--check"]);

function runBinary(name, args) {
  const executable = join(
    "node_modules",
    ".bin",
    process.platform === "win32" ? \`\${name}.cmd\` : name,
  );
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      OMNIWORK_RELAY_URL: "wss://relay.example.com/relay/ws/agent",
    },
  });
  if (result.status !== 0) {
    throw new Error(\`\${name} smoke check failed.\`);
  }
}
`;
}

function run(command, args, cwd, captureOutput = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: captureOutput ? "utf8" : undefined,
    stdio: captureOutput ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    if (captureOutput) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
  return captureOutput ? result.stdout : "";
}
