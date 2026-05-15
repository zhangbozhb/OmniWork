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
}

export function loadRelayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelayServerConfig {
  const stunUrls = (
    env.OMNIWORK_TUNNEL_STUN_URLS ?? "stun:stun.cloudflare.com:3478"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    host: env.OMNIWORK_RELAY_HOST ?? "127.0.0.1",
    port: Number(env.OMNIWORK_RELAY_PORT ?? "8787"),
    deviceId: env.OMNIWORK_DEVICE_ID ?? "omniwork-relay",
    webrtc: {
      iceServers: stunUrls.length > 0 ? [{ urls: stunUrls }] : [],
    },
    tunnelService: env.OMNIWORK_TUNNEL_SERVICE_RELAY_URL
      ? { relayUrl: env.OMNIWORK_TUNNEL_SERVICE_RELAY_URL }
      : undefined,
  };
}
