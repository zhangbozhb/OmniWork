import type { MessageEnvelope } from "@omniwork/protocol-ts";

import type {
  AppSessionTransport,
  AppView,
  ConnectionStatus,
} from "./appTypes";
import {
  dispatchAppMessage,
  type AppMessageHandlers,
} from "./appMessageDispatcher";
import type { PairingConfig } from "../features/auth/types";
import { getAgentNotificationSettingsRequest } from "../features/agent/agentMessages";
import { listSessionsRequest } from "../features/sessions/sessionMessages";

type Confirm = (options: {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  tone?: "primary" | "danger";
}) => Promise<boolean>;

type AppRelayMessageHandlerContext = {
  t(key: string): string;
  confirm: Confirm;
  currentView: AppView;
  pendingAutoOpenSessionsRef: { current: boolean };
  clearFailureDialogState(): void;
  clearLocalAgentData(): void;
  shouldRefreshWorkbenchOnConnection(): boolean;
  setConnectionStatus(status: ConnectionStatus): void;
  setConnectionMessage(message: string): void;
  setView(view: AppView): void;
  setSelectedSession(session: null): void;
  resetSessionProgress(): void;
  handleAuthFailureCleanup(
    pairing: PairingConfig,
    reason: string,
    currentView: AppView,
  ): Promise<void>;
  applySessionList(
    payload: Parameters<AppMessageHandlers["onSessionList"]>[0],
  ): Set<string>;
  pruneTerminalSurfaces(surfaceIds: Set<string>): void;
  applySessionStatus(
    session: Parameters<AppMessageHandlers["onSessionStatus"]>[0],
  ): void;
  applyWorkspaceList(
    payload: Parameters<AppMessageHandlers["onWorkspaceList"]>[0],
  ): void;
  applyFilesList(payload: Parameters<AppMessageHandlers["onFilesList"]>[0]): void;
  applyFilesRead(payload: Parameters<AppMessageHandlers["onFilesRead"]>[0]): void;
  applyFilesWrite(payload: Parameters<AppMessageHandlers["onFilesWrite"]>[0]): void;
  applyGitStatus(payload: Parameters<AppMessageHandlers["onGitStatus"]>[0]): void;
  applyGitDiff(payload: Parameters<AppMessageHandlers["onGitDiff"]>[0]): void;
  handleAgentMessage(
    payload: Parameters<AppMessageHandlers["onAgentMessage"]>[0],
  ): void;
  handleAgentNotificationSettings(
    payload: Parameters<AppMessageHandlers["onAgentNotificationSettings"]>[0],
  ): void;
  applyTerminalSnapshot(
    payload: Parameters<AppMessageHandlers["onTerminalSnapshot"]>[0],
    message: MessageEnvelope,
  ): void;
  applyTerminalFrame(
    payload: Parameters<AppMessageHandlers["onTerminalFrame"]>[0],
    message: MessageEnvelope,
  ): void;
  applyTerminalStreamReady(
    payload: Parameters<AppMessageHandlers["onTerminalStreamReady"]>[0],
    message: MessageEnvelope,
  ): void;
  applyTerminalStreamData(
    payload: Parameters<AppMessageHandlers["onTerminalStreamData"]>[0],
    message: MessageEnvelope,
  ): void;
  applyTerminalStreamError(
    payload: Parameters<AppMessageHandlers["onTerminalStreamError"]>[0],
    message: MessageEnvelope,
  ): void;
};

