import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IceServerConfig } from "@omniwork/protocol-ts";
import { load as loadYaml } from "js-yaml";

/**
 * Relay 升级编排相关配置（阶段 4 引入）。
 * 与 RelayUpgradeOrchestrator 中的 UpgradeOrchestratorConfig 保持同构，
 * 这里直接定义并 export，避免 server 层反向依赖 upgrade 模块。
 */
export interface UpgradeOrchestratorConfig {
  enabled: boolean;
  rolloutPercent: number;
  deviceBlocklist: Set<string>;
  iceServers: IceServerConfig[];
  proposeDelayMs: number;
  /**
   * 是否尊重 App 端在 mobile.connect 中携带的 transport_preference。
   * 默认 true；运维如需在紧急情况下忽略客户端偏好可设为 false。
   */
  respectClientPreference: boolean;
}

export interface RelayServerConfig {
  configPath?: string;
  host: string;
  port: number;
  deviceId: string;
  /**
   * 是否允许公网明文 ws://。业务安全由 App-Agent E2E 负责；
   * 非 loopback host 必须显式开启该项，避免误把明文传输当成 TLS 保护。
   */
  allowPlaintextWs: boolean;
  /**
   * 兼容旧配置项。业务安全模式现在由每个 Agent 在 agent.hello 中声明，
   * Relay 可在同一进程内同时承载 e2e_required 与 plaintext_allowed Agent。
   */
  requireE2E: boolean;
  protocolVersion: 1;
  minProtocolVersion: 1;
  /**
   * auth.proof 限流：按 (device_id, remote_ip) 维度做 token bucket。
   * - capacity: 桶容量
   * - refillPerSecond: 每秒补充令牌数
   * - blockMs: 桶耗尽后封禁时长
   */
  authRateLimit: {
    capacity: number;
    refillPerSecond: number;
    blockMs: number;
  };
  websocket: {
    keepaliveIntervalMs: number;
    pongTimeoutMs: number;
  };
  admin: {
    host: string;
    port: number;
    webEnabled: boolean;
    tokenDir: string;
    tokenRotateMs: number;
    sessionTtlMs: number;
    requireHttps: boolean;
    trustProxy: boolean;
    trustedProxyIps: Set<string>;
    controlsDbPath: string;
    agentDisableDefaultMs: number;
    ipBanDefaultMs: number;
  };
  state: {
    deviceStatusDbPath: string;
    deviceStatusRetentionMs: number;
    deviceStatusFlushIntervalMs: number;
    sweepIntervalMs: number;
    pendingAuthTtlMs: number;
    appContextTtlMs: number;
  };
  auth: {
    mode: "none" | "email_link";
    publicBaseUrl?: string;
    dbPath: string;
    emailLinkTtlMs: number;
    sessionTtlMs: number;
    deviceEnrollmentTtlMs: number;
    nonceTtlMs: number;
    emailRateLimitPerHour: number;
    ipRateLimitPerHour: number;
    maxDevicesPerUser: number;
    mail: {
      provider: "console" | "smtp";
      from?: string;
      smtp?: {
        host: string;
        port: number;
        secure: boolean;
        user: string;
        pass: string;
      };
    };
  };
  /** 升级编排器配置。阶段 4 引入。 */
  upgrade: UpgradeOrchestratorConfig;
}

export class RelayConfigError extends Error {}

const DEFAULT_ICE_SERVERS_JSON = '[{"urls":"stun:stun.l.google.com:19302"}]';

export interface RelayServerConfigLoadOptions {
  configPath?: string;
  globalConfigPath?: string;
  programDir?: string;
}

