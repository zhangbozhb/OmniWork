import type { IceServerConfig } from "../../../packages/protocol-ts/src/index.ts";

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
}

export interface RelayServerConfig {
  host: string;
  port: number;
  deviceId: string;
  /**
   * 是否在前置 TLS（reverse proxy / ingress）后运行。
   * 当 host 不是 loopback 时必须显式声明 trustForwardedTls=true，否则启动会拒绝以避免明文上线。
   */
  trustForwardedTls: boolean;
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
  /** 升级编排器配置。阶段 4 引入。 */
  upgrade: UpgradeOrchestratorConfig;
}

export class RelayConfigError extends Error {}

const DEFAULT_ICE_SERVERS_JSON = '[{"urls":"stun:stun.l.google.com:19302"}]';

export function loadRelayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelayServerConfig {
  const host = env.OMNIWORK_RELAY_HOST ?? "127.0.0.1";
  const trustForwardedTls = parseBoolean(
    env.OMNIWORK_RELAY_TRUST_FORWARDED_TLS,
    false,
  );

  if (!isLoopbackHost(host) && !trustForwardedTls) {
    throw new RelayConfigError(
      `[omniwork-relay] refusing to start on non-loopback host "${host}" without TLS termination. ` +
        `Set OMNIWORK_RELAY_TRUST_FORWARDED_TLS=true only when running behind an HTTPS/wss reverse proxy.`,
    );
  }

  return {
    host,
    port: Number(env.OMNIWORK_RELAY_PORT ?? "8787"),
    deviceId: env.OMNIWORK_DEVICE_ID ?? "omniwork-relay",
    trustForwardedTls,
    authRateLimit: {
      capacity: parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_CAPACITY, 5),
      refillPerSecond: parseNumber(
        env.OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC,
        1,
      ),
      blockMs: parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS, 60_000),
    },
    upgrade: {
      enabled: parseBoolean(env.OMNIWORK_UPGRADE_ENABLED, true),
      rolloutPercent: parseRolloutPercent(env.OMNIWORK_UPGRADE_ROLLOUT, 100),
      deviceBlocklist: parseBlocklist(env.OMNIWORK_UPGRADE_DEVICE_BLOCKLIST),
      iceServers: parseIceServers(env.OMNIWORK_UPGRADE_ICE_SERVERS_JSON),
      proposeDelayMs: parseNumber(
        env.OMNIWORK_UPGRADE_PROPOSE_DELAY_MS,
        3000,
      ),
    },
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

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