export function handleAppRelayMessage(
  message: MessageEnvelope,
  relay: AppSessionTransport,
  activePairing: PairingConfig,
  context: AppRelayMessageHandlerContext,
): void {
  if (message.type.startsWith("tunnel.upgrade.")) {
    relay.handleUpgradeMessage(message);
    return;
  }
  dispatchAppMessage(message, {
    onAuthChallenge() {
      context.setConnectionStatus("authenticating");
      context.setConnectionMessage("Verifying temporary key...");
    },
    onAuthOk() {
      context.clearFailureDialogState();
      if (relay.isStrictP2p()) {
        context.clearLocalAgentData();
        context.setConnectionStatus("authenticating");
        context.setConnectionMessage("Establishing direct P2P connection...");
      } else {
        context.setConnectionStatus("authenticated");
        context.setConnectionMessage("Connected to Desktop.");
        const shouldOpenSessions = context.pendingAutoOpenSessionsRef.current;
        if (context.shouldRefreshWorkbenchOnConnection()) {
          relay.send(listSessionsRequest(activePairing.deviceId));
        }
        relay.send(getAgentNotificationSettingsRequest(activePairing.deviceId));
        if (shouldOpenSessions) {
          context.pendingAutoOpenSessionsRef.current = false;
          context.setView("workbench");
        }
      }
    },
    onAuthFailed(payload) {
      context.setConnectionStatus("failed");
      context.setConnectionMessage(`Authentication failed: ${payload.reason}`);
      context.pendingAutoOpenSessionsRef.current = false;
      relay.close();
      void context.handleAuthFailureCleanup(
        activePairing,
        payload.reason,
        context.currentView,
      );
    },
    onSessionList(payload) {
      const remoteSurfaceIds = context.applySessionList(payload);
      context.pruneTerminalSurfaces(remoteSurfaceIds);
    },
    onSessionStatus(session) {
      context.applySessionStatus(session);
    },
    onWorkspaceList(payload) {
      context.applyWorkspaceList(payload);
    },
    onFilesList(payload) {
      context.applyFilesList(payload);
    },
    onFilesRead(payload) {
      context.applyFilesRead(payload);
    },
    onFilesWrite(payload) {
      context.applyFilesWrite(payload);
    },
    onGitStatus(payload) {
      context.applyGitStatus(payload);
    },
    onGitDiff(payload) {
      context.applyGitDiff(payload);
    },
    onAgentMessage(payload) {
      context.handleAgentMessage(payload);
    },
    onAgentNotificationSettings(payload) {
      context.handleAgentNotificationSettings(payload);
    },
    onProtocolError(payload) {
      const detail = payload.detail || context.t("app.errors.protocolError");
      context.setConnectionMessage(detail);
      if (payload.code === "plaintext_business_rejected") {
        context
          .confirm({
            title: context.t("app.errors.hostError"),
            message: detail,
            confirmText: context.t("app.actions.ok"),
            cancelText: "",
            tone: "danger",
          })
          .catch(() => {
            /* user dismissed */
          });
      }
    },
    onTerminalSnapshot(payload, message) {
      context.applyTerminalSnapshot(payload, message);
    },
    onTerminalFrame(payload, message) {
      context.applyTerminalFrame(payload, message);
    },
    onTerminalStreamReady(payload, message) {
      context.applyTerminalStreamReady(payload, message);
    },
    onTerminalStreamData(payload, message) {
      context.applyTerminalStreamData(payload, message);
    },
    onTerminalStreamError(payload, message) {
      context.applyTerminalStreamError(payload, message);
    },
    onTerminalError(payload) {
      context.resetSessionProgress();
      const detail = payload.message || context.t("app.errors.terminalError");
      context.setConnectionMessage(detail);
      if (payload.code === "TMUX_TARGET_MISSING") {
        context.setSelectedSession(null);
        context.setView("workbench");
      }
      const title =
        payload.code === "SESSION_CREATE_FAILED"
          ? context.t("app.errors.failedCreateSession")
          : payload.code === "TMUX_TARGET_MISSING"
            ? context.t("app.errors.sessionUnavailable")
            : context.t("app.errors.hostError");
      context
        .confirm({
          title,
          message: detail,
          confirmText: context.t("app.actions.ok"),
          cancelText: "",
          tone: "danger",
        })
        .catch(() => {
          /* user dismissed */
        });
    },
  });
}
