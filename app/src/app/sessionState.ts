import type { TerminalSession } from "@omniwork/protocol-ts";

export function upsertSession(
  sessions: TerminalSession[],
  nextSession: TerminalSession,
): TerminalSession[] {
  const index = sessions.findIndex(
    (session) => session.session_id === nextSession.session_id,
  );
  if (index < 0) {
    return [nextSession, ...sessions];
  }

  const nextSessions = [...sessions];
  nextSessions[index] = nextSession;
  return nextSessions;
}

export function isTransitionalSessionStatus(
  status: TerminalSession["status"],
): boolean {
  return status === "created" || status === "starting";
}
