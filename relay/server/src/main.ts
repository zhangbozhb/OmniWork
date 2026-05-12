import { RelayServer } from "./relayServer.ts";
import { loadRelayServerConfig } from "./config.ts";

if (process.argv.includes("--check")) {
  console.log("[omniwork-relay] configuration ok", loadRelayServerConfig());
} else {
  const server = new RelayServer(loadRelayServerConfig());
  server.start().catch((error: unknown) => {
    console.error("[omniwork-relay] fatal", error);
    process.exitCode = 1;
  });
}
