import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TERMINAL_SIZE } from "@omniwork/terminal-core";
import {
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  type BusinessSecurityMode,
  type TerminalProviderDefinition,
} from "@omniwork/protocol-ts";
import type { TerminalSize } from "@omniwork/protocol-ts";
import { resolveAgentDeviceId } from "./deviceIdentity.ts";
import {
  defaultRelayDeviceCredentialsPath,
  readRelayDeviceCredentials,
  type RelayDeviceCredentials,
} from "./relayDeviceCredentials.ts";
import { load as loadYaml } from "js-yaml";

export interface AgentConfig {
  configPath?: string;
  agentVersion: string;
  deviceId: string;
  hostname: string;
  displayName: string;
  relayUrl: string;
  relayDeviceCredentialsPath: string;
  relayDevicePrivateKey?: string;
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
  configPath?: string;
  globalConfigPath?: string;
  programDir?: string;
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: AgentConfigLoadOptions = {},
): AgentConfig {
  const configFile = resolveAgentConfigPath(env, options);
  const rawConfig = readAgentConfigFile(configFile.path, configFile.required);
  const appSupportDir =
    readConfigString(rawConfig, "paths", "appSupportDir") ??
    env.OMNIWORK_APP_SUPPORT_DIR ??
    defaultAgentAppSupportDir();
  const relayDeviceCredentialsPath =
    readConfigString(rawConfig, "relay", "deviceCredentialsPath") ??
    env.OMNIWORK_AGENT_RELAY_DEVICE_CREDENTIALS_PATH ??
    defaultRelayDeviceCredentialsPath(appSupportDir);
  const relayDeviceCredentials = readRelayDeviceCredentials(
    relayDeviceCredentialsPath,
  );
  const relayUrl =
    readConfigString(rawConfig, "relay", "url") ||
    env.OMNIWORK_RELAY_URL?.trim() ||
    relayDeviceCredentials?.relayUrl ||
    requireNonEmptyString(undefined, "relay.url");
  const host = hostname();
  const terminalProviderCommandOverrides =
    readDefaultTerminalProviderCommandOverrides(rawConfig, env);

  return {
    configPath: configFile.path,
    agentVersion:
      readConfigString(rawConfig, "agent", "version") ??
      env.OMNIWORK_AGENT_VERSION ??
      "0.1.0",
    deviceId: resolveDeviceId(rawConfig, env, relayDeviceCredentials),
    hostname: host,
    displayName: resolveAgentDisplayName(rawConfig, env, host),
    relayUrl,
    relayDeviceCredentialsPath,
    relayDevicePrivateKey:
      readConfigString(rawConfig, "relay", "devicePrivateKey")
        ?.replace(/\\n/g, "\n")
        .trim() ||
      env.OMNIWORK_AGENT_RELAY_DEVICE_PRIVATE_KEY?.replace(
        /\\n/g,
        "\n",
      ).trim() ||
      relayDeviceCredentials?.privateKeyPem ||
      undefined,
    adminEnabled:
      readConfigBoolean(rawConfig, true, "admin", "enabled") ??
      parseBoolean(env.OMNIWORK_AGENT_ADMIN_ENABLED, true),
    adminHost:
      readConfigString(rawConfig, "admin", "host") ??
      env.OMNIWORK_AGENT_ADMIN_HOST ??
      "127.0.0.1",
    adminPort:
      readConfigPositiveInteger(rawConfig, 17668, "admin", "port") ??
      parsePositiveInteger(env.OMNIWORK_AGENT_ADMIN_PORT, 17668),
    adminToken:
      (readConfigString(rawConfig, "admin", "token") ??
        env.OMNIWORK_AGENT_ADMIN_TOKEN?.trim()) ||
      undefined,
    agentProbeEnabled:
      readConfigBoolean(rawConfig, true, "probe", "enabled") ??
      parseBoolean(env.OMNIWORK_AGENT_PROBE_ENABLED, true),
    agentProbeHost:
      readConfigString(rawConfig, "probe", "host") ??
      env.OMNIWORK_AGENT_PROBE_HOST ??
      "127.0.0.1",
    agentProbePort:
      readConfigPositiveInteger(rawConfig, 17669, "probe", "port") ??
      parsePositiveInteger(env.OMNIWORK_AGENT_PROBE_PORT, 17669),
    agentProbeToken:
      (readConfigString(rawConfig, "probe", "token") ??
        env.OMNIWORK_AGENT_PROBE_TOKEN?.trim()) ||
      undefined,
    connectionHeartbeatMs:
      readConfigPositiveInteger(
        rawConfig,
        10000,
        "connection",
        "heartbeatMs",
      ) ??
      parsePositiveInteger(env.OMNIWORK_AGENT_CONNECTION_HEARTBEAT_MS, 10000),
    connectionStaleMs:
      readConfigPositiveInteger(rawConfig, 30000, "connection", "staleMs") ??
      parsePositiveInteger(env.OMNIWORK_AGENT_CONNECTION_STALE_MS, 30000),
    connectionDisconnectMs:
      readConfigPositiveInteger(
        rawConfig,
        90000,
        "connection",
        "disconnectMs",
      ) ??
      parsePositiveInteger(env.OMNIWORK_AGENT_CONNECTION_DISCONNECT_MS, 90000),
    relayReconnectForever:
      readConfigBoolean(rawConfig, true, "relayReconnect", "forever") ??
      parseBoolean(env.OMNIWORK_AGENT_RELAY_RECONNECT_FOREVER, true),
    relayReconnectMaxAttempts:
      readConfigNonNegativeInteger(
        rawConfig,
        8,
        "relayReconnect",
        "maxAttempts",
      ) ??
      parseNonNegativeInteger(
        env.OMNIWORK_AGENT_RELAY_RECONNECT_MAX_ATTEMPTS,
        8,
      ),
    relayReconnectInitialDelayMs:
      readConfigPositiveInteger(
        rawConfig,
        1000,
        "relayReconnect",
        "initialDelayMs",
      ) ??
      parsePositiveInteger(
        env.OMNIWORK_AGENT_RELAY_RECONNECT_INITIAL_DELAY_MS,
        1000,
      ),
    relayReconnectMaxDelayMs:
      readConfigPositiveInteger(
        rawConfig,
        30000,
        "relayReconnect",
        "maxDelayMs",
      ) ??
      parsePositiveInteger(
        env.OMNIWORK_AGENT_RELAY_RECONNECT_MAX_DELAY_MS,
        30000,
      ),
    terminalProviders: resolveTerminalProviders(
      readConfigValue(rawConfig, "terminal", "providers") ??
        env.OMNIWORK_TERMINAL_PROVIDERS,
      terminalProviderCommandOverrides,
      options.commandExists ?? createCommandExists(env),
    ),
    defaultCwd:
      readConfigString(rawConfig, "paths", "defaultCwd") ??
      env.OMNIWORK_DEFAULT_CWD ??
      process.cwd(),
    appSupportDir,
    sessionKeyPath:
      readConfigString(rawConfig, "paths", "sessionKeyPath") ??
      env.OMNIWORK_SESSION_KEY_PATH ??
      join(appSupportDir, "session-key.json"),
    sessionStorePath:
      readConfigString(rawConfig, "paths", "sessionStorePath") ??
      env.OMNIWORK_SESSION_STORE_PATH ??
      join(appSupportDir, "sessions.sqlite"),
    terminalSize: {
      cols:
        readConfigPositiveInteger(
          rawConfig,
          DEFAULT_TERMINAL_SIZE.cols,
          "terminal",
          "size",
          "cols",
        ) ?? DEFAULT_TERMINAL_SIZE.cols,
      rows:
        readConfigPositiveInteger(
          rawConfig,
          DEFAULT_TERMINAL_SIZE.rows,
          "terminal",
          "size",
          "rows",
        ) ?? DEFAULT_TERMINAL_SIZE.rows,
    },
    terminalStreamEnabled:
      readConfigBoolean(rawConfig, false, "terminal", "streamEnabled") ??
      parseBoolean(env.OMNIWORK_TERMINAL_STREAM_ENABLED, false),
    businessSecurityMode: resolveBusinessSecurityMode(rawConfig, env),
  };
}

