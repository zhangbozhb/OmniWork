import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  homedir,
  hostname as systemHostname,
  networkInterfaces,
} from "node:os";
import { dirname, join } from "node:path";

export interface AgentIdentityRecord {
  version: 1;
  deviceId: string;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveAgentDeviceIdOptions {
  identityPath?: string;
  keychainEnabled?: boolean;
  now?: Date;
  hostname?: string;
  ipAddress?: string;
}

export interface SafeKeychainOptions {
  platform?: NodeJS.Platform;
  execFile?: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] },
  ) => string;
  exists?: (path: string) => boolean;
  homeDir?: string;
}

const KEYCHAIN_SERVICE = "OmniWork";
const KEYCHAIN_ACCOUNT = "agent-device-identity";

export function resolveAgentDeviceId(
  options: ResolveAgentDeviceIdOptions = {},
): string {
  const identityPath = options.identityPath ?? defaultIdentityPath();
  const now = options.now ?? new Date();
  const keychainEnabled = options.keychainEnabled ?? true;
  const keychainPath = keychainEnabled ? resolveSafeKeychainPath() : null;

  const keychainRecord = keychainPath
    ? readKeychainIdentity(keychainPath)
    : null;
  if (keychainRecord && isValidIdentityRecord(keychainRecord, options)) {
    writeLocalIdentity(identityPath, keychainRecord);
    return keychainRecord.deviceId;
  }

  const localRecord = readLocalIdentity(identityPath);
  if (localRecord && isValidIdentityRecord(localRecord, options)) {
    if (keychainPath) {
      writeKeychainIdentity(localRecord, keychainPath);
    }
    return localRecord.deviceId;
  }

  const record = createIdentityRecord(now, options);
  if (keychainPath) {
    writeKeychainIdentity(record, keychainPath);
  }
  writeLocalIdentity(identityPath, record);
  return record.deviceId;
}

export function defaultIdentityPath(): string {
  return join(homedir(), ".omniwork", "agent.json");
}

export function createIdentityRecord(
  now = new Date(),
  options: ResolveAgentDeviceIdOptions = {},
): AgentIdentityRecord {
  const timestamp = now.toISOString();
  const deviceId = createDeviceId();
  return {
    version: 1,
    deviceId,
    checksum: createIdentityChecksum(deviceId, options),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createIdentityChecksum(
  deviceId: string,
  options: ResolveAgentDeviceIdOptions = {},
): string {
  return sha256(`${deviceId}${createCheckFactorHash(options)}`);
}

export function createCheckFactorHash(
  options: ResolveAgentDeviceIdOptions = {},
): string {
  return sha256(`${resolveIpAddress(options)}${resolveHostname(options)}`);
}

export function isValidIdentityRecord(
  value: unknown,
  options: ResolveAgentDeviceIdOptions = {},
): value is AgentIdentityRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.deviceId !== "string" ||
    typeof record.checksum !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return false;
  }

  return record.checksum === createIdentityChecksum(record.deviceId, options);
}

function createDeviceId(): string {
  return `dev_${randomBytes(8).toString("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveHostname(options: ResolveAgentDeviceIdOptions): string {
  return options.hostname ?? systemHostname();
}

function resolveIpAddress(options: ResolveAgentDeviceIdOptions): string {
  if (options.ipAddress !== undefined) {
    return options.ipAddress;
  }

  const candidates: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push(address.address);
      }
    }
  }

  return candidates.sort()[0] ?? "";
}

function readLocalIdentity(path: string): AgentIdentityRecord | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as AgentIdentityRecord;
  } catch {
    return null;
  }
}

function writeLocalIdentity(path: string, record: AgentIdentityRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  } catch {
    // Device identity must not prevent the agent from starting.
  }
}

export function safeKeychainAvailable(
  options: SafeKeychainOptions = {},
): boolean {
  return resolveSafeKeychainPath(options) !== null;
}

function resolveSafeKeychainPath(
  options: SafeKeychainOptions = {},
): string | null {
  if ((options.platform ?? process.platform) !== "darwin") {
    return null;
  }

  const fileExists = options.exists ?? existsSync;

  try {
    const rawPath = runSecurity(
      ["default-keychain", "-d", "user"],
      options,
    ).trim();
    const keychainPath = normalizeKeychainPath(rawPath, options.homeDir);
    if (!keychainPath || !fileExists(keychainPath)) {
      return null;
    }

    runSecurity(["show-keychain-info", keychainPath], options);
    return keychainPath;
  } catch {
    return null;
  }
}

function runSecurity(args: string[], options: SafeKeychainOptions): string {
  if (options.execFile) {
    return options.execFile("security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
  return execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readKeychainIdentity(
  keychainPath: string,
): AgentIdentityRecord | null {
  try {
    const raw = execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        keychainPath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return JSON.parse(raw) as AgentIdentityRecord;
  } catch {
    return null;
  }
}

function writeKeychainIdentity(
  record: AgentIdentityRecord,
  keychainPath: string,
): void {
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        JSON.stringify(record),
        keychainPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // Keychain can be unavailable in CI, SSH sessions, or non-interactive runs.
  }
}

function normalizeKeychainPath(
  value: string,
  homeDir = homedir(),
): string | null {
  const unquoted = value.trim().replace(/^"(.+)"$/, "$1");
  if (!unquoted) {
    return null;
  }
  if (unquoted === "~") {
    return homeDir;
  }
  if (unquoted.startsWith("~/")) {
    return join(homeDir, unquoted.slice(2));
  }
  return unquoted;
}
