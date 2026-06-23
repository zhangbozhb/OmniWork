import { loadAgentConfig } from "../config/config.ts";
import { AgentService } from "../core/agentService.ts";

export async function startAgent(): Promise<AgentService> {
  const config = loadAgentConfig();
  const service = new AgentService(config);
  await service.start();
  return service;
}
