import { strict as assert } from "node:assert";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentInstanceId,
  createAndPersistSessionKey,
  createKeyId,
  createProof,
  generateSessionKey,
  verifyProof,
} from "../src/auth-key/authKey.ts";
import {
  defaultAgentConfigSearchPaths,
  defaultAgentDisplayName,
  defaultAgentConfigPath,
  loadAgentConfig,
  type AgentConfig,
} from "../src/config/config.ts";
import { parseAgentConfigPathArgv } from "../src/config/configArgs.ts";
import { createPairingQrDetails } from "../src/pairing/pairingQr.ts";
import {
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  decryptPairingLink,
  parseEncryptedPairingLink,
} from "@omniwork/protocol-ts";

const key = generateSessionKey();
assert.equal(key.length, 32);
assert.match(key, /^[A-Za-z0-9_-]{32}$/);

const keyId = createKeyId(key);
assert.match(keyId, /^sha256:[0-9a-f]{12}$/);

const nonce = "nonce_for_test_123456";
const appInfo = {
  instance_id: "app_test_1",
  runtime_id: "runtime_test_1",
};
const proof = createProof(key, nonce, appInfo);
assert.equal(verifyProof(key, nonce, appInfo, proof), true);
assert.equal(
  verifyProof(key, nonce, { ...appInfo, instance_id: "app_test_2" }, proof),
  false,
);
assert.equal(verifyProof(key, nonce, appInfo, `${proof}x`), false);

const dir = await mkdtemp(join(tmpdir(), "omniwork-agent-"));
const isolatedConfigOptions = {
  programDir: join(dir, "isolated-program"),
  packageRoot: join(dir, "isolated-package"),
  globalConfigPath: join(dir, "isolated-global-config.yml"),
};
function loadIsolatedAgentConfig(
  env: NodeJS.ProcessEnv,
  options: Parameters<typeof loadAgentConfig>[1] = {},
): AgentConfig {
  return loadAgentConfig(env, { ...isolatedConfigOptions, ...options });
}
const path = join(dir, "nested", "session-key.json");
const record = await createAndPersistSessionKey({
  path,
  agentInstanceId: createAgentInstanceId(new Date("2026-05-12T00:00:00Z")),
  relayUrl: "wss://relay.example/relay/ws/agent",
  now: new Date("2026-05-12T00:00:00Z"),
});

const raw = await readFile(path, "utf8");
assert.equal(JSON.parse(raw).key_id, record.key_id);
assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
assert.equal((await stat(path)).mode & 0o777, 0o600);

const baseConfig: AgentConfig = {
  agentVersion: "test",
  deviceId: "test-mac",
  hostname: "test.local",
  displayName: "test",
  relayUrl: "wss://relay.example/relay/ws/agent",
  relayDeviceCredentialsPath: join(dir, "relay-device.json"),
  adminEnabled: true,
  adminHost: "127.0.0.1",
  adminPort: 17668,
  agentProbeEnabled: true,
  agentProbeHost: "127.0.0.1",
  agentProbePort: 17669,
  connectionHeartbeatMs: 10000,
  connectionStaleMs: 30000,
  connectionDisconnectMs: 90000,
  relayReconnectForever: true,
  relayReconnectMaxAttempts: 8,
  relayReconnectInitialDelayMs: 1000,
  relayReconnectMaxDelayMs: 30000,
  terminalProviders: [...DEFAULT_TERMINAL_PROVIDER_DEFINITIONS],
  defaultCwd: dir,
  appSupportDir: dir,
  sessionKeyPath: path,
  sessionStorePath: join(dir, "sessions.sqlite"),
  terminalSize: { cols: 80, rows: 24 },
  terminalStreamEnabled: false,
  businessSecurityMode: "e2e_required",
};

assert.equal(
  createPairingQrDetails(baseConfig, record)?.payload.relay_url,
  "wss://relay.example/relay/ws/mobile",
);
assert.equal(
  createPairingQrDetails(baseConfig, record)?.payload.display_name,
  "test",
);
{
  const details = createPairingQrDetails(baseConfig, record);
  assert.ok(details);
  assert.match(details.password, /^\d{4}$/u);
  assert.equal(parseEncryptedPairingLink(details.link)?.source, "agent");
  assert.equal(
    decryptPairingLink(details.link, details.password).display_name,
    "test",
  );
}
assert.equal(defaultAgentDisplayName("work-mac.local"), "work-mac");
assert.equal(defaultAgentDisplayName("work-mac.LOCAL"), "work-mac");

