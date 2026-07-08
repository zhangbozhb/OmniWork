import { RelayServer } from "./relayServer.ts";
import {
  loadRelayServerConfig,
  RelayConfigError,
  type RelayServerConfig,
} from "./config.ts";
import { parseRelayConfigPathArgv } from "./configArgs.ts";

function main(): void {
  let config;
  try {
    config = loadRelayServerConfig(process.env, {
      configPath: parseRelayConfigPathArgv(process.argv.slice(2)),
    });
  } catch (error) {
    if (error instanceof RelayConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (process.argv.includes("--check")) {
    console.log("[omniwork-relay] configuration ok", config);
    return;
  }

  logConfigSource(config);
  const server = new RelayServer(config);
  server.start().catch((error: unknown) => {
    console.error("[omniwork-relay] fatal", error);
    process.exitCode = 1;
  });
}

main();

function logConfigSource(config: RelayServerConfig): void {
  if (config.configPath) {
    console.info("[omniwork-relay] using config file", {
      config_path: config.configPath,
    });
    return;
  }
  console.info("[omniwork-relay] no config file found; using default config");
}
