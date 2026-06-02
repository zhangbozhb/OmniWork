#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const iosDir = join(appRoot, "ios");
const podfileLock = join(iosDir, "Podfile.lock");
const manifestLock = join(iosDir, "Pods", "Manifest.lock");
const cocoapodsHome = join(appRoot, ".cocoapods-home");

if (podsAreInSync()) {
  console.log("[OmniWork] iOS Pods are already in sync; skipping pod install.");
  process.exit(0);
}

mkdirSync(cocoapodsHome, { recursive: true });

const result = spawnSync("pod", ["install"], {
  cwd: iosDir,
  env: {
    ...process.env,
    CP_HOME_DIR: cocoapodsHome,
  },
  stdio: "inherit",
});

process.exit(result.status ?? 1);

function podsAreInSync() {
  if (!existsSync(podfileLock) || !existsSync(manifestLock)) {
    return false;
  }

  return (
    readFileSync(podfileLock, "utf8") === readFileSync(manifestLock, "utf8")
  );
}