export function loadRelayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: RelayServerConfigLoadOptions = {},
): RelayServerConfig {
  const configFile = resolveRelayConfigPath(env, options);
  const rawConfig = readRelayConfigFile(configFile.path, configFile.required);
  const host =
    readConfigString(rawConfig, "server", "host") ??
    env.OMNIWORK_RELAY_HOST ??
    "127.0.0.1";
  const allowPlaintextWs = parseBoolean(
    readConfigBoolean(rawConfig, isLoopbackHost(host), "server", "allowPlaintextWs"),
    isLoopbackHost(host),
  );
  const requireE2E = parseBoolean(
    readConfigBoolean(rawConfig, true, "server", "requireE2E"),
    true,
  );
  const envAllowPlaintextWs = parseBoolean(
    env.OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS,
    isLoopbackHost(host),
  );
  const envRequireE2E = parseBoolean(env.OMNIWORK_RELAY_REQUIRE_E2E, true);
  const finalAllowPlaintextWs =
    readConfigValue(rawConfig, "server", "allowPlaintextWs") === undefined
      ? envAllowPlaintextWs
      : allowPlaintextWs;
  const finalRequireE2E =
    readConfigValue(rawConfig, "server", "requireE2E") === undefined
      ? envRequireE2E
      : requireE2E;

  if (!isLoopbackHost(host) && !finalAllowPlaintextWs) {
    throw new RelayConfigError(
      `[omniwork-relay] refusing to start on non-loopback host "${host}" without explicit plaintext ws allowance. ` +
        `Set OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true after confirming OMNIWORK_RELAY_REQUIRE_E2E=true.`,
    );
  }

  const runtimeDir =
    readConfigString(rawConfig, "paths", "runtimeDir") ??
    optionalNonEmpty(env.OMNIWORK_RELAY_RUNTIME_DIR) ??
    join(process.cwd(), ".omniwork-relay");
  const port =
    readConfigNumber(rawConfig, 8787, "server", "port") ??
    Number(env.OMNIWORK_RELAY_PORT ?? "8787");
  const adminHost =
    readConfigString(rawConfig, "admin", "host") ??
    env.OMNIWORK_RELAY_ADMIN_HOST ??
    "127.0.0.1";
  const adminPort =
    readConfigNumber(rawConfig, 8788, "admin", "port") ??
    Number(env.OMNIWORK_RELAY_ADMIN_PORT ?? "8788");

  if (listenersOverlap(host, port, adminHost, adminPort)) {
    throw new RelayConfigError(
      `[omniwork-relay] admin listener must not share the business listener ${host}:${adminPort}. ` +
        `Set OMNIWORK_RELAY_ADMIN_PORT to a separate local port.`,
    );
  }
  const authMode = parseAuthMode(
    readConfigString(rawConfig, "auth", "mode") ?? env.OMNIWORK_RELAY_AUTH_MODE,
  );
  const publicBaseUrl =
    readConfigString(rawConfig, "auth", "publicBaseUrl") ??
    optionalNonEmpty(env.OMNIWORK_PUBLIC_BASE_URL);
  const mailProvider = parseMailProvider(
    readConfigString(rawConfig, "auth", "mail", "provider") ??
      env.OMNIWORK_MAIL_PROVIDER,
  );
  const mailFrom =
    readConfigString(rawConfig, "auth", "mail", "from") ??
    optionalNonEmpty(env.OMNIWORK_MAIL_FROM);
  const smtpHost =
    readConfigString(rawConfig, "auth", "mail", "smtp", "host") ??
    optionalNonEmpty(env.OMNIWORK_SMTP_HOST);
  const smtpUser =
    readConfigString(rawConfig, "auth", "mail", "smtp", "user") ??
    optionalNonEmpty(env.OMNIWORK_SMTP_USER);
  const smtpPass =
    readConfigString(rawConfig, "auth", "mail", "smtp", "pass") ??
    optionalNonEmpty(env.OMNIWORK_SMTP_PASS);
  const smtpPort =
    readConfigNumber(rawConfig, 587, "auth", "mail", "smtp", "port") ??
    parseNumber(env.OMNIWORK_SMTP_PORT, 587);
  const smtpSecure = parseBoolean(
    readConfigBoolean(rawConfig, false, "auth", "mail", "smtp", "secure"),
    parseBoolean(env.OMNIWORK_SMTP_SECURE, false),
  );

  if (authMode === "email_link") {
    if (!publicBaseUrl) {
      throw new RelayConfigError(
        "[omniwork-relay] OMNIWORK_PUBLIC_BASE_URL is required when OMNIWORK_RELAY_AUTH_MODE=email_link.",
      );
    }
    if (!mailFrom) {
      throw new RelayConfigError(
        "[omniwork-relay] OMNIWORK_MAIL_FROM is required when OMNIWORK_RELAY_AUTH_MODE=email_link.",
      );
    }
    if (!isLoopbackHost(host)) {
      if (!publicBaseUrl.startsWith("https://")) {
        throw new RelayConfigError(
          "[omniwork-relay] OMNIWORK_PUBLIC_BASE_URL must use https on non-loopback hosts when user auth is enabled.",
        );
      }
      if (mailProvider === "console") {
        throw new RelayConfigError(
          "[omniwork-relay] OMNIWORK_MAIL_PROVIDER=console is only allowed on loopback hosts.",
        );
      }
    }
    if (mailProvider === "smtp" && (!smtpHost || !smtpUser || !smtpPass)) {
      throw new RelayConfigError(
        "[omniwork-relay] SMTP host, user and pass are required when OMNIWORK_MAIL_PROVIDER=smtp.",
      );
    }
  }

  return {
      configPath: configFile.path,
    host,
    port,
      deviceId:
        readConfigString(rawConfig, "server", "deviceId") ??
        env.OMNIWORK_DEVICE_ID ??
        "omniwork-relay",
      allowPlaintextWs: finalAllowPlaintextWs,
      requireE2E: finalRequireE2E,
    protocolVersion: 1,
    minProtocolVersion: 1,
    authRateLimit: {
      capacity:
        readConfigNumber(rawConfig, 5, "authRateLimit", "capacity") ??
        parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_CAPACITY, 5),
      refillPerSecond:
        readConfigNumber(rawConfig, 1, "authRateLimit", "refillPerSecond") ??
        parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC, 1),
      blockMs:
        readConfigNumber(rawConfig, 60_000, "authRateLimit", "blockMs") ??
        parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS, 60_000),
    },
    websocket: {
      keepaliveIntervalMs:
        readConfigNumber(rawConfig, 3_300_000, "websocket", "keepaliveIntervalMs") ??
        parseNumber(env.OMNIWORK_RELAY_WS_KEEPALIVE_INTERVAL_MS, 3_300_000),
      pongTimeoutMs:
        readConfigNumber(rawConfig, 30_000, "websocket", "pongTimeoutMs") ??
        parseNumber(env.OMNIWORK_RELAY_WS_PONG_TIMEOUT_MS, 30_000),
    },
    admin: {
      host: adminHost,
      port: adminPort,
      webEnabled: parseBoolean(
        readConfigBoolean(rawConfig, false, "admin", "webEnabled"),
        parseBoolean(env.OMNIWORK_RELAY_ADMIN_WEB_ENABLED, false),
      ),
      tokenDir:
        readConfigString(rawConfig, "admin", "tokenDir") ??
        optionalNonEmpty(env.OMNIWORK_RELAY_ADMIN_TOKEN_DIR) ?? runtimeDir,
      tokenRotateMs:
        readConfigNumber(rawConfig, 3_600_000, "admin", "tokenRotateMs") ??
        parseNumber(env.OMNIWORK_RELAY_ADMIN_TOKEN_ROTATE_MS, 3_600_000),
      sessionTtlMs:
        readConfigNumber(rawConfig, 1_800_000, "admin", "sessionTtlMs") ??
        parseNumber(env.OMNIWORK_RELAY_ADMIN_SESSION_TTL_MS, 1_800_000),
      requireHttps: parseBoolean(
        readConfigBoolean(rawConfig, true, "admin", "requireHttps"),
        parseBoolean(env.OMNIWORK_RELAY_ADMIN_REQUIRE_HTTPS, true),
      ),
      trustProxy: parseBoolean(
        readConfigBoolean(rawConfig, false, "admin", "trustProxy"),
        parseBoolean(env.OMNIWORK_RELAY_ADMIN_TRUST_PROXY, false),
      ),
      trustedProxyIps: parseBlocklist(
        readConfigValue(rawConfig, "admin", "trustedProxyIps") ??
          env.OMNIWORK_RELAY_ADMIN_TRUSTED_PROXY_IPS ??
          "127.0.0.1,::1",
      ),
      controlsDbPath:
        readConfigString(rawConfig, "admin", "controlsDbPath") ??
        optionalNonEmpty(env.OMNIWORK_RELAY_ADMIN_CONTROLS_DB_PATH) ??
        join(runtimeDir, "admin-controls.sqlite"),
      agentDisableDefaultMs:
        readConfigNumber(rawConfig, 86_400_000, "admin", "agentDisableDefaultMs") ??
        parseNumber(env.OMNIWORK_RELAY_AGENT_DISABLE_DEFAULT_MS, 86_400_000),
      ipBanDefaultMs:
        readConfigNumber(rawConfig, 86_400_000, "admin", "ipBanDefaultMs") ??
        parseNumber(env.OMNIWORK_RELAY_IP_BAN_DEFAULT_MS, 86_400_000),
    },
    state: {
      deviceStatusDbPath:
        readConfigString(rawConfig, "state", "deviceStatusDbPath") ??
        optionalNonEmpty(env.OMNIWORK_RELAY_DEVICE_STATUS_DB_PATH) ??
        join(runtimeDir, "relay-device-status.sqlite"),
      deviceStatusRetentionMs:
        readConfigNumber(rawConfig, 604_800_000, "state", "deviceStatusRetentionMs") ??
        parseNumber(env.OMNIWORK_RELAY_DEVICE_STATUS_RETENTION_MS, 604_800_000),
      deviceStatusFlushIntervalMs:
        readConfigNumber(rawConfig, 5000, "state", "deviceStatusFlushIntervalMs") ??
        parseNumber(env.OMNIWORK_RELAY_DEVICE_STATUS_FLUSH_INTERVAL_MS, 5000),
      sweepIntervalMs:
        readConfigNumber(rawConfig, 30_000, "state", "sweepIntervalMs") ??
        parseNumber(env.OMNIWORK_RELAY_STATE_SWEEP_INTERVAL_MS, 30_000),
      pendingAuthTtlMs:
        readConfigNumber(rawConfig, 60_000, "state", "pendingAuthTtlMs") ??
        parseNumber(env.OMNIWORK_RELAY_PENDING_AUTH_TTL_MS, 60_000),
      appContextTtlMs:
        readConfigNumber(rawConfig, 16_000, "state", "appContextTtlMs") ??
        parseNumber(env.OMNIWORK_RELAY_APP_CONTEXT_TTL_MS, 16_000),
    },
    auth: {
      mode: authMode,
      publicBaseUrl,
      dbPath:
        readConfigString(rawConfig, "auth", "dbPath") ??
        optionalNonEmpty(env.OMNIWORK_RELAY_AUTH_DB_PATH) ??
        join(runtimeDir, "relay-auth.sqlite"),
      emailLinkTtlMs:
        readConfigNumber(rawConfig, 900_000, "auth", "emailLinkTtlMs") ??
        parseNumber(env.OMNIWORK_AUTH_EMAIL_LINK_TTL_MS, 900_000),
      sessionTtlMs:
        readConfigNumber(rawConfig, 2_592_000_000, "auth", "sessionTtlMs") ??
        parseNumber(env.OMNIWORK_AUTH_SESSION_TTL_MS, 2_592_000_000),
      deviceEnrollmentTtlMs:
        readConfigNumber(rawConfig, 300_000, "auth", "deviceEnrollmentTtlMs") ??
        parseNumber(env.OMNIWORK_AUTH_DEVICE_ENROLL_TTL_MS, 300_000),
      nonceTtlMs:
        readConfigNumber(rawConfig, 300_000, "auth", "nonceTtlMs") ??
        parseNumber(env.OMNIWORK_AUTH_NONCE_TTL_MS, 300_000),
      emailRateLimitPerHour:
        readConfigNumber(rawConfig, 3, "auth", "emailRateLimitPerHour") ??
        parseNumber(env.OMNIWORK_AUTH_EMAIL_RATE_LIMIT_PER_HOUR, 3),
      ipRateLimitPerHour:
        readConfigNumber(rawConfig, 10, "auth", "ipRateLimitPerHour") ??
        parseNumber(env.OMNIWORK_AUTH_IP_RATE_LIMIT_PER_HOUR, 10),
      maxDevicesPerUser:
        readConfigNumber(rawConfig, 10, "auth", "maxDevicesPerUser") ??
        parseNumber(env.OMNIWORK_AUTH_MAX_DEVICES_PER_USER, 10),
      mail: {
        provider: mailProvider,
        from: mailFrom,
        smtp:
          mailProvider === "smtp"
            ? {
                host: smtpHost ?? "",
                port: smtpPort,
                secure: smtpSecure,
                user: smtpUser ?? "",
                pass: smtpPass ?? "",
              }
            : undefined,
      },
    },
    upgrade: {
      enabled: parseBoolean(
        readConfigBoolean(rawConfig, true, "upgrade", "enabled"),
        parseBoolean(env.OMNIWORK_UPGRADE_ENABLED, true),
      ),
      rolloutPercent:
        readConfigRolloutPercent(rawConfig, 100, "upgrade", "rolloutPercent") ??
        parseRolloutPercent(env.OMNIWORK_UPGRADE_ROLLOUT, 100),
      deviceBlocklist: parseBlocklist(
        readConfigValue(rawConfig, "upgrade", "deviceBlocklist") ??
          env.OMNIWORK_UPGRADE_DEVICE_BLOCKLIST,
      ),
      iceServers: parseIceServers(
        readConfigValue(rawConfig, "upgrade", "iceServers") ??
          env.OMNIWORK_UPGRADE_ICE_SERVERS_JSON,
      ),
      proposeDelayMs:
        readConfigNumber(rawConfig, 3000, "upgrade", "proposeDelayMs") ??
        parseNumber(env.OMNIWORK_UPGRADE_PROPOSE_DELAY_MS, 3000),
      respectClientPreference: parseBoolean(
        readConfigBoolean(rawConfig, true, "upgrade", "respectClientPreference"),
        parseBoolean(env.OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF, true),
      ),
    },
  };
}