assert.throws(
  () => loadIsolatedAgentConfig({ OMNIWORK_DEVICE_ID: "" }),
  /relay.url is required/,
);

assert.equal(
  defaultAgentConfigPath("/tmp/omniwork-agent"),
  "/tmp/omniwork-agent/config.yml",
);
assert.equal(
  parseAgentConfigPathArgv(["--config", "/tmp/agent.yml"]),
  "/tmp/agent.yml",
);
assert.equal(
  parseAgentConfigPathArgv(["--config=/tmp/agent.yml"]),
  "/tmp/agent.yml",
);
assert.equal(
  parseAgentConfigPathArgv(["-c", "/tmp/agent.yml"]),
  "/tmp/agent.yml",
);
assert.throws(
  () => parseAgentConfigPathArgv(["--config"]),
  /requires a config file path/,
);

{
  const config = loadIsolatedAgentConfig({
    OMNIWORK_RELAY_URL: "wss://relay.example/relay/ws/agent",
    OMNIWORK_DEVICE_ID: "mac-1",
    OMNIWORK_AGENT_VERSION: "env-version",
  });
  assert.equal(config.configPath, undefined);
  assert.equal(config.agentVersion, "0.1.0");
  assert.equal(config.relayReconnectForever, true);
  assert.equal(config.relayReconnectMaxAttempts, 8);
  assert.ok(config.displayName.length > 0);
}

{
  const config = loadIsolatedAgentConfig({
    OMNIWORK_RELAY_URL: "wss://relay.example/relay/ws/agent",
    OMNIWORK_DEVICE_ID: "mac-1",
    OMNIWORK_AGENT_DISPLAY_NAME: "Alice MacBook",
  });
  assert.equal(config.displayName, "Alice MacBook");
}

{
  const yamlConfigPath = join(dir, "agent-config.yml");
  await writeFile(
    yamlConfigPath,
    `
relay:
  url: wss://yaml-relay.example/relay/ws/agent
agent:
  deviceId: yaml-device
  displayName: YAML Desktop
  requireE2e: false
admin:
  enabled: false
  port: 18000
probe:
  enabled: false
connection:
  heartbeatMs: 11000
  staleMs: 31000
  disconnectMs: 91000
relayReconnect:
  forever: false
  maxAttempts: 3
  initialDelayMs: 1500
  maxDelayMs: 45000
terminal:
  streamEnabled: true
  size:
    cols: 120
    rows: 40
  providers:
    - kind: opencode
      displayName: OpenCode
      command: opencode
      summary: OpenCode YAML session
paths:
  appSupportDir: ${dir}
  defaultCwd: ${dir}
`,
  );
  const config = loadAgentConfig(
    {
      OMNIWORK_RELAY_URL: "wss://env-relay.example/relay/ws/agent",
    },
    {
      configPath: yamlConfigPath,
      commandExists: (command) => command === "opencode",
    },
  );
  assert.equal(config.configPath, yamlConfigPath);
  assert.equal(config.relayUrl, "wss://yaml-relay.example/relay/ws/agent");
  assert.equal(config.agentVersion, "0.1.0");
  assert.equal(config.deviceId, "yaml-device");
  assert.equal(config.displayName, "YAML Desktop");
  assert.equal(config.adminEnabled, false);
  assert.equal(config.adminPort, 18000);
  assert.equal(config.agentProbeEnabled, false);
  assert.equal(config.connectionHeartbeatMs, 11000);
  assert.equal(config.connectionStaleMs, 31000);
  assert.equal(config.connectionDisconnectMs, 91000);
  assert.equal(config.relayReconnectForever, false);
  assert.equal(config.relayReconnectMaxAttempts, 3);
  assert.equal(config.relayReconnectInitialDelayMs, 1500);
  assert.equal(config.relayReconnectMaxDelayMs, 45000);
  assert.equal(config.terminalStreamEnabled, true);
  assert.deepEqual(config.terminalSize, { cols: 120, rows: 40 });
  assert.equal(config.businessSecurityMode, "plaintext_allowed");
  assert.deepEqual(
    config.terminalProviders.map((provider) => provider.kind),
    ["opencode", "terminal"],
  );
  assert.equal(
    config.terminalProviders.find((provider) => provider.kind === "opencode")
      ?.summary,
    "OpenCode YAML session",
  );
}

