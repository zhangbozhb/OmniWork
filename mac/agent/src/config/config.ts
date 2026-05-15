import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { DEFAULT_TERMINAL_SIZE } from "../../../../packages/terminal-core/src/index.ts";
import type {
  PairingTransport,
  TerminalSize,
} from "../../../../packages/protocol-ts/src/index.ts";

export interface AgentConfig {
  agentVersion: string;
  deviceId: string;
  hostname: string;
  relayUrl?: string;
  pairingRelayUrl?: string;
  pairingTransport: PairingTransport;
  codexCommand: string;
  claudeCommand: string;
  defaultCwd: string;
  appSupportDir: string;
  sessionKeyPath: string;
  sessionStorePath: string;
  terminalSize: TerminalSize;
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const appSupportDir =
    env.OMNIWORK_APP_SUPPORT_DIR ??
    join(homedir(), "Library", "Application Support", "OmniWork", "agent");

  return {
    agentVersion: env.OMNIWORK_AGENT_VERSION ?? "0.1.0",
    deviceId: resolveDeviceId(env.OMNIWORK_DEVICE_ID),
    hostname: hostname(),
    relayUrl: env.OMNIWORK_RELAY_URL,
    pairingRelayUrl: env.OMNIWORK_PAIRING_RELAY_URL,
    pairingTransport: parsePairingTransport(env.OMNIWORK_PAIRING_TRANSPORT),
    codexCommand: env.OMNIWORK_CODEX_COMMAND ?? "codex",
    claudeCommand: env.OMNIWORK_CLAUDE_COMMAND ?? "claude",
    defaultCwd: env.OMNIWORK_DEFAULT_CWD ?? process.cwd(),
    appSupportDir,
    sessionKeyPath:
      env.OMNIWORK_SESSION_KEY_PATH ?? join(appSupportDir, "session-key.json"),
    sessionStorePath:
      env.OMNIWORK_SESSION_STORE_PATH ?? join(appSupportDir, "sessions.json"),
    terminalSize: DEFAULT_TERMINAL_SIZE,
  };
}

function parsePairingTransport(value?: string): PairingTransport {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "webrtc") {
    return "webrtc";
  }
  if (normalized === "websocket") {
    return "websocket";
  }
  return "websocket";
}

function resolveDeviceId(value?: string): string {
  const configuredDeviceId = value?.trim();
  if (configuredDeviceId) {
    return configuredDeviceId;
  }

  return hostname().replace(/[^a-zA-Z0-9_-]/g, "-");
}