export function defaultAgentConfigPath(
  appSupportDir = defaultAgentAppSupportDir(),
): string {
  return join(appSupportDir, "config.yml");
}

export function defaultAgentConfigSearchPaths(
  env: NodeJS.ProcessEnv = process.env,
  programDir = defaultAgentProgramDir(),
): string[] {
  return [join(programDir, "config.yml"), defaultGlobalAgentConfigPath(env)];
}

export function defaultGlobalAgentConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform() === "win32") {
    return join(
      env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "OmniWork",
      "agent",
      "config.yml",
    );
  }
  if (platform() === "darwin") {
    return defaultAgentConfigPath();
  }
  return join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "omniwork",
    "agent",
    "config.yml",
  );
}

function defaultAgentProgramDir(): string {
  return dirname(process.argv[1] ?? fileURLToPath(import.meta.url));
}

function defaultAgentAppSupportDir(): string {
  return join(homedir(), "Library", "Application Support", "OmniWork", "agent");
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

function resolveAgentConfigPath(
  env: NodeJS.ProcessEnv,
  options: AgentConfigLoadOptions,
): { path?: string; required: boolean } {
  const explicitPath = options.configPath ?? env.OMNIWORK_AGENT_CONFIG_PATH;
  if (explicitPath) {
    return { path: explicitPath, required: true };
  }

  const searchPaths = defaultAgentConfigSearchPaths(
    env,
    options.programDir ?? defaultAgentProgramDir(),
  );
  if (options.globalConfigPath) {
    searchPaths[1] = options.globalConfigPath;
  }
  return {
    path: searchPaths.find((path) => existsSync(path)),
    required: false,
  };
}

function readAgentConfigFile(
  path: string | undefined,
  required: boolean,
): Record<string, unknown> {
  if (!path) {
    return {};
  }
  try {
    const parsed = loadYaml(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (!required && isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function readConfigValue(
  config: Record<string, unknown>,
  ...path: string[]
): unknown {
  let current: unknown = config;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function readConfigString(
  config: Record<string, unknown>,
  ...path: string[]
): string | undefined {
  return readNonEmptyString(readConfigValue(config, ...path));
}

function readConfigBoolean(
  config: Record<string, unknown>,
  fallback: boolean,
  ...path: string[]
): boolean | undefined {
  const value = readConfigValue(config, ...path);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return parseBoolean(value, fallback);
  }
  return undefined;
}

function readConfigPositiveInteger(
  config: Record<string, unknown>,
  fallback: number,
  ...path: string[]
): number | undefined {
  return readConfigInteger(config, fallback, (value) => value > 0, ...path);
}

function readConfigNonNegativeInteger(
  config: Record<string, unknown>,
  fallback: number,
  ...path: string[]
): number | undefined {
  return readConfigInteger(config, fallback, (value) => value >= 0, ...path);
}

function readConfigInteger(
  config: Record<string, unknown>,
  fallback: number,
  isValid: (value: number) => boolean,
  ...path: string[]
): number | undefined {
  const value = readConfigValue(config, ...path);
  if (typeof value === "number" && Number.isInteger(value) && isValid(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isInteger(parsed) && isValid(parsed) ? parsed : fallback;
  }
  return undefined;
}

function readDefaultTerminalProviderCommandOverrides(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const rawCommands = readConfigValue(config, "terminal", "commands");
  const commands = isRecord(rawCommands) ? rawCommands : {};
  return {
    codex:
      readNonEmptyString(commands.codex) ??
      env.OMNIWORK_CODEX_COMMAND ??
      "codex",
    claude:
      readNonEmptyString(commands.claude) ??
      env.OMNIWORK_CLAUDE_COMMAND ??
      env.OMNIWORK_CLAUDECODE_COMMAND ??
      "claude",
    gemini:
      readNonEmptyString(commands.gemini) ??
      env.OMNIWORK_GEMINI_COMMAND ??
      "gemini",
    trae:
      readNonEmptyString(commands.trae) ??
      env.OMNIWORK_TRAE_COMMAND ??
      "traecli",
    "trae-cn":
      readNonEmptyString(commands["trae-cn"]) ??
      env.OMNIWORK_TRAE_CN_COMMAND ??
      env.OMNIWORK_TRAECN_COMMAND ??
      "traecli",
  };
}

function resolveTerminalProviders(
  configuredValue: unknown,
  commandOverrides: Record<string, string>,
  isCommandAvailable: (command: string) => boolean,
): TerminalProviderDefinition[] {
  const configuredProviders = parseTerminalProviders(configuredValue);
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

function parseTerminalProviders(value: unknown): TerminalProviderDefinition[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const provider = normalizeTerminalProvider(item);
      return provider ? [provider] : [];
    });
  }

  if (typeof value !== "string") {
    return [];
  }

  const rawValue = value.trim();
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

function createCommandExists(
  env: NodeJS.ProcessEnv,
): (command: string) => boolean {
  const commandEnv = {
    ...env,
    PATH: commandSearchPath(env.PATH),
  };
  return (command: string): boolean => {
    try {
      execFileSync("/bin/sh", ["-c", `command -v -- ${shellQuote(command)}`], {
        env: commandEnv,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
}

function commandSearchPath(path: string | undefined): string {
  const paths = new Set(
    (path ?? process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const fallback of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ]) {
    paths.add(fallback);
  }
  return [...paths].join(delimiter);
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

function resolveDeviceId(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  credentials?: RelayDeviceCredentials | null,
): string {
  const configuredDeviceId =
    readConfigString(config, "agent", "deviceId") ??
    env.OMNIWORK_DEVICE_ID?.trim();
  if (configuredDeviceId) {
    return configuredDeviceId;
  }
  if (credentials?.deviceId) {
    return credentials.deviceId;
  }

  return resolveAgentDeviceId({
    identityPath:
      readConfigString(config, "agent", "identityPath") ??
      env.OMNIWORK_AGENT_IDENTITY_PATH,
    ipAddress:
      readConfigString(config, "agent", "identityIp") ??
      env.OMNIWORK_AGENT_IDENTITY_IP,
  });
}

function resolveAgentDisplayName(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  host: string,
): string {
  const configuredDisplayName =
    readConfigString(config, "agent", "displayName") ??
    env.OMNIWORK_AGENT_DISPLAY_NAME?.trim();
  return configuredDisplayName || defaultAgentDisplayName(host);
}

function resolveBusinessSecurityMode(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): BusinessSecurityMode {
  const configuredMode = readConfigString(
    config,
    "agent",
    "businessSecurityMode",
  );
  if (
    configuredMode === "e2e_required" ||
    configuredMode === "plaintext_allowed"
  ) {
    return configuredMode;
  }
  const requireE2e =
    readConfigBoolean(config, true, "agent", "requireE2e") ??
    parseBoolean(env.OMNIWORK_AGENT_REQUIRE_E2E, true);
  return requireE2e ? "e2e_required" : "plaintext_allowed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
