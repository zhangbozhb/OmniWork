import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relayServerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminWebRoot = join(relayServerRoot, "admin-web");
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
const ADMIN_API_BASE = "/admin/api";

let cachedAdminPage: string | null = null;
let cachedAdminLoginPage: string | null = null;

export function renderRelayAdminPage(prefix = ""): string {
  cachedAdminPage ??= readFileSync(adminPagePath, "utf8");
  return withAdminPaths(
    cachedAdminPage,
    `${prefix}${DEV_ADMIN_BASE}`,
    `${prefix}${DEV_ADMIN_LOGIN}`,
    `${prefix}${ADMIN_API_BASE}`,
  );
}

export function renderRelayAdminLoginPage(prefix = ""): string {
  cachedAdminLoginPage ??= readFileSync(adminLoginPagePath, "utf8");
  return withAdminPaths(
    cachedAdminLoginPage,
    `${prefix}${DEV_ADMIN_BASE}`,
    `${prefix}${DEV_ADMIN_LOGIN}`,
    `${prefix}${ADMIN_API_BASE}`,
  );
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
  adminApi: string,
): string {
  return html
    .replace('data-admin-base="/admin/"', `data-admin-base="${adminBase}"`)
    .replace(
      'data-admin-login="/admin/login.html"',
      `data-admin-login="${adminLogin}"`,
    )
    .replace('data-admin-api="/admin/api"', `data-admin-api="${adminApi}"`);
}
