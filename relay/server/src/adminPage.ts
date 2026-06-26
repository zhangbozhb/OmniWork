import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const adminWebRoot = join(repoRoot, "web", "admin");
const adminPagePath = join(adminWebRoot, "index.html");
const adminLoginPagePath = join(adminWebRoot, "login.html");
const adminAssetPaths = new Map([
  [
    "world-land-110m.geojson",
    {
      path: join(adminWebRoot, "world-land-110m.geojson"),
      contentType: "application/geo+json; charset=utf-8",
    },
  ],
]);
const DEV_ADMIN_BASE = "/admin/web";
const DEV_ADMIN_LOGIN = "/admin/web";

let cachedAdminPage: string | null = null;
let cachedAdminLoginPage: string | null = null;

export function renderRelayAdminPage(): string {
  cachedAdminPage ??= readFileSync(adminPagePath, "utf8");
  return withAdminPaths(cachedAdminPage, DEV_ADMIN_BASE, DEV_ADMIN_LOGIN);
}

export function renderRelayAdminLoginPage(): string {
  cachedAdminLoginPage ??= readFileSync(adminLoginPagePath, "utf8");
  return withAdminPaths(cachedAdminLoginPage, DEV_ADMIN_BASE, DEV_ADMIN_LOGIN);
}

export function readRelayAdminAsset(
  name: string,
): { body: Buffer; contentType: string } | null {
  const asset = adminAssetPaths.get(name);
  if (!asset) {
    return null;
  }
  return {
    body: readFileSync(asset.path),
    contentType: asset.contentType,
  };
}

function withAdminPaths(
  html: string,
  adminBase: string,
  adminLogin: string,
): string {
  return html
    .replace('data-admin-base="/admin/"', `data-admin-base="${adminBase}"`)
    .replace(
      'data-admin-login="/admin/login.html"',
      `data-admin-login="${adminLogin}"`,
    );
}
