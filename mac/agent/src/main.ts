import { startAgent } from "./agentd/startAgent.ts";

startAgent().catch((error: unknown) => {
  console.error("[omniwork-agent] fatal", error);
  process.exitCode = 1;
});
