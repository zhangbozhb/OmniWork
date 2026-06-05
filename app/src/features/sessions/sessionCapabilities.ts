import type {
  CodexSession,
  SessionStatus,
} from "@omniwork/protocol-ts";

export interface SessionPendingState {
  closing?: boolean;
  killing?: boolean;
}

export interface SessionCapabilities {
  canOpen: boolean;
  canInput: boolean;
  canResize: boolean;
  canClose: boolean;
  canKill: boolean;
  interactive: boolean;
  pending: boolean;
  primaryActionLabel: string;
  statusLabel: string;
  statusTone: "success" | "warning" | "danger" | "neutral";
  unavailableReason?: string;
}

export function getSessionCapabilities(
  session: CodexSession,
  pending: SessionPendingState = {},
): SessionCapabilities {
  const external = session.origin === "external";
  const registered = session.registered !== false;
  const pendingAction = Boolean(pending.closing || pending.killing);
  const status = session.status;
  const attachableExternal = external && !registered;
  const operational = status === "running" || status === "detached";
  const unavailableReason = getUnavailableReason(session, pending);

  return {
    canOpen: !pendingAction && (operational || attachableExternal),
    canInput: !pendingAction && registered && status === "running",
    canResize: !pendingAction && registered && status === "running",
    canClose: !pendingAction && registered && status !== "archived",
    canKill:
      !pendingAction && status !== "archived" && status !== "exited",
    interactive: !pendingAction && registered && status === "running",
    pending: pendingAction,
    primaryActionLabel: getPrimaryActionLabel(session, pending),
    statusLabel: getStatusLabel(session),
    statusTone: getStatusTone(status, attachableExternal),
    unavailableReason,
  };
}

function getPrimaryActionLabel(
  session: CodexSession,
  pending: SessionPendingState,
): string {
  if (pending.killing) {
    return "Killing...";
  }
  if (pending.closing) {
    return session.origin === "external" ? "Forgetting..." : "Closing...";
  }
  if (session.origin === "external" && session.registered === false) {
    return "Attach";
  }

  switch (session.status) {
    case "running":
    case "detached":
      return "Open";
    case "created":
    case "starting":
      return "Starting...";
    case "exited":
      return "Exited";
    case "archived":
      return "Archived";
    default:
      return "Open";
  }
}

function getStatusLabel(session: CodexSession): string {
  if (session.origin === "external" && session.registered === false) {
    return "Attachable tmux";
  }

  switch (session.status) {
    case "created":
      return "Created";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "detached":
      return "Detached";
    case "exited":
      return "Exited";
    case "archived":
      return "Archived";
    default:
      return session.status;
  }
}

function getStatusTone(
  status: SessionStatus,
  attachableExternal: boolean,
): SessionCapabilities["statusTone"] {
  if (attachableExternal) {
    return "warning";
  }

  switch (status) {
    case "running":
      return "success";
    case "created":
    case "starting":
    case "detached":
      return "warning";
    case "exited":
      return "danger";
    case "archived":
    default:
      return "neutral";
  }
}

function getUnavailableReason(
  session: CodexSession,
  pending: SessionPendingState,
): string | undefined {
  if (pending.killing) {
    return "Killing the tmux session on the Mac.";
  }
  if (pending.closing) {
    return session.origin === "external"
      ? "Forgetting the tmux session from OmniWork."
      : "Closing the session on the Mac Agent.";
  }

  switch (session.status) {
    case "created":
    case "starting":
      return "The session is still starting. Refresh if it takes too long.";
    case "exited":
      return "This session has exited and is no longer interactive.";
    case "archived":
      return "This session is archived and read-only.";
    default:
      return undefined;
  }
}