{
  const cwd = join(dir, "cwd");
  const programDir = join(dir, "program-dir");
  const packageRoot = join(dir, "package-root");
  const globalDir = join(dir, "global-dir");
  await mkdir(cwd);
  await mkdir(programDir);
  await mkdir(packageRoot);
  await mkdir(globalDir);
  const cwdConfigPath = join(cwd, "config.yml");
  const programConfigPath = join(programDir, "config.yml");
  const packageConfigPath = join(packageRoot, "config.yml");
  const globalConfigPath = join(globalDir, "config.yml");
  await writeFile(
    cwdConfigPath,
    "relay:\n  url: wss://cwd.example/relay/ws/agent\nagent:\n  deviceId: cwd-device\n",
  );
  await writeFile(
    programConfigPath,
    "relay:\n  url: wss://program.example/relay/ws/agent\nagent:\n  deviceId: program-device\n",
  );
  await writeFile(
    packageConfigPath,
    "relay:\n  url: wss://package.example/relay/ws/agent\nagent:\n  deviceId: package-device\n",
  );
  await writeFile(
    globalConfigPath,
    "relay:\n  url: wss://global.example/relay/ws/agent\nagent:\n  deviceId: global-device\n",
  );

  assert.deepEqual(
    defaultAgentConfigSearchPaths({}, programDir, packageRoot, cwd),
    [
      cwdConfigPath,
      programConfigPath,
      packageConfigPath,
      defaultAgentConfigPath(),
    ],
  );

  const cwdConfig = loadAgentConfig(
    {},
    {
      programDir,
      packageRoot,
      globalConfigPath,
      cwd,
      commandExists: () => false,
    },
  );
  assert.equal(cwdConfig.configPath, cwdConfigPath);
  assert.equal(cwdConfig.relayUrl, "wss://cwd.example/relay/ws/agent");
  assert.equal(cwdConfig.deviceId, "cwd-device");

  const programConfig = loadAgentConfig(
    {},
    {
      programDir,
      packageRoot,
      globalConfigPath,
      cwd: join(dir, "missing-cwd"),
      commandExists: () => false,
    },
  );
  assert.equal(programConfig.configPath, programConfigPath);
  assert.equal(programConfig.relayUrl, "wss://program.example/relay/ws/agent");
  assert.equal(programConfig.deviceId, "program-device");

  await writeFile(
    programConfigPath,
    "relay:\n  url: wss://explicit.example/relay/ws/agent\nagent:\n  deviceId: explicit-device\n",
  );
  const explicitConfig = loadAgentConfig(
    {},
    {
      configPath: programConfigPath,
      programDir: join(dir, "missing-program-dir"),
      packageRoot,
      globalConfigPath,
      cwd: join(dir, "missing-cwd"),
      commandExists: () => false,
    },
  );
  assert.equal(
    explicitConfig.relayUrl,
    "wss://explicit.example/relay/ws/agent",
  );
  assert.equal(explicitConfig.configPath, programConfigPath);
  assert.equal(explicitConfig.deviceId, "explicit-device");

  const packageConfig = loadAgentConfig(
    {},
    {
      programDir: join(dir, "missing-program-dir"),
      packageRoot,
      globalConfigPath,
      cwd: join(dir, "missing-cwd"),
      commandExists: () => false,
    },
  );
  assert.equal(packageConfig.configPath, packageConfigPath);
  assert.equal(packageConfig.relayUrl, "wss://package.example/relay/ws/agent");
  assert.equal(packageConfig.deviceId, "package-device");

  const globalConfig = loadAgentConfig(
    {},
    {
      programDir: join(dir, "missing-program-dir"),
      packageRoot: join(dir, "missing-package-root"),
      globalConfigPath,
      cwd: join(dir, "missing-cwd"),
      commandExists: () => false,
    },
  );
  assert.equal(globalConfig.configPath, globalConfigPath);
  assert.equal(globalConfig.relayUrl, "wss://global.example/relay/ws/agent");
  assert.equal(globalConfig.deviceId, "global-device");
}

