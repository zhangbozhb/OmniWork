import type {
  TerminalProviderDefinition,
  TerminalProviderKind,
  TerminalSession,
  WorkspaceDefinition,
} from "@omni-work/protocol-ts";
import { getTerminalProviderDefinition } from "@omni-work/protocol-ts";

import { colors } from "../../ui/theme.ts";
import type {
  TerminalProviderGroup,
  WorkspaceTab,
} from "./workbenchTypes.ts";

export const UNASSIGNED_WORKSPACE_PATH = "__unassigned__";

type WorkbenchTranslate = (key: string, options?: Record<string, unknown>) => string;

function defaultTranslate(key: string): string {
  switch (key) {
    case "common.unknown":
      return "unknown";
    case "workspaces.fallback.otherWorkspace":
      return "Other Workspace";
    case "workspaces.fallback.workspace":
      return "Workspace";
    default:
      return key;
  }
}

export function formatRelativeTime(
  value: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return t("common.unknown");
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return t("workspaces.time.justNow");
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return t("workspaces.time.minutesAgo", { count: diffMinutes });
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return t("workspaces.time.hoursAgo", { count: diffHours });
  }

  const diffDays = Math.floor(diffHours / 24);
  return t("workspaces.time.daysAgo", { count: diffDays });
}

export function formatAbsoluteTime(
  value: string,
  t: WorkbenchTranslate = defaultTranslate,
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return t("common.unknown");
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatCompactPath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return "";
  }

  const normalizedPath = trimmedPath.replace(/\/+$/g, "") || "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalizedPath;
  }

  const prefix = normalizedPath.startsWith("/") ? `/${parts[0]}` : parts[0];
  return `${prefix}/.../${parts[parts.length - 1]}`;
}

export function getProviderGroupKind(
  session: TerminalSession,
  providers: readonly TerminalProviderDefinition[],
): TerminalProviderKind {
  return getTerminalProviderDefinition(
    session.terminal_provider_kind,
    providers,
  )
    ? session.terminal_provider_kind
    : "other";
}

export function groupSessionsByWorkspace(
  sessions: readonly TerminalSession[],
  workspaces: readonly WorkspaceDefinition[],
  t: WorkbenchTranslate = defaultTranslate,
): Array<{ workspace: WorkspaceDefinition; sessions: TerminalSession[] }> {
  const groups = new Map<
    string,
    { workspace: WorkspaceDefinition; sessions: TerminalSession[] }
  >();
  for (const session of sessions) {
    const workspace = findSessionWorkspace(session, workspaces, t);
    const existing = groups.get(workspace.path);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(workspace.path, { workspace, sessions: [session] });
    }
  }
  return Array.from(groups.values()).sort((left, right) =>
    getWorkspaceDisplayName(left.workspace, t).localeCompare(
      getWorkspaceDisplayName(right.workspace, t),
    ),
  );
}

export function groupSessionsByProvider(
  sessions: readonly TerminalSession[],
  providerGroups: readonly TerminalProviderGroup[],
  providers: readonly TerminalProviderDefinition[],
): Array<TerminalProviderGroup & { sessions: TerminalSession[] }> {
  return providerGroups
    .filter((group) => !group.hidden)
    .map((group) => ({
      ...group,
      sessions: sessions.filter(
        (session) => getProviderGroupKind(session, providers) === group.kind,
      ),
    }))
    .filter((group) => group.sessions.length > 0);
}

export function findSessionWorkspace(
  session: TerminalSession,
  workspaces: readonly WorkspaceDefinition[],
  t: WorkbenchTranslate = defaultTranslate,
): WorkspaceDefinition {
  if (session.workspace_path) {
    const exact = workspaces.find(
      (workspace) => workspace.path === session.workspace_path,
    );
    if (exact) {
      return exact;
    }
  }
  const matched = workspaces
    .filter((workspace) => isPathInside(session.cwd, workspace.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (matched) {
    return matched;
  }
  return {
    name:
      session.workspace_name ?? t("workspaces.fallback.otherWorkspace"),
    path: UNASSIGNED_WORKSPACE_PATH,
    isGitRepository: Boolean(session.git_repository),
    status: "available",
    source: "session",
  };
}

export function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = path.replace(/\/+$/g, "");
  const normalizedParent = parent.replace(/\/+$/g, "");
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}

export function getWorkspaceTabs(workspace: WorkspaceDefinition): WorkspaceTab[] {
  return workspace.isGitRepository
    ? ["sessions", "git", "files"]
    : ["sessions", "files"];
}

export function getWorkspaceDisplayName(
  workspace: WorkspaceDefinition,
  t: WorkbenchTranslate = defaultTranslate,
): string {
  return workspace.name?.trim() || basename(workspace.path, t);
}

export function basename(
  path: string,
  t: WorkbenchTranslate = defaultTranslate,
): string {
  const normalized = path.replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? t("workspaces.fallback.workspace");
}

export function getCloseActionLabel(
  session: TerminalSession,
  t: (key: string) => string,
): string {
  if (session.status === "exited" || session.status === "archived") {
    return t("workspaces.actions.remove");
  }

  return t("workspaces.actions.closeSession");
}

export function getStatusColors(tone: "success" | "warning" | "danger" | "neutral"): {
  backgroundColor: string;
  color: string;
} {
  switch (tone) {
    case "success":
      return {
        backgroundColor: colors.successSoft,
        color: "#d7ffe9",
      };
    case "warning":
      return {
        backgroundColor: colors.warningSoft,
        color: colors.warning,
      };
    case "danger":
      return {
        backgroundColor: colors.dangerSoft,
        color: colors.danger,
      };
    case "neutral":
    default:
      return {
        backgroundColor: colors.neutralSoft,
        color: colors.textMuted,
      };
  }
}
