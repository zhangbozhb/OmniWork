#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TRAE_PROVIDERS = new Set([
  "trae",
  "traex",
  "coco",
  "trae-cn",
  "trae_cn",
  "traecn",
]);

const MANAGED_TRAE_HOOK_EVENTS = [
  { name: "SessionStart" },
  { name: "UserPromptSubmit" },
  { name: "Stop" },
];

const DEPRECATED_RECORD_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
];

const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

async function main() {
  if (process.argv[2] === "install") {
    await installTraeRecordHooks();
    return;
  }

  const hookPayload = await readHookPayload();
  await writeTraeRecord(hookPayload);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readHookPayload() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { payload: null, source: undefined };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { payload: null, source: undefined };
  }

  const hookEvent =
    process.env.OMNIWORK_AGENT_HOOK_EVENT?.trim() ??
    process.env.OMNIWORK_TRAE_HOOK_EVENT?.trim();
  if (hookEvent) {
    if (typeof payload.hook_event_name !== "string") {
      payload.hook_event_name = hookEvent;
    }
    payload.omniwork_hook_event = hookEvent;
  }

  const hookSource =
    process.env.OMNIWORK_AGENT_HOOK_SOURCE?.trim() ??
    process.env.OMNIWORK_HOOK_SOURCE?.trim() ??
    process.env.OMNIWORK_TRAE_HOOK_SOURCE?.trim();
  if (hookSource) {
    payload.omniwork_hook_source = hookSource;
  }

  const source = hookSource ?? readString(payload.omniwork_hook_source);
  if (
    isTraeProvider(source) &&
    typeof payload.omniwork_record_id !== "string"
  ) {
    payload.omniwork_record_id = createRecordId(source, payload);
  }

  return { payload, source };
}

async function writeTraeRecord(hookPayload) {
  if (!hookPayload.payload) {
    return;
  }
  if (isIgnoredHookEvent(readHookEvent(hookPayload.payload))) {
    return;
  }
  const provider = isTraeProvider(hookPayload.source)
    ? normalizeTraeProvider(hookPayload.source)
    : "trae-unknown";
  const record = createTraeRecord(provider, hookPayload.payload);
  const roots = resolveTraeRecordsRoots(provider);
  let wrote = false;
  for (const root of roots) {
    try {
      await appendTraeRecord(root, record);
      wrote = true;
    } catch {
      // Hooks must never block the agent runtime.
    }
  }
  if (!wrote) {
    await writeFallbackRecord(record);
  }
}

