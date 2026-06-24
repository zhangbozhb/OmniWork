import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = parseArgs(process.argv.slice(2));
const rootPackage = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const agentPackage = JSON.parse(
  readFileSync(join(repoRoot, "desktop", "agent", "package.json"), "utf8"),
);
const version = normalizeVersion(
  args.version ?? process.env.OMNIWORK_RELEASE_VERSION ?? rootPackage.version,
);
const packageVersion = version.slice(1);
const platform = args.platform ?? `${process.platform}-${process.arch}`;
const outDir = resolve(
  repoRoot,
  args.outDir ??
    process.env.OMNIWORK_RELEASE_ASSETS_DIR ??
    join("dist", "release"),
);
const packageFileName = `omniwork-desktop-agent-${version}-${platform}.tgz`;
const packagePath = join(outDir, packageFileName);
const packageName = `omniwork-desktop-agent-${version}-${platform}`;
const stagingParent = join(repoRoot, "dist", "release-work");
const stagingDir = join(stagingParent, packageName);

if (agentPackage.version !== packageVersion) {
  throw new Error(
    `[release] Desktop Agent package version (${agentPackage.version}) does not match release version (${packageVersion}).`,
  );
}

rmSync(packagePath, { force: true });
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@omniwork/desktop-agent",
    "deploy",
    "--prod",
    "--legacy",
    stagingDir,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  throw new Error(
    "[release] Failed to create desktop Agent deployment directory.",
  );
}

writeFileSync(
  join(stagingDir, "README.release.md"),
  [
    `# OmniWork Desktop Agent ${version}`,
    "",
    `This is a ${platform} Node.js deployment package generated from the workspace with production dependencies included.`,
    "",
    "Run from the extracted directory:",
    "",
    "```bash",
    "node --experimental-strip-types src/main.ts",
    "```",
    "",
    "The package also exposes bin scripts in `bin/` for future npm/global install flows.",
    "",
  ].join("\n"),
);

const tarResult = spawnSync(
  "tar",
  ["-czf", packagePath, "-C", stagingParent, packageName],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (tarResult.status !== 0 || !existsSync(packagePath)) {
  throw new Error("[release] Failed to create desktop Agent .tgz package.");
}

console.log("[release] desktop Agent Node deployment package created:");
console.log(`  ${packagePath}`);

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`[release] Unexpected argument: ${token}`);
    }
    const [key, inlineValue] = token.slice(2).split("=", 2);
    const value =
      inlineValue ??
      (rawArgs[index + 1]?.startsWith("--") ? "true" : rawArgs[(index += 1)]);
    parsed[toCamelCase(key)] = value;
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function normalizeVersion(value) {
  if (!value) {
    throw new Error("[release] Missing version.");
  }
  return value.startsWith("v") ? value : `v${value}`;
}
