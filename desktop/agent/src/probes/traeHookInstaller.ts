import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TraeHookInstallProvider = "trae" | "trae-cn";

interface TraeHookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

interface TraeHookGroup {
  matcher?: string;
  hooks: TraeHookCommand[];
}

interface TraeHooksFile {
  version?: unknown;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ManagedTraeHookEvent {
  name: string;
  matcher?: string;
}

export interface TraeHookInstallOptions {
  hooksPath?: string;
  receiverUrl?: string;
  sessionKeyPath?: string;
  provider?: TraeHookInstallProvider;
}

export interface TraeHookInstallTarget {
  provider: TraeHookInstallProvider;
  hooksPath: string;
}

export interface TraeFamilyHookInstallOptions {
  receiverUrl?: string;
  sessionKeyPath?: string;
  provider?: TraeHookInstallProvider;
  homeDir?: string;
  targets?: TraeHookInstallTarget[];
}

export interface TraeHookInstallResult {
  provider: TraeHookInstallProvider;
  hooksPath: string;
  installed: boolean;
  changed: boolean;
  reason?: "invalid_json" | "invalid_hooks_shape";
}

const MANAGED_TRAE_HOOK_EVENTS: ManagedTraeHookEvent[] = [
  {
    name: "SessionStart",
  },
  {
    name: "UserPromptSubmit",
  },
  {
    name: "PreToolUse",
    matcher: "*",
  },
  {
    name: "PostToolUse",
    matcher: "*",
  },
  {
    name: "Notification",
  },
  {
    name: "Stop",
  },
];

const DEPRECATED_TRAE_HOOK_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "PermissionDenied",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
];

export async function ensureTraeFamilyHooksInstalled(
  options: TraeFamilyHookInstallOptions = {},
): Promise<TraeHookInstallResult[]> {
  const targets = options.targets ?? (await discoverTraeHookTargets(options));
  return Promise.all(
    targets.map((target) =>
      ensureTraeHooksInstalled({
        hooksPath: target.hooksPath,
        provider: target.provider,
        receiverUrl: options.receiverUrl,
        sessionKeyPath: options.sessionKeyPath,
      }),
    ),
  );
}

export async function ensureTraeHooksInstalled(
  options: TraeHookInstallOptions = {},
): Promise<TraeHookInstallResult> {
  const provider = options.provider ?? "trae";
  const hooksPath = options.hooksPath ?? defaultTraeHooksPath(provider);
  const omniworkHooks = createOmniWorkHooks(options, provider);
  const existing = await readHooksFile(hooksPath);
  if (existing === null) {
    return {
      provider,
      hooksPath,
      installed: false,
      changed: false,
      reason: "invalid_json",
    };
  }

  const hooks = existing.hooks ?? {};
  if (!isRecord(hooks)) {
    return {
      provider,
      hooksPath,
      installed: false,
      changed: false,
      reason: "invalid_hooks_shape",
    };
  }

  let changed = false;
    for (const eventName of DEPRECATED_TRAE_HOOK_EVENTS) {
      const currentGroups = Array.isArray(hooks[eventName])
        ? (hooks[eventName] as unknown[])
        : [];
      if (currentGroups.length === 0) {
        continue;
      }
      const cleanup = cleanupOmniWorkHookCommands(currentGroups, "");
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
      `${JSON.stringify({ ...existing, version: existing.version ?? 1, hooks }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  }

  return {
    provider,
    hooksPath,
    installed: true,
    changed,
  };
}

export function defaultTraeHooksPath(
  provider: TraeHookInstallProvider = "trae",
  homeDirectory = homedir(),
): string {
  return join(
    homeDirectory,
    provider === "trae-cn" ? ".trae-cn" : ".trae",
    "hooks.json",
  );
}

export async function discoverTraeHookTargets(
  options: Pick<TraeFamilyHookInstallOptions, "homeDir" | "provider"> = {},
): Promise<TraeHookInstallTarget[]> {
  const candidates: TraeHookInstallTarget[] = [
    {
      provider: "trae",
      hooksPath: defaultTraeHooksPath("trae", options.homeDir),
    },
    {
      provider: "trae-cn",
      hooksPath: defaultTraeHooksPath("trae-cn", options.homeDir),
    },
  ];
  const existingTargets: TraeHookInstallTarget[] = [];
  for (const candidate of candidates) {
    if (await pathExists(dirname(candidate.hooksPath))) {
      existingTargets.push(candidate);
    }
  }
  if (existingTargets.length > 0) {
    return existingTargets;
  }
  const provider = options.provider ?? "trae";
  return [
    {
      provider,
      hooksPath: defaultTraeHooksPath(provider, options.homeDir),
    },
  ];
}

function defaultHookScriptPath(): string {
  return fileURLToPath(
    new URL("../../bin/omniwork-agent-hook.mjs", import.meta.url),
  );
}

function buildHookCommand(
  options: TraeHookInstallOptions,
  provider: TraeHookInstallProvider,
): string {
  const env = [
    ["OMNIWORK_AGENT_PROBE_URL", options.receiverUrl],
    ["OMNIWORK_SESSION_KEY_PATH", options.sessionKeyPath],
    ["OMNIWORK_AGENT_HOOK_SOURCE", provider],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const command = `node ${shellQuote(defaultHookScriptPath())}`;
  return env ? `${env} ${command}` : command;
}

function createOmniWorkHooks(
  options: TraeHookInstallOptions,
  provider: TraeHookInstallProvider,
): Array<[string, TraeHookGroup]> {
  const command = buildHookCommand(options, provider);
  return MANAGED_TRAE_HOOK_EVENTS.map((event) => [
    event.name,
    {
      ...(event.matcher ? { matcher: event.matcher } : {}),
      hooks: [
        {
          type: "command",
          command,
          timeout: 10,
        },
      ],
    },
  ]);
}

async function readHooksFile(path: string): Promise<TraeHooksFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as TraeHooksFile) : null;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
