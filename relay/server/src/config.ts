export interface RelayServerConfig {
  host: string;
  port: number;
}

export function loadRelayServerConfig(env: NodeJS.ProcessEnv = process.env): RelayServerConfig {
  return {
    host: env.OMNIWORK_RELAY_HOST ?? "127.0.0.1",
    port: Number(env.OMNIWORK_RELAY_PORT ?? "8787"),
  };
}
