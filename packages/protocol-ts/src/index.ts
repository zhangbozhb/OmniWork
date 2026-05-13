export const PROTOCOL_VERSION = 1 as const;

export type MessageType =
  | "agent.hello"
  | "agent.heartbeat"
  | "mobile.connect"
  | "auth.challenge"
  | "auth.proof"
  | "auth.verify"
  | "auth.ok"
  | "auth.failed"
  | "device.list"
  | "session.list"
  | "session.create"
  | "session.rename"
  | "session.close"
  | "session.attach"
  | "session.detach"
  | "session.status"
  | "terminal.frame"
  | "terminal.input"
  | "terminal.resize"
  | "terminal.snapshot"
  | "terminal.ack"
  | "terminal.error"
  | "codex.thread.list"
  | "codex.thread.start"
  | "codex.thread.resume"
  | "codex.turn.event"
  | "codex.approval.request"
  | "codex.approval.answer"
  | "codex.diff.event"
  | "codex.error";

export interface MessageEnvelope<TPayload = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: MessageType;
  device_id?: string;
  session_id?: string;
  seq?: number;
  ts: string;
  payload: TPayload;
}

export interface AgentHelloPayload {
  device_id: string;
  agent_instance_id: string;
  key_id: string;
  hostname: string;
  platform: "darwin";
  agent_version: string;
  capabilities: AgentCapability[];
}

export type AgentCapability =
  | "terminal.tui"
  | "terminal.snapshot"
  | "session.tmux"
  | "codex.cli"
  | "codex.app_server";

export interface MobileConnectPayload {
  device_id: string;
  key_id: string;
}

export interface AuthChallengePayload {
  nonce: string;
  key_id: string;
  expires_at: string;
}

export interface AuthProofPayload {
  key_id: string;
  nonce: string;
  proof: string;
}

export interface AuthVerifyPayload extends AuthProofPayload {
  connection_id?: string;
}

export interface AuthOkPayload {
  agent_instance_id: string;
  connection_id?: string;
  expires_at?: string;
}

export type AuthFailureReason =
  | "key_mismatch"
  | "agent_restarted"
  | "key_expired"
  | "device_not_online"
  | "too_many_attempts"
  | "malformed_proof";

export interface AuthFailedPayload {
  reason: AuthFailureReason;
  connection_id?: string;
  retry_after_ms?: number;
}

export type SessionStatus =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "error"
  | "recovering"
  | "archived";

export interface CodexSession {
  session_id: string;
  title: string;
  cwd: string;
  command: string;
  status: SessionStatus;
  created_at: string;
  last_active_at: string;
  terminal_size: TerminalSize;
  tmux_session_name: string;
}

export interface SessionListPayload {
  sessions: CodexSession[];
  default_cwd?: string;
}

export interface SessionCreatePayload {
  title?: string;
  cwd?: string;
  command?: string;
  terminal_size?: TerminalSize;
}

export interface SessionCreatedPayload {
  session: CodexSession;
}

export interface SessionAttachPayload {
  session_id: string;
}

export interface SessionClosePayload {
  session_id: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export type TerminalInputKind = "text" | "key" | "paste";

export interface TerminalInputPayload {
  kind: TerminalInputKind;
  data: string;
}

export interface TerminalFramePayload {
  data: string;
  snapshot?: boolean;
}

export interface TerminalSnapshotPayload {
  data: string;
  size: TerminalSize;
  captured_at: string;
}

export interface TerminalResizePayload extends TerminalSize {}

export interface TerminalAckPayload {
  ack_seq: number;
  received_bytes?: number;
}

export interface TerminalErrorPayload {
  code: string;
  message: string;
}

export function createMessage<TPayload>(
  type: MessageType,
  payload: TPayload,
  options: {
    id?: string;
    device_id?: string;
    session_id?: string;
    seq?: number;
    ts?: string;
  } = {},
): MessageEnvelope<TPayload> {
  return {
    v: PROTOCOL_VERSION,
    id: options.id ?? createMessageId(),
    type,
    device_id: options.device_id,
    session_id: options.session_id,
    seq: options.seq,
    ts: options.ts ?? new Date().toISOString(),
    payload,
  };
}

export function createMessageId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `msg_${Date.now().toString(36)}_${random}`;
}
