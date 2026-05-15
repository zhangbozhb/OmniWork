import { loadTunnelServiceConfig } from "./config.ts";
import { TunnelService } from "./tunnelService.ts";

const config = loadTunnelServiceConfig();

if (process.argv.includes("--check")) {
  console.log("[omniwork-tunnel] configuration ok", config);
  process.exit(0);
}

const service = new TunnelService(config);

service.start().catch((error: unknown) => {
  console.error("[omniwork-tunnel] failed to start", error);
  process.exit(1);
});
