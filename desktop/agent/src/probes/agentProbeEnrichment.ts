import type { AgentProbeEvent, TerminalSession } from "@omniwork/protocol-ts";

export function enrichProbeEventWithSessions(
  event: AgentProbeEvent,
  sessions: readonly TerminalSession[],
): AgentProbeEvent {
  const session = findBestSession(event, sessions);
  if (!session) {
    return event;
  }

  const surface =
    session.surfaces.find((item) => item.surface_id === event.surface_id) ??
    session.surfaces.find(
      (item) => item.surface_id === session.primary_surface_id,
    ) ??
    session.surfaces[0];

  const providerSessionId =
    event.session_id === session.session_id ? undefined : event.session_id;

  return {
    ...event,
    session_id: session.session_id,
    surface_id: event.surface_id ?? surface?.surface_id,
    workspace_path:
      event.workspace_path ?? session.workspace_path ?? session.cwd,
    payload: providerSessionId
      ? {
          ...event.payload,
          provider_session_id: providerSessionId,
        }
      : event.payload,
  };
}

function findBestSession(
  event: AgentProbeEvent,
  sessions: readonly TerminalSession[],
): TerminalSession | undefined {
  if (event.surface_id) {
    const bySurface = sessions.find((session) =>
      session.surfaces.some(
        (surface) => surface.surface_id === event.surface_id,
      ),
    );
    if (bySurface) {
      return bySurface;
    }
  }

  const bySession = sessions.find(
    (session) => session.session_id === event.session_id,
  );
  if (bySession) {
    return bySession;
  }

  const providerKind = toTerminalProviderKind(event.provider);
  const candidates = sessions
    .filter((session) => {
      const providerMatches =
        session.terminal_provider_kind === event.provider ||
        session.surfaces.some(
          (surface) => surface.provider === event.provider,
        ) ||
        Boolean(
          providerKind &&
          (session.terminal_provider_kind === providerKind ||
            session.surfaces.some(
              (surface) => surface.provider === providerKind,
            )),
        );
      const workspaceMatches =
        !event.workspace_path ||
        session.workspace_path === event.workspace_path ||
        session.cwd === event.workspace_path;
      return providerMatches && workspaceMatches;
    })
    .sort((left, right) => {
      return Date.parse(right.last_active_at) - Date.parse(left.last_active_at);
    });

  return candidates[0];
}

function toTerminalProviderKind(provider: string): string | undefined {
  switch (provider) {
    case "codex":
      return "codex";
    case "claude-code":
      return "claude";
    case "gemini":
      return "gemini";
    case "opencode":
      return "opencode";
    default:
      return undefined;
  }
}
