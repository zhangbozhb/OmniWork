import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminPagePath = join(agentRoot, "static", "admin", "index.html");

let cachedAdminPage: string | null = null;

export function renderAgentAdminPage(): string {
  cachedAdminPage ??= readFileSync(adminPagePath, "utf8");
  return cachedAdminPage;
}
