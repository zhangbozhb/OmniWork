export interface TunnelServiceConfig {
  host: string;
  port: number;
}

export function loadTunnelServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): TunnelServiceConfig {
  return {
    host: env.OMNIWORK_TUNNEL_HOST ?? "0.0.0.0",
    port: Number(env.OMNIWORK_TUNNEL_PORT ?? "8790"),
  };
}
