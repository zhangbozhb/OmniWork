import { startAgent } from "./agentd/startAgent.ts";
import type { AgentService } from "./core/agentService.ts";

let service: AgentService | null = null;

function stopAndExit(signal: NodeJS.Signals): void {
  console.info("[omniwork-agent] stopping", { signal });
  service?.stop();
  process.exitCode = 0;
}

process.once("SIGINT", stopAndExit);
process.once("SIGTERM", stopAndExit);

startAgent()
  .then((startedService) => {
    service = startedService;
  })
  .catch((error: unknown) => {
  console.error("[omniwork-agent] fatal", error);
  process.exitCode = 1;
});
