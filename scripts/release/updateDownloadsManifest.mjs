import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(repoRoot, "site", "public", "downloads.json");
const args = parseArgs(process.argv.slice(2));
const rootPackage = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const currentManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const version = normalizeVersion(
  args.version ?? process.env.OMNIWORK_RELEASE_VERSION ?? rootPackage.version,
);
const releasedAt =
  args.releasedAt ?? process.env.OMNIWORK_RELEASED_AT ?? today();
const repo =
  args.repo ?? process.env.OMNIWORK_RELEASE_REPO ?? "zhangbozhb/OmniWork";
const appStoreUrl =
  args.appStoreUrl ??
  process.env.OMNIWORK_IOS_APP_STORE_URL ??
  currentManifest.assets.ios.appStore.url;
const assetsDir = resolve(
  repoRoot,
  args.assetsDir ??
    process.env.OMNIWORK_RELEASE_ASSETS_DIR ??
    join("dist", "release"),
);
const requireIpa =
  args.requireIpa === "true" ||
  process.env.OMNIWORK_RELEASE_REQUIRE_IPA === "1";
const desktopPlatform =
  args.desktopPlatform ??
  process.env.OMNIWORK_RELEASE_DESKTOP_PLATFORM ??
  `${process.platform}-${process.arch}`;

const assetNames = {
  androidApk: `omniwork-android-${version}.apk`,
  desktopAgent: `omniwork-desktop-agent-${version}-${desktopPlatform}.tgz`,
  iosIpa: `omniwork-ios-${version}.ipa`,
};

assertDirectory(assetsDir);

const releaseUrl = `https://github.com/${repo}/releases/tag/${version}`;
const allReleasesUrl = `https://github.com/${repo}/releases`;
const assetBaseUrl = `https://github.com/${repo}/releases/download/${version}`;
const androidApk = requiredAsset("Android APK", assetNames.androidApk);
const desktopAgent = requiredAsset("Desktop Agent", assetNames.desktopAgent);
const iosIpa = optionalAsset(assetNames.iosIpa);

if (requireIpa && !iosIpa) {
  throw new Error(
    `[release] Missing required signed IPA: ${join(assetsDir, assetNames.iosIpa)}`,
  );
}

const checksumAssets = [androidApk, desktopAgent, iosIpa].filter(Boolean);
writeChecksums(checksumAssets);

const manifest = {
  version,
  releasedAt,
  releaseUrl,
  allReleasesUrl,
  checksumsUrl: `${assetBaseUrl}/checksums.txt`,
  assets: {
    ios: withoutUndefined({
      appStore: {
        label: "Download on the App Store",
        url: appStoreUrl,
        type: "app_store",
      },
      ipa: iosIpa
        ? {
            label: "Download signed IPA",
            url: releaseAssetUrl(iosIpa.name),
            type: "github_release_asset",
            sha256: iosIpa.sha256,
            note: "仅用于已签名且满足 Apple 分发条件的场景。普通用户应优先使用 App Store。",
          }
        : undefined,
    }),
    android: {
      apk: {
        label: "Download Android APK",
        url: releaseAssetUrl(androidApk.name),
        type: "github_release_asset",
        sha256: androidApk.sha256,
      },
    },
    desktopAgent: {
      archive: {
        label: `Download Desktop Agent Node package (${desktopPlatform})`,
        url: releaseAssetUrl(desktopAgent.name),
        type: "github_release_asset",
        sha256: desktopAgent.sha256,
      },
    },
    web: currentManifest.assets.web,
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("[release] downloads manifest updated:");
console.log(`  manifest:  ${manifestPath}`);
console.log(`  checksums: ${join(assetsDir, "checksums.txt")}`);
console.log(`  release:   ${releaseUrl}`);

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

function today() {
  return new Date().toISOString().slice(0, 10);
}

function assertDirectory(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`[release] Missing release assets directory: ${path}`);
  }
}

function requiredAsset(label, name) {
  const asset = optionalAsset(name);
  if (!asset) {
    throw new Error(
      `[release] Missing ${label}: ${join(assetsDir, name)}\n` +
        `[release] Available assets: ${readdirSync(assetsDir).join(", ") || "(empty)"}`,
    );
  }
  return asset;
}

function optionalAsset(name) {
  const path = join(assetsDir, name);
  if (!existsSync(path)) {
    return undefined;
  }
  if (!statSync(path).isFile()) {
    throw new Error(`[release] Expected file asset: ${path}`);
  }
  return { name, path, sha256: sha256(path) };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeChecksums(assets) {
  mkdirSync(assetsDir, { recursive: true });
  const lines = assets
    .map((asset) => `${asset.sha256}  ${asset.name}`)
    .sort((left, right) => left.localeCompare(right));
  writeFileSync(join(assetsDir, "checksums.txt"), `${lines.join("\n")}\n`);
}

function releaseAssetUrl(name) {
  return `${assetBaseUrl}/${encodeURIComponent(name)}`;
}

function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
