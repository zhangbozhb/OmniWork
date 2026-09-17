import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  generateIdentityKeyPair,
  validateIdentityKeyPair,
  type IdentityKeyPair,
} from "@omni-work/protocol-ts";

export type AgentIdentityRecord = IdentityKeyPair & { role: "agent" };

export interface ResolveAgentIdentityOptions {
  identityPath?: string;
  keychainEnabled?: boolean;
  now?: Date;
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
const KEYCHAIN_ACCOUNT = "agent-identity-v2";

export function resolveAgentIdentity(
  options: ResolveAgentIdentityOptions = {},
): AgentIdentityRecord {
  const identityPath = options.identityPath ?? defaultIdentityPath();
  const keychainPath =
    options.keychainEnabled === false ? null : resolveSafeKeychainPath();
  const keychainRecord = keychainPath
    ? readKeychainIdentity(keychainPath)
    : null;
  if (keychainRecord) {
    writeLocalIdentity(identityPath, keychainRecord);
    return keychainRecord;
  }

  const localRecord = readLocalIdentity(identityPath);
  if (localRecord) {
    if (keychainPath) {
      writeKeychainIdentity(localRecord, keychainPath);
    }
    return localRecord;
  }

  if (existsSync(identityPath)) {
    throw new Error(
      `Agent identity at ${identityPath} is invalid; restore it or remove it explicitly to create a new identity.`,
    );
  }

  const identity = generateIdentityKeyPair(
    "agent",
    options.now,
  ) as AgentIdentityRecord;
  writeLocalIdentity(identityPath, identity);
  if (keychainPath) {
    writeKeychainIdentity(identity, keychainPath);
  }
  return identity;
}

export function defaultIdentityPath(appSupportDir?: string): string {
  return join(
    appSupportDir ??
      join(homedir(), "Library", "Application Support", "OmniWork", "agent"),
    "identity-v2.json",
  );
}

export function safeKeychainAvailable(
  options: SafeKeychainOptions = {},
): boolean {
  return resolveSafeKeychainPath(options) !== null;
}

function readLocalIdentity(path: string): AgentIdentityRecord | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return parseAgentIdentity(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeLocalIdentity(path: string, identity: AgentIdentityRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function parseAgentIdentity(raw: string): AgentIdentityRecord | null {
  try {
    const parsed = JSON.parse(raw) as IdentityKeyPair;
    return validateIdentityKeyPair(parsed, "agent")
      ? (parsed as AgentIdentityRecord)
      : null;
  } catch {
    return null;
  }
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
    return parseAgentIdentity(raw);
  } catch {
    return null;
  }
}

function writeKeychainIdentity(
  identity: AgentIdentityRecord,
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
        JSON.stringify(identity),
        keychainPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // Keychain can be unavailable in CI, SSH sessions, or non-interactive runs.
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

function normalizeKeychainPath(
  rawPath: string,
  homeDir = homedir(),
): string | null {
  const unquoted = rawPath.replace(/^"(.*)"$/u, "$1").trim();
  if (!unquoted) {
    return null;
  }
  return unquoted.startsWith("~/")
    ? join(homeDir, unquoted.slice(2))
    : unquoted;
}
