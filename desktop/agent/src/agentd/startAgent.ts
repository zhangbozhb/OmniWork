import { loadAgentConfig, type AgentConfig } from "../config/config.ts";
import { AgentService } from "../core/agentService.ts";

export async function startAgent(): Promise<AgentService> {
  const config = loadAgentConfig();
  logConfigSource(config);
  const service = new AgentService(config);
  await service.start();
  return service;
}

function logConfigSource(config: AgentConfig): void {
  if (config.configPath) {
    console.info("[omniwork-agent] using config file", {
      config_path: config.configPath,
    });
    return;
  }
  console.info("[omniwork-agent] no config file found; using default config");
}
