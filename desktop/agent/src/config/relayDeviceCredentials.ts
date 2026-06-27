import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RelayDeviceCredentials {
  version: 1;
  relayUrl: string;
  deviceId: string;
  privateKeyPem: string;
  createdAt: string;
}

export function defaultRelayDeviceCredentialsPath(appSupportDir?: string): string {
  return join(
    appSupportDir ??
      join(homedir(), "Library", "Application Support", "OmniWork", "agent"),
    "relay-device.json",
  );
}

export function readRelayDeviceCredentials(
  path: string,
): RelayDeviceCredentials | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRelayDeviceCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRelayDeviceCredentials(
  path: string,
  record: RelayDeviceCredentials,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function isRelayDeviceCredentials(
  value: unknown,
): value is RelayDeviceCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.relayUrl === "string" &&
    record.relayUrl.length > 0 &&
    typeof record.deviceId === "string" &&
    record.deviceId.length > 0 &&
    typeof record.privateKeyPem === "string" &&
    record.privateKeyPem.includes("PRIVATE KEY") &&
    typeof record.createdAt === "string"
  );
}
