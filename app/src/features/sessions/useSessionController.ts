import { useEffect, useRef, useState } from "react";
import type {
  MessageEnvelope,
  SessionListPayload,
  TerminalProviderDefinition,
  TerminalProviderKind,
  TerminalResizePayload,
  TerminalSession,
  WorkspaceDefinition,
  WorkspaceListPayload,
} from "@omniwork/protocol-ts";
import {
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
} from "@omniwork/protocol-ts";

import type { AppView, ConnectionStatus } from "../../app/appTypes";
import {
  isTransitionalSessionStatus,
  upsertSession,
} from "../../app/sessionState";
import type { ConfirmOptions } from "../../ui/confirm/ConfirmProvider";
import type { PairingConfig } from "../auth/types";
import {
  closeSessionRequest,
  createSessionRequest,
  killTerminalSessionRequest,
  listSessionsRequest,
  renameSessionRequest,
} from "./sessionMessages";
import { getSessionCapabilities } from "./sessionCapabilities";
import {
  computeInitialTerminalSize,
  type TerminalTextSize,
} from "../terminal/terminalLayout";

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

type CreateSessionInput = {
  cwd: string;
  terminalProviderKind: TerminalProviderKind;
  workspacePath?: string;
};

type UseSessionControllerOptions = {
  pairing: PairingConfig | null;
  connectionStatus: ConnectionStatus;
  terminalTextSize: TerminalTextSize;
  confirm: Confirm;
  setView(view: AppView): void;
  setConnectionMessage(message: string): void;
  reconnectActivePairing(): void;
  sendToRelay(message: MessageEnvelope): void;
  onSessionWorkspaces(workspaces: readonly WorkspaceDefinition[]): void;
};

type ClearSessionOptions = {
  clearDefaultCwd?: boolean;
  clearCreating?: boolean;
};

export function fallbackTerminalProviders(): TerminalProviderDefinition[] {
  return DEFAULT_TERMINAL_PROVIDER_DEFINITIONS.filter(
    (provider) => provider.kind === "terminal",
  );
}

