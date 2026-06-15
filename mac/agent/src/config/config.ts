import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { DEFAULT_TERMINAL_SIZE } from "@omniwork/terminal-core";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  type BusinessSecurityMode,
  type AgentProviderDefinition,
} from "@omniwork/protocol-ts";
import type { TerminalSize } from "@omniwork/protocol-ts";
import { resolveAgentDeviceId } from "./deviceIdentity.ts";

export interface AgentConfig {
  agentVersion: string;
  deviceId: string;
  hostname: string;
  displayName: string;
  relayUrl: string;
  adminEnabled: boolean;
  adminHost: string;
  adminPort: number;
  adminToken?: string;
  connectionHeartbeatMs: number;
  connectionStaleMs: number;
  connectionDisconnectMs: number;
  relayReconnectForever: boolean;
  relayReconnectMaxAttempts: number;
  relayReconnectInitialDelayMs: number;
  relayReconnectMaxDelayMs: number;
  agentProviders: AgentProviderDefinition[];
  defaultCwd: string;
  appSupportDir: string;
  sessionKeyPath: string;
  sessionStorePath: string;
  terminalSize: TerminalSize;
  businessSecurityMode: BusinessSecurityMode;
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const appSupportDir =
    env.OMNIWORK_APP_SUPPORT_DIR ??
    join(homedir(), "Library", "Application Support", "OmniWork", "agent");
  const relayUrl = requireNonEmptyString(
    env.OMNIWORK_RELAY_URL,
    "OMNIWORK_RELAY_URL",
  );
  const host = hostname();

  return {
    agentVersion: env.OMNIWORK_AGENT_VERSION ?? "0.1.0",
    deviceId: resolveDeviceId(env),
    hostname: host,
    displayName: resolveAgentDisplayName(env, host),
    relayUrl,
    adminEnabled: parseBoolean(env.OMNIWORK_AGENT_ADMIN_ENABLED, true),
    adminHost: env.OMNIWORK_AGENT_ADMIN_HOST ?? "127.0.0.1",
    adminPort: parsePositiveInteger(env.OMNIWORK_AGENT_ADMIN_PORT, 17668),
    adminToken: env.OMNIWORK_AGENT_ADMIN_TOKEN?.trim() || undefined,
    connectionHeartbeatMs: parsePositiveInteger(
      env.OMNIWORK_AGENT_CONNECTION_HEARTBEAT_MS,
      10000,
    ),
    connectionStaleMs: parsePositiveInteger(
      env.OMNIWORK_AGENT_CONNECTION_STALE_MS,
      30000,
    ),
    connectionDisconnectMs: parsePositiveInteger(
      env.OMNIWORK_AGENT_CONNECTION_DISCONNECT_MS,
      90000,
    ),
    relayReconnectForever: parseBoolean(
      env.OMNIWORK_AGENT_RELAY_RECONNECT_FOREVER,
      true,
    ),
    relayReconnectMaxAttempts: parseNonNegativeInteger(
      env.OMNIWORK_AGENT_RELAY_RECONNECT_MAX_ATTEMPTS,
      8,
    ),
    relayReconnectInitialDelayMs: parsePositiveInteger(
      env.OMNIWORK_AGENT_RELAY_RECONNECT_INITIAL_DELAY_MS,
      1000,
    ),
    relayReconnectMaxDelayMs: parsePositiveInteger(
      env.OMNIWORK_AGENT_RELAY_RECONNECT_MAX_DELAY_MS,
      30000,
    ),
    agentProviders: resolveAgentProviders(
      env,
      readDefaultProviderCommandOverrides(env),
    ),
    defaultCwd: env.OMNIWORK_DEFAULT_CWD ?? process.cwd(),
    appSupportDir,
    sessionKeyPath:
      env.OMNIWORK_SESSION_KEY_PATH ?? join(appSupportDir, "session-key.json"),
    sessionStorePath:
      env.OMNIWORK_SESSION_STORE_PATH ?? join(appSupportDir, "sessions.sqlite"),
    terminalSize: DEFAULT_TERMINAL_SIZE,
    businessSecurityMode: parseBoolean(env.OMNIWORK_AGENT_REQUIRE_E2E, true)
      ? "e2e_required"
      : "plaintext_allowed",
  };
}

export function defaultAgentDisplayName(host: string): string {
  const trimmed = host.trim();
  return trimmed.replace(/\.local$/i, "") || trimmed;
}

function requireNonEmptyString(
  value: string | undefined,
  name: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readDefaultProviderCommandOverrides(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    codex: env.OMNIWORK_CODEX_COMMAND ?? "codex",
    claude: env.OMNIWORK_CLAUDE_COMMAND ?? "claude",
    gemini: env.OMNIWORK_GEMINI_COMMAND ?? "gemini",
  };
}

function resolveAgentProviders(
  env: NodeJS.ProcessEnv,
  commandOverrides: Record<string, string>,
): AgentProviderDefinition[] {
  const configuredProviders = parseAgentProviders(env.OMNIWORK_AGENT_PROVIDERS);
  if (configuredProviders.length > 0) {
    return configuredProviders;
  }

  return DEFAULT_AGENT_PROVIDER_DEFINITIONS.map((provider) => ({
    ...provider,
    defaultCommand: commandOverrides[provider.kind] ?? provider.defaultCommand,
  }));
}

function parseAgentProviders(value?: string): AgentProviderDefinition[] {
  const rawValue = value?.trim();
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      const provider = normalizeAgentProvider(item);
      return provider ? [provider] : [];
    });
  } catch {
    return [];
  }
}

function normalizeAgentProvider(
  value: unknown,
): AgentProviderDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const kind = readNonEmptyString(record.kind);
  const command =
    readNonEmptyString(record.command) ??
    readNonEmptyString(record.defaultCommand);
  if (!kind || !command) {
    return null;
  }

  const displayName = readNonEmptyString(record.displayName) ?? kind;
  return {
    kind,
    displayName,
    capability:
      readNonEmptyString(record.capability) ??
      `${kind.replace(/\s+/g, "-")}.cli`,
    summary:
      readNonEmptyString(record.summary) ?? `${displayName} CLI TUI session`,
    defaultCommand: command,
    creatable: record.creatable !== false,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveDeviceId(env: NodeJS.ProcessEnv): string {
  const configuredDeviceId = env.OMNIWORK_DEVICE_ID?.trim();
  if (configuredDeviceId) {
    return configuredDeviceId;
  }

  return resolveAgentDeviceId({
    identityPath: env.OMNIWORK_AGENT_IDENTITY_PATH,
    ipAddress: env.OMNIWORK_AGENT_IDENTITY_IP,
    keychainEnabled:
      env.OMNIWORK_AGENT_IDENTITY_KEYCHAIN === undefined
        ? undefined
        : parseBoolean(env.OMNIWORK_AGENT_IDENTITY_KEYCHAIN, true),
  });
}

function resolveAgentDisplayName(env: NodeJS.ProcessEnv, host: string): string {
  const configuredDisplayName = env.OMNIWORK_AGENT_DISPLAY_NAME?.trim();
  return configuredDisplayName || defaultAgentDisplayName(host);
}
