import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CodexHookCommand {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookCommand[];
}

interface CodexHooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ManagedCodexHookEvent {
  name: string;
  matcher?: string;
  statusMessage?: string;
}

const MANAGED_CODEX_HOOK_EVENTS: ManagedCodexHookEvent[] = [
  {
    name: "SessionStart",
    matcher: "startup|resume|clear|compact",
    statusMessage: "OmniWork collecting Codex session event",
  },
  {
    name: "PermissionRequest",
    matcher: "*",
  },
  {
    name: "PostToolUse",
    matcher: "*",
  },
  {
    name: "Stop",
  },
];

export interface CodexHookInstallOptions {
  hooksPath?: string;
  receiverUrl?: string;
  sessionKeyPath?: string;
}

export interface CodexHookInstallResult {
  hooksPath: string;
  installed: boolean;
  changed: boolean;
  reason?: "invalid_json" | "invalid_hooks_shape";
}

export async function ensureCodexHooksInstalled(
  options: CodexHookInstallOptions = {},
): Promise<CodexHookInstallResult> {
  const hooksPath = options.hooksPath ?? defaultCodexHooksPath();
  const omniworkHooks = createOmniWorkHooks(options);
  const existing = await readHooksFile(hooksPath);
  if (existing === null) {
    return {
      hooksPath,
      installed: false,
      changed: false,
      reason: "invalid_json",
    };
  }

  const hooks = existing.hooks ?? {};
  if (!isRecord(hooks)) {
    return {
      hooksPath,
      installed: false,
      changed: false,
      reason: "invalid_hooks_shape",
    };
  }

  let changed = false;
  for (const [eventName, group] of omniworkHooks) {
    const currentGroups = Array.isArray(hooks[eventName])
      ? (hooks[eventName] as unknown[])
      : [];
    const hookCommand = group.hooks[0]?.command;
    if (!hookCommand) {
      continue;
    }
    const cleanup = cleanupOmniWorkHookCommands(currentGroups, hookCommand);
    if (cleanup.changed) {
      changed = true;
    }
    if (!hasHookCommand(cleanup.groups, hookCommand)) {
      hooks[eventName] = [...cleanup.groups, group];
      changed = true;
    } else if (cleanup.changed) {
      hooks[eventName] = cleanup.groups;
    }
  }

  if (changed) {
    await mkdir(dirname(hooksPath), { recursive: true, mode: 0o700 });
    await writeFile(
      hooksPath,
      `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  }

  return {
    hooksPath,
    installed: true,
    changed,
  };
}

export function defaultCodexHooksPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

function defaultHookScriptPath(): string {
  return fileURLToPath(
    new URL("../../bin/omniwork-agent-hook.mjs", import.meta.url),
  );
}

function buildHookCommand(
  options: CodexHookInstallOptions,
  hookEventName: string,
): string {
  const env = [
    ["OMNIWORK_AGENT_PROBE_URL", options.receiverUrl],
    ["OMNIWORK_SESSION_KEY_PATH", options.sessionKeyPath],
    ["OMNIWORK_AGENT_HOOK_SOURCE", "codex"],
    ["OMNIWORK_AGENT_HOOK_EVENT", hookEventName],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const command = `node ${shellQuote(defaultHookScriptPath())}`;
  return env ? `${env} ${command}` : command;
}

function createOmniWorkHooks(
  options: CodexHookInstallOptions,
): Array<[string, CodexHookGroup]> {
  return MANAGED_CODEX_HOOK_EVENTS.map((event) => [
    event.name,
    {
      ...(event.matcher ? { matcher: event.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: buildHookCommand(options, event.name),
          timeout: 10,
          ...(event.statusMessage
            ? { statusMessage: event.statusMessage }
            : {}),
        },
      ],
    },
  ]);
}

async function readHooksFile(path: string): Promise<CodexHooksFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as CodexHooksFile) : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    return null;
  }
}

function hasHookCommand(groups: unknown[], command: string): boolean {
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

function cleanupOmniWorkHookCommands(
  groups: unknown[],
  validCommand: string,
): { groups: unknown[]; changed: boolean } {
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
      const keep = command === validCommand;
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

  return {
    groups: cleanedGroups,
    changed,
  };
}

function isOmniWorkHookCommand(command: string): boolean {
  return command.includes("omniwork-agent-hook");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