export function defaultRelayConfigSearchPaths(
  env: NodeJS.ProcessEnv = process.env,
  programDir = defaultRelayProgramDir(),
): string[] {
  return [join(programDir, "config.yml"), defaultGlobalRelayConfigPath(env)];
}

export function defaultGlobalRelayConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform() === "win32") {
    return join(
      env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "OmniWork",
      "relay",
      "config.yml",
    );
  }
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "OmniWork",
      "relay",
      "config.yml",
    );
  }
  return join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "omniwork",
    "relay",
    "config.yml",
  );
}

function defaultRelayProgramDir(): string {
  return dirname(process.argv[1] ?? fileURLToPath(import.meta.url));
}

function resolveRelayConfigPath(
  env: NodeJS.ProcessEnv,
  options: RelayServerConfigLoadOptions,
): { path?: string; required: boolean } {
  const explicitPath = options.configPath ?? env.OMNIWORK_RELAY_CONFIG_PATH;
  if (explicitPath) {
    return { path: explicitPath, required: true };
  }
  const searchPaths = defaultRelayConfigSearchPaths(
    env,
    options.programDir ?? defaultRelayProgramDir(),
  );
  if (options.globalConfigPath) {
    searchPaths[1] = options.globalConfigPath;
  }
  return {
    path: searchPaths.find((path) => existsSync(path)),
    required: false,
  };
}

