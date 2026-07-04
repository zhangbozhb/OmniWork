import { loadAgentConfig } from "./config/config.ts";
import { AgentService } from "./core/agentService.ts";

let service: AgentService | null = null;

function stopAndExit(signal: NodeJS.Signals): void {
  console.info("[omniwork-agent] stopping", { signal });
  service?.stop();
  process.exitCode = 0;
}

process.once("SIGINT", stopAndExit);
process.once("SIGTERM", stopAndExit);

try {
  service = new AgentService(loadAgentConfig(), {
    onShutdownRequested: (reason) => {
      console.info("[omniwork-agent] exiting after relay shutdown request", {
        reason,
      });
      process.exit(0);
    },
  });
  await service.start();
} catch (error: unknown) {
  console.error("[omniwork-agent] fatal", error);
  process.exitCode = 1;
}
