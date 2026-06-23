import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const deployRoot = join(repoRoot, "dist", "deploy");
const siteSource = join(repoRoot, "site", "dist");
const appSource = join(repoRoot, "app", "dist", "web");
const adminSource = join(repoRoot, "web", "admin");
const siteTarget = join(deployRoot, "site");
const appTarget = join(deployRoot, "app");
const adminTarget = join(deployRoot, "admin");
const appPackagePath = join(repoRoot, "app", "package.json");

assertDirectory(
  siteSource,
  "Run `pnpm site:build` before preparing deploy assets.",
);
assertDirectory(
  appSource,
  "Run `pnpm app:build:web` before preparing deploy assets.",
);
assertDirectory(adminSource, "Admin web source assets are missing.");

rmSync(deployRoot, { recursive: true, force: true });
mkdirSync(deployRoot, { recursive: true });

cpSync(siteSource, siteTarget, { recursive: true });
cpSync(appSource, appTarget, { recursive: true });
writeFileSync(
  join(appTarget, "omniwork-config.js"),
  runtimeConfigSource(productionAppConfig()),
);
cpSync(adminSource, adminTarget, { recursive: true });

console.log("[omniwork-deploy] web assets prepared:");
console.log(`  site:  ${siteTarget}`);
console.log(`  app:   ${appTarget}`);
console.log(`  admin: ${adminTarget}`);

function assertDirectory(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`[omniwork-deploy] Missing directory: ${path}. ${hint}`);
  }
}

function productionAppConfig() {
  const appPackage = JSON.parse(readFileSync(appPackagePath, "utf8"));
  return withoutUndefined({
    appVersion: process.env.OMNIWORK_APP_VERSION ?? appPackage.version,
    defaultRelayUrl: process.env.OMNIWORK_WEB_RELAY_URL,
  });
}

function withoutUndefined(config) {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  );
}

function runtimeConfigSource(config) {
  return [
    "window.__OMNIWORK_APP_CONFIG__ = Object.assign(",
    "  {},",
    "  window.__OMNIWORK_APP_CONFIG__ || {},",
    `  ${JSON.stringify(config, null, 2)},`,
    ");",
    "",
  ].join("\n");
}
