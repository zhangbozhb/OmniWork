import { join } from "node:path";

import type { IceServerConfig } from "@omniwork/protocol-ts";

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
  /** 升级编排器配置。阶段 4 引入。 */
  upgrade: UpgradeOrchestratorConfig;
}

export class RelayConfigError extends Error {}

const DEFAULT_ICE_SERVERS_JSON = '[{"urls":"stun:stun.l.google.com:19302"}]';

export function loadRelayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelayServerConfig {
  const host = env.OMNIWORK_RELAY_HOST ?? "127.0.0.1";
  const allowPlaintextWs = parseBoolean(
    env.OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS,
    isLoopbackHost(host),
  );
  const requireE2E = parseBoolean(env.OMNIWORK_RELAY_REQUIRE_E2E, true);

  if (!isLoopbackHost(host) && !allowPlaintextWs) {
    throw new RelayConfigError(
      `[omniwork-relay] refusing to start on non-loopback host "${host}" without explicit plaintext ws allowance. ` +
        `Set OMNIWORK_RELAY_ALLOW_PLAINTEXT_WS=true after confirming OMNIWORK_RELAY_REQUIRE_E2E=true.`,
    );
  }

  const runtimeDir =
    optionalNonEmpty(env.OMNIWORK_RELAY_RUNTIME_DIR) ??
    join(process.cwd(), ".omniwork-relay");
  const port = Number(env.OMNIWORK_RELAY_PORT ?? "8787");
  const adminHost = env.OMNIWORK_RELAY_ADMIN_HOST ?? "127.0.0.1";
  const adminPort = Number(env.OMNIWORK_RELAY_ADMIN_PORT ?? "8788");

  if (listenersOverlap(host, port, adminHost, adminPort)) {
    throw new RelayConfigError(
      `[omniwork-relay] admin listener must not share the business listener ${host}:${adminPort}. ` +
        `Set OMNIWORK_RELAY_ADMIN_PORT to a separate local port.`,
    );
  }

  return {
    host,
    port,
    deviceId: env.OMNIWORK_DEVICE_ID ?? "omniwork-relay",
    allowPlaintextWs,
    requireE2E,
    protocolVersion: 1,
    minProtocolVersion: 1,
    authRateLimit: {
      capacity: parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_CAPACITY, 5),
      refillPerSecond: parseNumber(
        env.OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC,
        1,
      ),
      blockMs: parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS, 60_000),
    },
    admin: {
      host: adminHost,
      port: adminPort,
      webEnabled: parseBoolean(env.OMNIWORK_RELAY_ADMIN_WEB_ENABLED, false),
      tokenDir:
        optionalNonEmpty(env.OMNIWORK_RELAY_ADMIN_TOKEN_DIR) ?? runtimeDir,
      tokenRotateMs: parseNumber(
        env.OMNIWORK_RELAY_ADMIN_TOKEN_ROTATE_MS,
        3_600_000,
      ),
      sessionTtlMs: parseNumber(
        env.OMNIWORK_RELAY_ADMIN_SESSION_TTL_MS,
        1_800_000,
      ),
      requireHttps: parseBoolean(env.OMNIWORK_RELAY_ADMIN_REQUIRE_HTTPS, true),
      trustProxy: parseBoolean(env.OMNIWORK_RELAY_ADMIN_TRUST_PROXY, false),
      trustedProxyIps: parseBlocklist(
        env.OMNIWORK_RELAY_ADMIN_TRUSTED_PROXY_IPS ?? "127.0.0.1,::1",
      ),
      controlsDbPath:
        optionalNonEmpty(env.OMNIWORK_RELAY_ADMIN_CONTROLS_DB_PATH) ??
        join(runtimeDir, "admin-controls.sqlite"),
      agentDisableDefaultMs: parseNumber(
        env.OMNIWORK_RELAY_AGENT_DISABLE_DEFAULT_MS,
        86_400_000,
      ),
      ipBanDefaultMs: parseNumber(
        env.OMNIWORK_RELAY_IP_BAN_DEFAULT_MS,
        86_400_000,
      ),
    },
    state: {
      deviceStatusDbPath:
        optionalNonEmpty(env.OMNIWORK_RELAY_DEVICE_STATUS_DB_PATH) ??
        join(runtimeDir, "relay-device-status.sqlite"),
      deviceStatusRetentionMs: parseNumber(
        env.OMNIWORK_RELAY_DEVICE_STATUS_RETENTION_MS,
        604_800_000,
      ),
      deviceStatusFlushIntervalMs: parseNumber(
        env.OMNIWORK_RELAY_DEVICE_STATUS_FLUSH_INTERVAL_MS,
        5000,
      ),
      sweepIntervalMs: parseNumber(
        env.OMNIWORK_RELAY_STATE_SWEEP_INTERVAL_MS,
        30_000,
      ),
      pendingAuthTtlMs: parseNumber(
        env.OMNIWORK_RELAY_PENDING_AUTH_TTL_MS,
        60_000,
      ),
      appContextTtlMs: parseNumber(
        env.OMNIWORK_RELAY_APP_CONTEXT_TTL_MS,
        16_000,
      ),
    },
    upgrade: {
      enabled: parseBoolean(env.OMNIWORK_UPGRADE_ENABLED, true),
      rolloutPercent: parseRolloutPercent(env.OMNIWORK_UPGRADE_ROLLOUT, 100),
      deviceBlocklist: parseBlocklist(env.OMNIWORK_UPGRADE_DEVICE_BLOCKLIST),
      iceServers: parseIceServers(env.OMNIWORK_UPGRADE_ICE_SERVERS_JSON),
      proposeDelayMs: parseNumber(env.OMNIWORK_UPGRADE_PROPOSE_DELAY_MS, 3000),
      respectClientPreference: parseBoolean(
        env.OMNIWORK_UPGRADE_RESPECT_CLIENT_PREF,
        true,
      ),
    },
  };
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

function parseBlocklist(value: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!value) {
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

function parseIceServers(value: string | undefined): IceServerConfig[] {
  const raw = value ?? DEFAULT_ICE_SERVERS_JSON;
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
