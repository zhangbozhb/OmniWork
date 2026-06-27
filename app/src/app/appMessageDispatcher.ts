import type {
  AgentAppMessage,
  AgentNotificationSettingsPayload,
  AuthFailedPayload,
  FilesListPayload,
  FilesReadPayload,
  FilesWritePayload,
  GitDiffPayload,
  GitStatusPayload,
  MessageEnvelope,
  ProtocolErrorPayload,
  SessionListPayload,
  TerminalErrorPayload,
  TerminalFramePayload,
  TerminalSession,
  TerminalSnapshotPayload,
  TerminalStreamDataPayload,
  TerminalStreamErrorPayload,
  WorkspaceListPayload,
} from "@omniwork/protocol-ts";

export type AppMessageHandlers = {
  onAuthChallenge(message: MessageEnvelope): void;
  onAuthOk(message: MessageEnvelope): void;
  onAuthFailed(payload: AuthFailedPayload, message: MessageEnvelope): void;
  onSessionList(payload: SessionListPayload, message: MessageEnvelope): void;
  onSessionStatus(session: TerminalSession, message: MessageEnvelope): void;
  onWorkspaceList(
    payload: WorkspaceListPayload,
    message: MessageEnvelope,
  ): void;
  onFilesList(payload: FilesListPayload, message: MessageEnvelope): void;
  onFilesRead(payload: FilesReadPayload, message: MessageEnvelope): void;
  onFilesWrite(payload: FilesWritePayload, message: MessageEnvelope): void;
  onGitStatus(payload: GitStatusPayload, message: MessageEnvelope): void;
  onGitDiff(payload: GitDiffPayload, message: MessageEnvelope): void;
  onAgentMessage(payload: AgentAppMessage, message: MessageEnvelope): void;
  onAgentNotificationSettings(
    payload: AgentNotificationSettingsPayload,
    message: MessageEnvelope,
  ): void;
  onProtocolError(
    payload: ProtocolErrorPayload,
    message: MessageEnvelope,
  ): void;
  onTerminalSnapshot(
    payload: TerminalSnapshotPayload,
    message: MessageEnvelope,
  ): void;
  onTerminalFrame(
    payload: TerminalFramePayload,
    message: MessageEnvelope,
  ): void;
  onTerminalStreamReady(
    payload: { stream_id?: string },
    message: MessageEnvelope,
  ): void;
  onTerminalStreamData(
    payload: TerminalStreamDataPayload,
    message: MessageEnvelope,
  ): void;
  onTerminalStreamError(
    payload: TerminalStreamErrorPayload,
    message: MessageEnvelope,
  ): void;
  onTerminalError(
    payload: TerminalErrorPayload,
    message: MessageEnvelope,
  ): void;
};

export function dispatchAppMessage(
  message: MessageEnvelope,
  handlers: AppMessageHandlers,
): void {
  switch (message.type) {
    case "auth.challenge":
      handlers.onAuthChallenge(message);
      break;
    case "auth.ok":
      handlers.onAuthOk(message);
      break;
    case "auth.failed":
      handlers.onAuthFailed(message.payload as AuthFailedPayload, message);
      break;
    case "session.list":
      handlers.onSessionList(message.payload as SessionListPayload, message);
      break;
    case "session.status": {
      const payload = message.payload as { session: TerminalSession };
      handlers.onSessionStatus(payload.session, message);
      break;
    }
    case "workspace.list":
      handlers.onWorkspaceList(
        message.payload as WorkspaceListPayload,
        message,
      );
      break;
    case "files.list":
      handlers.onFilesList(message.payload as FilesListPayload, message);
      break;
    case "files.read":
      handlers.onFilesRead(message.payload as FilesReadPayload, message);
      break;
    case "files.write":
      handlers.onFilesWrite(message.payload as FilesWritePayload, message);
      break;
    case "git.status":
      handlers.onGitStatus(message.payload as GitStatusPayload, message);
      break;
    case "git.diff":
      handlers.onGitDiff(message.payload as GitDiffPayload, message);
      break;
    case "agent.message":
      handlers.onAgentMessage(message.payload as AgentAppMessage, message);
      break;
    case "agent.notification.settings.get":
    case "agent.notification.settings.set":
      handlers.onAgentNotificationSettings(
        message.payload as AgentNotificationSettingsPayload,
        message,
      );
      break;
    case "protocol.error":
      handlers.onProtocolError(message.payload as ProtocolErrorPayload, message);
      break;
    case "terminal.snapshot":
      handlers.onTerminalSnapshot(
        message.payload as TerminalSnapshotPayload,
        message,
      );
      break;
    case "terminal.frame":
      handlers.onTerminalFrame(message.payload as TerminalFramePayload, message);
      break;
    case "terminal.stream.ready":
      handlers.onTerminalStreamReady(
        message.payload as { stream_id?: string },
        message,
      );
      break;
    case "terminal.stream.data":
      handlers.onTerminalStreamData(
        message.payload as TerminalStreamDataPayload,
        message,
      );
      break;
    case "terminal.stream.error":
      handlers.onTerminalStreamError(
        message.payload as TerminalStreamErrorPayload,
        message,
      );
      break;
    case "terminal.error":
      handlers.onTerminalError(message.payload as TerminalErrorPayload, message);
      break;
    default:
      break;
  }
}
