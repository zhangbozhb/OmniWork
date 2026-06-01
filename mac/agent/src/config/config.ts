import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { DEFAULT_TERMINAL_SIZE } from "../../../../packages/terminal-core/src/index.ts";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  type BusinessSecurityMode,
  type AgentProviderDefinition,
} from "../../../../packages/protocol-ts/src/index.ts";
import type { TerminalSize } from "../../../../packages/protocol-ts/src/index.ts";

export interface AgentConfig {
  agentVersion: string;
  deviceId: string;
  hostname: string;
  relayUrl?: string;
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

  return {
    agentVersion: env.OMNIWORK_AGENT_VERSION ?? "0.1.0",
    deviceId: resolveDeviceId(env.OMNIWORK_DEVICE_ID),
    hostname: hostname(),
    relayUrl: env.OMNIWORK_RELAY_URL,
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

function resolveDeviceId(value?: string): string {
  const configuredDeviceId = value?.trim();
  if (configuredDeviceId) {
    return configuredDeviceId;
  }

  return hostname().replace(/[^a-zA-Z0-9_-]/g, "-");
}
