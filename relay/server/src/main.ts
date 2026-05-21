import { RelayServer } from "./relayServer.ts";
import { loadRelayServerConfig, RelayConfigError } from "./config.ts";

function main(): void {
  let config;
  try {
    config = loadRelayServerConfig();
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

  const server = new RelayServer(config);
  server.start().catch((error: unknown) => {
    console.error("[omniwork-relay] fatal", error);
    process.exitCode = 1;
  });
}

main();