{
  const config = loadIsolatedAgentConfig({
    OMNIWORK_RELAY_URL: "wss://relay.example/relay/ws/agent",
    OMNIWORK_DEVICE_ID: "mac-1",
    OMNIWORK_AGENT_RELAY_RECONNECT_FOREVER: "false",
    OMNIWORK_AGENT_RELAY_RECONNECT_MAX_ATTEMPTS: "0",
  });
  assert.equal(config.relayReconnectForever, false);
  assert.equal(config.relayReconnectMaxAttempts, 0);
}
const configEnv = {
  OMNIWORK_RELAY_URL: "wss://relay.example/relay/ws/agent",
  OMNIWORK_AGENT_IDENTITY_PATH: join(dir, "agent.json"),
  OMNIWORK_AGENT_IDENTITY_IP: "10.0.0.2",
};
assert.match(
  loadIsolatedAgentConfig({ ...configEnv, OMNIWORK_DEVICE_ID: "" }).deviceId,
  /^dev_[0-9a-f]{16}$/,
);
assert.equal(
  loadIsolatedAgentConfig({
    ...configEnv,
    OMNIWORK_DEVICE_ID: "custom-device",
  }).deviceId,
  "custom-device",
);
assert.equal(
  loadIsolatedAgentConfig(
    {
      ...configEnv,
      OMNIWORK_CLAUDECODE_COMMAND: "claudecode",
    },
    {
      commandExists: (command) => command === "claudecode",
    },
  ).terminalProviders.find((provider) => provider.kind === "claude")
    ?.defaultCommand,
  "claudecode",
);
{
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  for (const command of ["codex", "claude", "gemini", "traecli"]) {
    const commandPath = join(binDir, command);
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n");
    await chmod(commandPath, 0o755);
  }
  const providers = loadIsolatedAgentConfig({
    ...configEnv,
    PATH: binDir,
  }).terminalProviders;
  assert.deepEqual(
    providers.map((provider) => provider.kind),
    ["codex", "claude", "gemini", "trae", "trae-cn", "terminal"],
  );
  assert.equal(
    providers.find((provider) => provider.kind === "trae")?.defaultCommand,
    "traecli",
  );
  assert.equal(
    providers.find((provider) => provider.kind === "trae-cn")?.defaultCommand,
    "traecli",
  );
}
{
  const providers = loadIsolatedAgentConfig(
    {
      ...configEnv,
      OMNIWORK_TRAE_COMMAND: "traecli",
      OMNIWORK_TRAE_CN_COMMAND: "traecli-cn",
    },
    {
      commandExists: (command) =>
        command === "traecli" || command === "traecli-cn",
    },
  ).terminalProviders;
  assert.equal(
    providers.find((provider) => provider.kind === "trae")?.defaultCommand,
    "traecli",
  );
  assert.equal(
    providers.find((provider) => provider.kind === "trae-cn")?.defaultCommand,
    "traecli-cn",
  );
}
assert.deepEqual(
  loadIsolatedAgentConfig(
    {
      ...configEnv,
      OMNIWORK_TERMINAL_PROVIDERS: JSON.stringify([
        {
          kind: "opencode",
          displayName: "OpenCode",
          command: "opencode",
        },
      ]),
    },
    {
      commandExists: (command) => command === "opencode",
    },
  ).terminalProviders,
  [
    {
      kind: "opencode",
      displayName: "OpenCode",
      capability: "opencode.cli",
      summary: "OpenCode CLI TUI session",
      defaultCommand: "opencode",
      creatable: true,
    },
    {
      kind: "terminal",
      displayName: "Terminal",
      capability: "terminal.shell",
      summary: "Plain terminal session",
      defaultCommand: "",
      creatable: true,
    },
  ],
);
assert.deepEqual(
  loadIsolatedAgentConfig(
    {
      ...configEnv,
      OMNIWORK_TERMINAL_PROVIDERS: JSON.stringify([
        {
          kind: "missing",
          displayName: "Missing",
          command: "missing-agent-command",
        },
      ]),
    },
    {
      commandExists: () => false,
    },
  ).terminalProviders,
  [
    {
      kind: "terminal",
      displayName: "Terminal",
      capability: "terminal.shell",
      summary: "Plain terminal session",
      defaultCommand: "",
      creatable: true,
    },
  ],
);

console.log("auth-key tests passed");