function readRelayConfigFile(
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
  const value = readConfigValue(config, ...path);
  return typeof value === "string" ? optionalNonEmpty(value) : undefined;
}

function readConfigBoolean(
  config: Record<string, unknown>,
  fallback: boolean,
  ...path: string[]
): string | undefined {
  const value = readConfigValue(config, ...path);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return typeof value === "string" ? value : undefined;
}

function readConfigNumber(
  config: Record<string, unknown>,
  fallback: number,
  ...path: string[]
): number | undefined {
  const value = readConfigValue(config, ...path);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    return parseNumber(value, fallback);
  }
  return undefined;
}

function readConfigRolloutPercent(
  config: Record<string, unknown>,
  fallback: number,
  ...path: string[]
): number | undefined {
  const value = readConfigValue(config, ...path);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, value));
  }
  if (typeof value === "string") {
    return parseRolloutPercent(value, fallback);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

function parseAuthMode(value: string | undefined): "none" | "email_link" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none") {
    return "none";
  }
  if (normalized === "email_link") {
    return "email_link";
  }
  throw new RelayConfigError(
    `[omniwork-relay] unsupported OMNIWORK_RELAY_AUTH_MODE "${value}". Use none or email_link.`,
  );
}

function parseMailProvider(value: string | undefined): "console" | "smtp" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "console") {
    return "console";
  }
  if (normalized === "smtp") {
    return "smtp";
  }
  throw new RelayConfigError(
    `[omniwork-relay] unsupported OMNIWORK_MAIL_PROVIDER "${value}". Use console or smtp.`,
  );
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listenersOverlap(
  host: string,
  port: number,
  otherHost: string,
  otherPort: number,
): boolean {
  if (port !== otherPort) {
    return false;
  }
  return (
    host === otherHost ||
    host === "0.0.0.0" ||
    otherHost === "0.0.0.0" ||
    host === "::" ||
    otherHost === "::"
  );
}

/**
 * 灰度百分比解析：允许 0，超出 [0,100] 区间则 clamp。
 * parseNumber 拒绝 0，所以单独实现一份。
 */
function parseRolloutPercent(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > 100) {
    return 100;
  }
  return parsed;
}

function parseBlocklist(value: unknown): Set<string> {
  const set = new Set<string>();
  if (!value) {
    return set;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        set.add(item.trim());
      }
    }
    return set;
  }
  if (typeof value !== "string") {
    return set;
  }
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
  return set;
}

function parseIceServers(value: unknown): IceServerConfig[] {
  if (Array.isArray(value)) {
    return value as IceServerConfig[];
  }
  const raw = typeof value === "string" ? value : DEFAULT_ICE_SERVERS_JSON;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as IceServerConfig[];
    }
  } catch {
    // 解析失败回退默认。
  }
  return JSON.parse(DEFAULT_ICE_SERVERS_JSON) as IceServerConfig[];
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}
