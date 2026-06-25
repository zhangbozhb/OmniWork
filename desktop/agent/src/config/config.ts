import { execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { DEFAULT_TERMINAL_SIZE } from "@omniwork/terminal-core";
import {
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  type BusinessSecurityMode,
  type TerminalProviderDefinition,
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
  agentProbeEnabled: boolean;
  agentProbeHost: string;
  agentProbePort: number;
  agentProbeToken?: string;
  connectionHeartbeatMs: number;
  connectionStaleMs: number;
  connectionDisconnectMs: number;
  relayReconnectForever: boolean;
  relayReconnectMaxAttempts: number;
  relayReconnectInitialDelayMs: number;
  relayReconnectMaxDelayMs: number;
  terminalProviders: TerminalProviderDefinition[];
  defaultCwd: string;
  appSupportDir: string;
  sessionKeyPath: string;
  sessionStorePath: string;
  terminalSize: TerminalSize;
  terminalStreamEnabled: boolean;
  businessSecurityMode: BusinessSecurityMode;
}

export interface AgentConfigLoadOptions {
  commandExists?: (command: string) => boolean;
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: AgentConfigLoadOptions = {},
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
    agentProbeEnabled: parseBoolean(env.OMNIWORK_AGENT_PROBE_ENABLED, true),
    agentProbeHost: env.OMNIWORK_AGENT_PROBE_HOST ?? "127.0.0.1",
    agentProbePort: parsePositiveInteger(env.OMNIWORK_AGENT_PROBE_PORT, 17669),
    agentProbeToken: env.OMNIWORK_AGENT_PROBE_TOKEN?.trim() || undefined,
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
    terminalProviders: resolveTerminalProviders(
      env,
      readDefaultTerminalProviderCommandOverrides(env),
      options.commandExists ?? commandExists,
    ),
    defaultCwd: env.OMNIWORK_DEFAULT_CWD ?? process.cwd(),
    appSupportDir,
    sessionKeyPath:
      env.OMNIWORK_SESSION_KEY_PATH ?? join(appSupportDir, "session-key.json"),
    sessionStorePath:
      env.OMNIWORK_SESSION_STORE_PATH ?? join(appSupportDir, "sessions.sqlite"),
    terminalSize: DEFAULT_TERMINAL_SIZE,
    terminalStreamEnabled: parseBoolean(
      env.OMNIWORK_TERMINAL_STREAM_ENABLED,
      false,
    ),
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

function readDefaultTerminalProviderCommandOverrides(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    codex: env.OMNIWORK_CODEX_COMMAND ?? "codex",
    claude:
      env.OMNIWORK_CLAUDE_COMMAND ??
      env.OMNIWORK_CLAUDECODE_COMMAND ??
      "claude",
    gemini: env.OMNIWORK_GEMINI_COMMAND ?? "gemini",
  };
}

function resolveTerminalProviders(
  env: NodeJS.ProcessEnv,
  commandOverrides: Record<string, string>,
  isCommandAvailable: (command: string) => boolean,
): TerminalProviderDefinition[] {
  const configuredProviders = parseTerminalProviders(env.OMNIWORK_TERMINAL_PROVIDERS);
  const providers =
    configuredProviders.length > 0
      ? configuredProviders
      : DEFAULT_TERMINAL_PROVIDER_DEFINITIONS.map((provider) => ({
          ...provider,
          defaultCommand:
            commandOverrides[provider.kind] ?? provider.defaultCommand,
        }));

  return withDefaultTerminalProvider(providers).filter((provider) =>
    isTerminalProviderAvailable(provider, isCommandAvailable),
  );
}

function parseTerminalProviders(value?: string): TerminalProviderDefinition[] {
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
      const provider = normalizeTerminalProvider(item);
      return provider ? [provider] : [];
    });
  } catch {
    return [];
  }
}

function normalizeTerminalProvider(
  value: unknown,
): TerminalProviderDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const kind = readNonEmptyString(record.kind);
  const command =
    readNonEmptyString(record.command) ??
    readNonEmptyString(record.defaultCommand);
  if (!kind || (kind !== "terminal" && !command)) {
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
    defaultCommand: kind === "terminal" ? "" : (command ?? ""),
    creatable: record.creatable !== false,
  };
}

function withDefaultTerminalProvider(
  providers: readonly TerminalProviderDefinition[],
): TerminalProviderDefinition[] {
  const terminalProvider = DEFAULT_TERMINAL_PROVIDER_DEFINITIONS.find(
    (provider) => provider.kind === "terminal",
  );
  if (!terminalProvider) {
    return [...providers];
  }

  return [
    ...providers.filter((provider) => provider.kind !== "terminal"),
    terminalProvider,
  ];
}

function isTerminalProviderAvailable(
  provider: TerminalProviderDefinition,
  isCommandAvailable: (command: string) => boolean,
): boolean {
  if (!provider.creatable || provider.kind === "terminal") {
    return provider.creatable;
  }

  const executable = firstShellWord(provider.defaultCommand);
  return executable ? isCommandAvailable(executable) : false;
}

function commandExists(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v -- ${shellQuote(command)}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function firstShellWord(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)/.exec(trimmed);
  const word = match?.[1];
  if (!word) {
    return undefined;
  }
  if (
    (word.startsWith('"') && word.endsWith('"')) ||
    (word.startsWith("'") && word.endsWith("'"))
  ) {
    return word.slice(1, -1);
  }
  return word;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  });
}

function resolveAgentDisplayName(env: NodeJS.ProcessEnv, host: string): string {
  const configuredDisplayName = env.OMNIWORK_AGENT_DISPLAY_NAME?.trim();
  return configuredDisplayName || defaultAgentDisplayName(host);
}
