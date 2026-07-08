import { loadAgentConfig, type AgentConfig } from "./config/config.ts";
import { parseAgentConfigPathArgv } from "./config/configArgs.ts";
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
  const config = loadAgentConfig(process.env, {
    configPath: parseAgentConfigPathArgv(process.argv.slice(2)),
  });
  logConfigSource(config);
  service = new AgentService(config, {
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

function logConfigSource(config: AgentConfig): void {
  if (config.configPath) {
    console.info("[omniwork-agent] using config file", {
      config_path: config.configPath,
    });
    return;
  }
  console.info("[omniwork-agent] no config file found; using default config");
}
