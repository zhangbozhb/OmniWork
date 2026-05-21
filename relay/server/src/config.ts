export interface RelayServerConfig {
  host: string;
  port: number;
  deviceId: string;
  webrtc: {
    iceServers: Array<{ urls: string | string[] }>;
  };
  tunnelService?: {
    relayUrl: string;
  };
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
}

export class RelayConfigError extends Error {}

export function loadRelayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelayServerConfig {
  const stunUrls = (
    env.OMNIWORK_TUNNEL_STUN_URLS ?? "stun:stun.cloudflare.com:3478"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

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
    webrtc: {
      iceServers: stunUrls.length > 0 ? [{ urls: stunUrls }] : [],
    },
    tunnelService: env.OMNIWORK_TUNNEL_SERVICE_RELAY_URL
      ? { relayUrl: env.OMNIWORK_TUNNEL_SERVICE_RELAY_URL }
      : undefined,
    trustForwardedTls,
    authRateLimit: {
      capacity: parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_CAPACITY, 5),
      refillPerSecond: parseNumber(
        env.OMNIWORK_RELAY_AUTH_RATE_REFILL_PER_SEC,
        1,
      ),
      blockMs: parseNumber(env.OMNIWORK_RELAY_AUTH_RATE_BLOCK_MS, 60_000),
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}