export function useSessionController({
  pairing,
  connectionStatus,
  terminalTextSize,
  confirm,
  setView,
  setConnectionMessage,
  reconnectActivePairing,
  sendToRelay,
  onSessionWorkspaces,
}: UseSessionControllerOptions) {
  const [selectedSession, setSelectedSession] =
    useState<TerminalSession | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [terminalProviders, setTerminalProviders] = useState<
    TerminalProviderDefinition[]
  >(fallbackTerminalProviders);
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [defaultSessionCwd, setDefaultSessionCwd] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [closingSessionIds, setClosingSessionIds] = useState<string[]>([]);
  const [killingSessionIds, setKillingSessionIds] = useState<string[]>([]);
  const pendingCreateRef = useRef(false);
  const selectedSessionRef = useRef<TerminalSession | null>(null);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  const selectedSessionCapabilities = selectedSession
    ? getSessionCapabilities(selectedSession, {
        closing: closingSessionIds.includes(selectedSession.session_id),
        killing: killingSessionIds.includes(selectedSession.session_id),
      })
    : null;

  function clearSessionState(options: ClearSessionOptions = {}): void {
    pendingCreateRef.current = false;
    setSessions([]);
    setTerminalProviders(fallbackTerminalProviders);
    setWorkspaces([]);
    setSelectedSession(null);
    setClosingSessionIds([]);
    setKillingSessionIds([]);
    if (options.clearCreating) {
      setCreatingSession(false);
    }
    if (options.clearDefaultCwd) {
      setDefaultSessionCwd("");
    }
  }

  function resetSessionProgress(): void {
    pendingCreateRef.current = false;
    setCreatingSession(false);
    setClosingSessionIds([]);
    setKillingSessionIds([]);
  }

  function requestSessionListRefresh(): void {
    if (pairing && connectionStatus === "authenticated") {
      sendToRelay(listSessionsRequest(pairing.deviceId));
    }
  }

  function handleRefreshSessions(): void {
    if (!pairing) {
      return;
    }
    if (connectionStatus !== "authenticated") {
      reconnectActivePairing();
      return;
    }
    sendToRelay(listSessionsRequest(pairing.deviceId));
  }

  function handleCreateSession(input: CreateSessionInput): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    pendingCreateRef.current = true;
    setCreatingSession(true);
    sendToRelay(
      createSessionRequest(pairing.deviceId, {
        cwd: input.cwd,
        workspace_path: input.workspacePath,
        terminal_provider_kind: input.terminalProviderKind,
        terminal_size: computeInitialTerminalSize(terminalTextSize),
      }),
    );
  }

  async function handleCloseSession(session: TerminalSession): Promise<void> {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const external = session.origin === "external";
    const removeOnly =
      session.status === "exited" || session.status === "archived";
    const title = external
      ? "Forget tmux session"
      : removeOnly
        ? "Remove session"
        : "Close session";
    const message = external
      ? `Forget ${session.title} in OmniWork? The tmux session will keep running on the connected computer.`
      : removeOnly
        ? `Remove ${session.title} from OmniWork? The session is not interactive.`
        : `Close ${session.title} on the connected computer?`;
    const confirmed = await confirm({
      title,
      message,
      confirmText: external ? "Forget" : removeOnly ? "Remove" : "Close",
    });
    if (!confirmed) {
      return;
    }

    setClosingSessionIds((current) =>
      current.includes(session.session_id)
        ? current
        : [...current, session.session_id],
    );
    sendToRelay(closeSessionRequest(pairing.deviceId, session.session_id));
  }

  function handleRenameSession(session: TerminalSession, title: string): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === session.title) {
      return;
    }

    setSessions((current) =>
      current.map((item) =>
        item.session_id === session.session_id
          ? { ...item, title: nextTitle }
          : item,
      ),
    );
    setSelectedSession((current) =>
      current?.session_id === session.session_id
        ? { ...current, title: nextTitle }
        : current,
    );
    sendToRelay(
      renameSessionRequest(pairing.deviceId, session.session_id, nextTitle),
    );
  }

  async function handleKillTerminalSession(
    session: TerminalSession,
  ): Promise<void> {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const confirmed = await confirm({
      title: "Kill tmux session",
      message: `Really kill ${session.title}? This will close the tmux session on the connected computer and cannot be undone.`,
      confirmText: "Kill tmux",
    });
    if (!confirmed) {
      return;
    }

    setKillingSessionIds((current) =>
      current.includes(session.session_id)
        ? current
        : [...current, session.session_id],
    );
    sendToRelay(
      killTerminalSessionRequest(pairing.deviceId, session.session_id),
    );
  }

  function applySessionList(payload: SessionListPayload): Set<string> {
    const remoteSessionIds = new Set(
      payload.sessions.map((session) => session.session_id),
    );
    const remoteSurfaceIds = new Set(
      payload.sessions.flatMap((session) =>
        session.surfaces.map((surface) => surface.surface_id),
      ),
    );
    const closableSessionIds = new Set(
      payload.sessions
        .filter((session) => session.registered !== false)
        .map((session) => session.session_id),
    );
    if (payload.default_cwd) {
      setDefaultSessionCwd(payload.default_cwd);
    }
    setTerminalProviders(
      payload.providers?.length
        ? payload.providers
        : fallbackTerminalProviders(),
    );
    if (payload.workspaces?.length) {
      setWorkspaces(payload.workspaces);
      onSessionWorkspaces(payload.workspaces);
    }
    setSessions(payload.sessions);
    setSelectedSession((current) => {
      if (!current) {
        return current;
      }
      return (
        payload.sessions.find(
          (session) => session.session_id === current.session_id,
        ) ?? current
      );
    });
    setClosingSessionIds((current) =>
      current.filter((sessionId) => closableSessionIds.has(sessionId)),
    );
    setKillingSessionIds((current) =>
      current.filter((sessionId) => remoteSessionIds.has(sessionId)),
    );
    if (
      selectedSessionRef.current &&
      !remoteSessionIds.has(selectedSessionRef.current.session_id)
    ) {
      setSelectedSession(null);
      setView("workbench");
    }
    setCreatingSession(false);
    return remoteSurfaceIds;
  }

  function applySessionStatus(session: TerminalSession): void {
    setSessions((current) => upsertSession(current, session));
    setSelectedSession((current) =>
      current?.session_id === session.session_id ? session : current,
    );
    if (pendingCreateRef.current) {
      if (isTransitionalSessionStatus(session.status)) {
        setCreatingSession(true);
        setConnectionMessage(`${session.title} is ${session.status}.`);
        return;
      }

      pendingCreateRef.current = false;
      setCreatingSession(false);
      const capabilities = getSessionCapabilities(session);
      if (capabilities.canOpen) {
        setSelectedSession(session);
        setView("terminal");
      } else {
        setConnectionMessage(
          capabilities.unavailableReason ??
            "Session was created but is not interactive.",
        );
        setView("workbench");
      }
    } else if (!isTransitionalSessionStatus(session.status)) {
      setCreatingSession(false);
    }
  }

  function applyWorkspaceList(payload: WorkspaceListPayload): void {
    setWorkspaces(payload.workspaces);
  }

  function applySelectedSessionTerminalSize(size: TerminalResizePayload): void {
    if (!selectedSession) {
      return;
    }
    setSelectedSession((current) =>
      current && current.session_id === selectedSession.session_id
        ? { ...current, terminal_size: size }
        : current,
    );
    setSessions((current) =>
      current.map((session) =>
        session.session_id === selectedSession.session_id
          ? { ...session, terminal_size: size }
          : session,
      ),
    );
  }

  return {
    selectedSession,
    selectedSessionCapabilities,
    sessions,
    terminalProviders,
    workspaces,
    defaultSessionCwd,
    creatingSession,
    closingSessionIds,
    killingSessionIds,
    selectSession: setSelectedSession,
    clearSessionState,
    resetSessionProgress,
    requestSessionListRefresh,
    handleRefreshSessions,
    handleCreateSession,
    handleCloseSession,
    handleRenameSession,
    handleKillTerminalSession,
    applySessionList,
    applySessionStatus,
    applyWorkspaceList,
    applySelectedSessionTerminalSize,
  };
}