async function appendTraeRecord(root, record) {
  const path = resolveTraeRecordPath(root, record.created_at);
  const sessionsDir = dirname(path);
  await ensureDirectoryExists(sessionsDir);
  await withFileLock(`${path}.lock`, async () => {
    await appendFile(path, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  });
}

async function ensureDirectoryExists(path) {
  try {
    const pathStat = await stat(path);
    if (pathStat.isDirectory()) {
      return;
    }
    throw new Error(`Expected directory path: ${path}`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

async function withFileLock(lockPath, fn) {
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }

  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function removeStaleLock(lockPath) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch {
    return;
  }
  if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
    await unlink(lockPath).catch(() => {});
  }
}

function isFileExistsError(error) {
  return error && typeof error === "object" && error.code === "EEXIST";
}

function isNotFoundError(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeFallbackRecord(record) {
  try {
    await appendTraeRecord(fallbackRecordsRoot(record.provider), record);
  } catch {
    // Hooks must never block the agent runtime.
  }
}

function createTraeRecord(provider, payload) {
  const createdAt = new Date().toISOString();
  return {
    schema_version: 1,
    record_id:
      readString(payload.omniwork_record_id) ??
      createRecordId(provider, payload),
    provider,
    hook_event: readHookEvent(payload),
    created_at: createdAt,
    workspace_path:
      readString(payload.workspace_path) ?? readString(payload.cwd),
    payload_mode: "full",
    normalized: normalizedEvent(provider, payload),
    coverage: coverageFields(payload),
    conversation: conversationFields(payload),
    payload: cloneJsonObject(payload),
  };
}

function normalizedEvent(provider, payload) {
  const hookEvent = readHookEvent(payload);
  const base = {
    provider,
    session_id: readString(payload.session_id),
    conversation_id: readString(payload.conversation_id),
    workspace_path: readString(payload.workspace_path),
    hook_event: hookEvent,
  };

  switch (hookEvent) {
    case "SessionStart":
    case "session_start":
      return {
        ...base,
        type: "session_meta",
      };
    case "UserPromptSubmit":
    case "user_prompt_submit":
      return {
        ...base,
        type: "message",
        role: "user",
        content: readUserInput(payload),
      };
    case "PreToolUse":
    case "pre_tool_use":
      return {
        ...base,
        type: "tool_call",
        tool_name:
          readString(payload.tool_name) ?? readString(payload.llm_tool_name),
        tool_use_id: readString(payload.tool_use_id),
        input: payload.tool_input,
      };
    case "PostToolUse":
    case "post_tool_use":
      return {
        ...base,
        type: "tool_result",
        tool_name:
          readString(payload.tool_name) ?? readString(payload.llm_tool_name),
        tool_use_id: readString(payload.tool_use_id),
        input: payload.tool_input,
        output: payload.tool_response,
        error: payload.error,
      };
    case "Notification":
    case "notification":
      return {
        ...base,
        type: "notification",
        notification_type: readString(payload.notification_type),
        content: readString(payload.message),
      };
    case "Stop":
    case "stop":
      return {
        ...base,
        type: "message",
        role: "assistant",
        content: readModelResponse(payload),
      };
    default:
      return {
        ...base,
        type: "hook_event",
      };
  }
}

function coverageFields(payload) {
  return {
    has_session_id: Boolean(
      readString(payload.session_id) ?? readString(payload.conversation_id),
    ),
    has_workspace_path: Boolean(
      readString(payload.workspace_path) ?? readString(payload.cwd),
    ),
    has_user_input: Boolean(readUserInput(payload)),
    has_model_response: Boolean(readModelResponse(payload)),
    has_tool_input: payload.tool_input !== undefined,
    has_tool_response: payload.tool_response !== undefined,
    response_source: readModelResponse(payload)
      ? readModelResponseSource(payload)
      : undefined,
  };
}

function conversationFields(payload) {
  return {
    session_id: readString(payload.session_id),
    conversation_id: readString(payload.conversation_id),
    workspace_path: readString(payload.workspace_path),
    user_input: readUserInput(payload),
    model_response: readModelResponse(payload),
    hook_event_name: readString(payload.hook_event_name),
    omniwork_hook_event: readString(payload.omniwork_hook_event),
    event: readString(payload.event),
    event_name: readString(payload.event_name),
    omniwork_hook_source: readString(payload.omniwork_hook_source),
    omniwork_record_id: readString(payload.omniwork_record_id),
  };
}

function readModelResponseSource(payload) {
  if (readString(payload.last_assistant_message)) {
    return "last_assistant_message";
  }
  if (readString(payload.assistant_response)) {
    return "assistant_response";
  }
  if (readString(payload.model_response)) {
    return "model_response";
  }
  if (readString(payload.response)) {
    return "response";
  }
  if (readString(payload.output)) {
    return "output";
  }
  return undefined;
}

function cloneJsonObject(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function resolveTraeRecordPath(root, createdAt) {
  return join(root, "sessions", `${createdAt.slice(0, 10)}.jsonl`);
}

function resolveTraeRecordsRoots(provider) {
  const override = process.env.OMNIWORK_TRAE_RECORDS_DIR?.trim();
  if (override) {
    return [override];
  }
  return [providerRecordsRoot(provider)];
}

function isIgnoredHookEvent(hookEvent) {
  return (
    hookEvent === "PreToolUse" ||
    hookEvent === "pre_tool_use" ||
    hookEvent === "PostToolUse" ||
    hookEvent === "post_tool_use" ||
    hookEvent === "Notification" ||
    hookEvent === "notification"
  );
}

function providerRecordsRoot(provider) {
  return join(
    homedir(),
    provider === "trae-cn" ? ".trae-cn" : ".trae",
    "omniwork",
    "records",
  );
}

function fallbackRecordsRoot(provider) {
  return join(homedir(), ".local", "share", "OmniWork", provider, "records");
}

async function installTraeRecordHooks() {
  const provider = resolveInstallProvider();
  const targets = await discoverTraeHookTargets(provider);
  for (const target of targets) {
    await ensureTraeRecordHooksInstalled(target);
  }
}

function resolveInstallProvider() {
  const configured =
    process.env.OMNIWORK_AGENT_HOOK_SOURCE?.trim() ??
    process.env.OMNIWORK_TRAE_HOOK_SOURCE?.trim();
  if (configured) {
    return normalizeTraeProvider(configured);
  }
  return pathExistsSync(join(homedir(), ".trae-cn")) ? "trae-cn" : "trae";
}

async function discoverTraeHookTargets(provider) {
  const candidates = [
    {
      provider: "trae",
      hooksPath: defaultTraeHooksPath("trae"),
    },
    {
      provider: "trae-cn",
      hooksPath: defaultTraeHooksPath("trae-cn"),
    },
  ];
  const existingTargets = [];
  for (const candidate of candidates) {
    if (await pathExists(dirname(candidate.hooksPath))) {
      existingTargets.push(candidate);
    }
  }
  const targets =
    existingTargets.length > 0
      ? existingTargets
      : [{ provider, hooksPath: defaultTraeHooksPath(provider) }];
  return targets;
}

async function ensureTraeRecordHooksInstalled(target) {
  const existing = await readHooksFile(target.hooksPath);
  if (existing === null) {
    return;
  }
  const hooks = isRecord(existing.hooks) ? existing.hooks : {};
  let changed = false;
  for (const eventName of DEPRECATED_RECORD_HOOK_EVENTS) {
    const currentGroups = Array.isArray(hooks[eventName])
      ? hooks[eventName]
      : [];
    const cleanup = cleanupOmniWorkHookCommands(currentGroups);
    if (!cleanup.changed) {
      continue;
    }
    changed = true;
    if (cleanup.groups.length > 0) {
      hooks[eventName] = cleanup.groups;
    } else {
      delete hooks[eventName];
    }
  }
  for (const event of MANAGED_TRAE_HOOK_EVENTS) {
    const currentGroups = Array.isArray(hooks[event.name])
      ? hooks[event.name]
      : [];
    const cleanup = cleanupLegacyOmniWorkAgentHookCommands(currentGroups);
    if (!cleanup.changed) {
      continue;
    }
    changed = true;
    if (cleanup.groups.length > 0) {
      hooks[event.name] = cleanup.groups;
    } else {
      delete hooks[event.name];
    }
  }
  for (const event of MANAGED_TRAE_HOOK_EVENTS) {
    const currentGroups = Array.isArray(hooks[event.name])
      ? hooks[event.name]
      : [];
    const group = createHookGroup(event, target.provider);
    const command = group.hooks[0]?.command;
    const cleanup = cleanupManagedCommands(currentGroups, command);
    if (cleanup.changed) {
      changed = true;
    }
    if (!hasHookCommand(cleanup.groups, command)) {
      hooks[event.name] = [...cleanup.groups, group];
      changed = true;
    } else if (cleanup.changed) {
      hooks[event.name] = cleanup.groups;
    }
  }
  if (!changed) {
    return;
  }
  await mkdir(dirname(target.hooksPath), { recursive: true, mode: 0o700 });
  await writeFile(
    target.hooksPath,
    `${JSON.stringify({ ...existing, version: existing.version ?? 1, hooks }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function createHookGroup(event, provider) {
  return {
    ...(event.matcher ? { matcher: event.matcher } : {}),
    hooks: [
      {
        type: "command",
        command: buildHookCommand(provider, event.name),
        timeout: 10,
      },
    ],
  };
}

function buildHookCommand(provider, eventName) {
  const env = [
    ["OMNIWORK_AGENT_HOOK_SOURCE", provider],
    ["OMNIWORK_AGENT_HOOK_EVENT", eventName],
  ]
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  return `${env} node ${shellQuote(fileURLToPath(import.meta.url))}`;
}

async function readHooksFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {};
    }
    return null;
  }
}

function hasHookCommand(groups, command) {
  return groups.some((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return false;
    }
    return group.hooks.some(
      (hook) =>
        isRecord(hook) && hook.type === "command" && hook.command === command,
    );
  });
}

function cleanupManagedCommands(groups, validCommand) {
  let changed = false;
  let keptValidCommand = false;
  const cleanedGroups = groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return [group];
    }
    const nextHooks = group.hooks.filter((hook) => {
      if (!isRecord(hook) || hook.type !== "command") {
        return true;
      }
      const command = typeof hook.command === "string" ? hook.command : "";
      if (!isManagedRecordHookCommand(command)) {
        return true;
      }
      const keep = command === validCommand && !keptValidCommand;
      if (keep) {
        keptValidCommand = true;
      }
      if (!keep) {
        changed = true;
      }
      return keep;
    });
    if (nextHooks.length === group.hooks.length) {
      return [group];
    }
    if (nextHooks.length === 0) {
      changed = true;
      return [];
    }
    return [{ ...group, hooks: nextHooks }];
  });
  return { groups: cleanedGroups, changed };
}

function cleanupLegacyOmniWorkAgentHookCommands(groups) {
  let changed = false;
  const cleanedGroups = groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return [group];
    }
    const nextHooks = group.hooks.filter((hook) => {
      if (!isRecord(hook) || hook.type !== "command") {
        return true;
      }
      const command = typeof hook.command === "string" ? hook.command : "";
      if (!command.includes("omniwork-agent-hook")) {
        return true;
      }
      changed = true;
      return false;
    });
    if (nextHooks.length === group.hooks.length) {
      return [group];
    }
    if (nextHooks.length === 0) {
      changed = true;
      return [];
    }
    return [{ ...group, hooks: nextHooks }];
  });
  return { groups: cleanedGroups, changed };
}

function cleanupOmniWorkHookCommands(groups) {
  let changed = false;
  const cleanedGroups = groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return [group];
    }
    const nextHooks = group.hooks.filter((hook) => {
      if (!isRecord(hook) || hook.type !== "command") {
        return true;
      }
      const command = typeof hook.command === "string" ? hook.command : "";
      if (!isOmniWorkHookCommand(command)) {
        return true;
      }
      changed = true;
      return false;
    });
    if (nextHooks.length === group.hooks.length) {
      return [group];
    }
    if (nextHooks.length === 0) {
      changed = true;
      return [];
    }
    return [{ ...group, hooks: nextHooks }];
  });
  return { groups: cleanedGroups, changed };
}

function isManagedRecordHookCommand(command) {
  return (
    command.includes("omniwork-hook-record") ||
    command.includes("omniwork-agent-hook")
  );
}

function isOmniWorkHookCommand(command) {
  return (
    command.includes("omniwork-hook-record") ||
    command.includes("omniwork-hook-post") ||
    command.includes("omniwork-agent-hook")
  );
}

function defaultTraeHooksPath(provider) {
  return join(
    homedir(),
    provider === "trae-cn" ? ".trae-cn" : ".trae",
    "hooks.json",
  );
}

async function pathExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function pathExistsSync(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function createRecordId(provider, payload) {
  const stable = JSON.stringify({
    provider: normalizeTraeProvider(provider),
    hookEvent: readHookEvent(payload),
    sessionId:
      readString(payload.session_id) ?? readString(payload.conversation_id),
    workspacePath:
      readString(payload.workspace_path) ?? readString(payload.cwd),
    toolUseId: readString(payload.tool_use_id),
    toolName:
      readString(payload.tool_name) ?? readString(payload.llm_tool_name),
    notificationType: readString(payload.notification_type),
    source: readString(payload.source),
    reason: readString(payload.reason),
    createdAt: new Date().toISOString(),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function readHookEvent(payload) {
  return (
    readString(payload.hook_event_name) ??
    readString(payload.omniwork_hook_event) ??
    readString(payload.event_name) ??
    readString(payload.event)
  );
}

function isTraeProvider(provider) {
  return typeof provider === "string" && TRAE_PROVIDERS.has(provider);
}

function normalizeTraeProvider(provider) {
  return provider === "trae-cn" ||
    provider === "trae_cn" ||
    provider === "traecn"
    ? "trae-cn"
    : "trae";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readUserInput(payload) {
  return (
    readString(payload.prompt) ??
    readString(payload.input) ??
    readString(payload.user_input) ??
    readString(payload.user_message) ??
    readString(payload.message)
  );
}

function readModelResponse(payload) {
  return (
    readString(payload.last_assistant_message) ??
    readString(payload.assistant_response) ??
    readString(payload.model_response) ??
    readString(payload.response) ??
    readString(payload.output)
  );
}

function readString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

main().catch(() => {
  process.exitCode = 0;
});
