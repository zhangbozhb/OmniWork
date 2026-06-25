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

  const lockContent = readFileSync(podfileLock, "utf8");
  const missingPods = expectedAutolinkedPods().filter(
    (podName) => !podIsInLockfile(lockContent, podName),
  );
  if (missingPods.length > 0) {
    console.log(
      `[OmniWork] iOS Podfile.lock is missing autolinked pods: ${missingPods.join(
        ", ",
      )}`,
    );
    return false;
  }

  return (
    lockContent === readFileSync(manifestLock, "utf8")
  );
}

function expectedAutolinkedPods() {
  const result = spawnSync(
    process.execPath,
    [join(appRoot, "node_modules/react-native/cli.js"), "config"],
    {
      cwd: appRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    return [];
  }

  try {
    const config = JSON.parse(result.stdout);
    return Object.values(config.dependencies ?? {})
      .map((dependency) => dependency?.platforms?.ios?.podspecPath)
      .filter(Boolean)
      .map((podspecPath) => podNameFromPodspec(podspecPath))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function podNameFromPodspec(podspecPath) {
  const podspec = readFileSync(podspecPath, "utf8");
  const explicitName = podspec.match(/s\.name\s*=\s*["']([^"']+)["']/)?.[1];
  if (explicitName) {
    return explicitName;
  }
  if (/s\.name\s*=\s*package\[['"]name['"]\]/.test(podspec)) {
    return JSON.parse(
      readFileSync(join(dirname(podspecPath), "package.json"), "utf8"),
    ).name;
  }
  return undefined;
}

function podIsInLockfile(lockContent, podName) {
  return new RegExp(`^  - ${escapeRegExp(podName)}(?: \\(|/)`, "m").test(
    lockContent,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
