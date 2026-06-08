import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relayServerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminPagePath = join(relayServerRoot, "static", "admin", "index.html");
const adminLoginPagePath = join(
  relayServerRoot,
  "static",
  "admin",
  "login.html",
);

let cachedAdminPage: string | null = null;
let cachedAdminLoginPage: string | null = null;

export function renderRelayAdminPage(): string {
  cachedAdminPage ??= readFileSync(adminPagePath, "utf8");
  return cachedAdminPage;
}

export function renderRelayAdminLoginPage(): string {
  cachedAdminLoginPage ??= readFileSync(adminLoginPagePath, "utf8");
  return cachedAdminLoginPage;
}
