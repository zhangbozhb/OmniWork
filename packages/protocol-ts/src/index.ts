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
  | "session.retry"
  | "session.recover"
  | "session.restart"
  | "session.rename"
  | "session.close"
  | "session.kill_tmux"
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
  | "session.tmux.attach"
  | "session.tmux.kill"
  | "codex.cli"
  | "codex.app_server"
  | "claude.cli";

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

export interface PairingLinkPayload {
  v: typeof PROTOCOL_VERSION;
  relay_url: string;
  device_id: string;
  key: string;
  key_id?: string;
  host?: string;
  port?: string;
}

export const PAIRING_LINK_SCHEME = "omniwork" as const;
export const PAIRING_LINK_HOST = "pair" as const;

export type SessionStatus =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "error"
  | "recovering"
  | "archived";

export type RuntimeKind = "codex" | "claude" | "other";
export type SessionOrigin = "managed" | "external";

export interface CodexSession {
  session_id: string;
  runtime_kind: RuntimeKind;
  runtime_label: string;
  title: string;
  cwd: string;
  command: string;
  status: SessionStatus;
  created_at: string;
  last_active_at: string;
  terminal_size: TerminalSize;
  tmux_session_name: string;
  origin?: SessionOrigin;
  registered?: boolean;
}

export interface SessionListPayload {
  sessions: CodexSession[];
  default_cwd?: string;
}

export interface SessionCreatePayload {
  runtime_kind?: RuntimeKind;
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

export interface SessionKillTmuxPayload {
  session_id: string;
}

export interface SessionRecoveryPayload {
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

export function createPairingLink(payload: PairingLinkPayload): string {
  const params = new URLSearchParams();
  params.set("v", String(payload.v));
  params.set("relay_url", payload.relay_url);
  params.set("device_id", payload.device_id);
  params.set("key", payload.key);
  setOptionalParam(params, "key_id", payload.key_id);
  setOptionalParam(params, "host", payload.host);
  setOptionalParam(params, "port", payload.port);

  return `${PAIRING_LINK_SCHEME}://${PAIRING_LINK_HOST}?${params.toString()}`;
}

export function parsePairingLink(input: string): PairingLinkPayload | null {
  const query = extractPairingQuery(input);
  if (!query) {
    return null;
  }

  const params = parseQueryParams(query);

  const relayUrl = searchParam(params, "relay_url");
  const deviceId = searchParam(params, "device_id");
  const key = searchParam(params, "key");
  if (!relayUrl || !deviceId || !key) {
    return null;
  }

  return {
    v: PROTOCOL_VERSION,
    relay_url: relayUrl,
    device_id: deviceId,
    key,
    key_id: searchParam(params, "key_id"),
    host: searchParam(params, "host"),
    port: searchParam(params, "port"),
  };
}

function setOptionalParam(
  params: URLSearchParams,
  key: string,
  value?: string,
): void {
  if (value) {
    params.set(key, value);
  }
}

function extractPairingQuery(input: string): string | null {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const prefixes = [
    `${PAIRING_LINK_SCHEME}://${PAIRING_LINK_HOST}`,
    `${PAIRING_LINK_SCHEME}:/${PAIRING_LINK_HOST}`,
    `${PAIRING_LINK_SCHEME}:${PAIRING_LINK_HOST}`,
  ];
  const prefix = prefixes.find((item) => lower.startsWith(item));
  if (!prefix) {
    return null;
  }

  const remainder = trimmed.slice(prefix.length).replace(/^\/+/, "");
  const queryStart = remainder.indexOf("?");
  if (queryStart < 0) {
    return null;
  }

  const query = remainder.slice(queryStart + 1);
  const hashStart = query.indexOf("#");
  return hashStart >= 0 ? query.slice(0, hashStart) : query;
}

function parseQueryParams(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) {
      continue;
    }

    const separator = part.indexOf("=");
    const rawKey = separator >= 0 ? part.slice(0, separator) : part;
    const rawValue = separator >= 0 ? part.slice(separator + 1) : "";
    const key = decodeQueryComponent(rawKey);
    if (key) {
      params[key] = decodeQueryComponent(rawValue);
    }
  }

  return params;
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function searchParam(
  params: Record<string, string>,
  key: string,
): string | undefined {
  return params[key]?.trim() || undefined;
}
