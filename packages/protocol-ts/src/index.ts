export {
  PAIRING_LINK_HOST,
  PAIRING_LINK_SCHEME,
  PROTOCOL_VERSION,
} from "./constants.ts";
import {
  PAIRING_LINK_HOST,
  PAIRING_LINK_SCHEME,
  PROTOCOL_VERSION,
} from "./constants.ts";

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
  | "workspace.list"
  | "workspace.status"
  | "files.list"
  | "files.read"
  | "git.status"
  | "git.diff"
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
  | "codex.error"
  | "tunnel.upgrade.propose"
  | "tunnel.upgrade.offer"
  | "tunnel.upgrade.answer"
  | "tunnel.upgrade.candidate"
  | "tunnel.upgrade.committed"
  | "tunnel.upgrade.downgrade"
  | "transport.ping"
  | "transport.pong";

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
  providers?: AgentProviderDefinition[];
  workspaces?: WorkspaceDefinition[];
  capabilities: AgentCapability[];
}

export type KnownAgentCapability =
  | "terminal.tui"
  | "terminal.snapshot"
  | "session.tmux"
  | "session.tmux.attach"
  | "session.tmux.kill"
  | "workspace.list"
  | "files.read"
  | "git.read"
  | "codex.cli"
  | "codex.app_server"
  | "claude.cli"
  | "gemini.cli";
export type AgentCapability = KnownAgentCapability | (string & {});

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

export type RuntimeKind = string;
export type AgentProviderKind = string;

export interface AgentProviderDefinition {
  kind: AgentProviderKind;
  displayName: string;
  capability: AgentCapability;
  summary: string;
  defaultCommand: string;
  creatable: boolean;
}

export const DEFAULT_AGENT_PROVIDER_DEFINITIONS: readonly AgentProviderDefinition[] =
  [
    {
      kind: "codex",
      displayName: "Codex",
      capability: "codex.cli",
      summary: "OpenAI Codex CLI TUI session",
      defaultCommand: "codex",
      creatable: true,
    },
    {
      kind: "claude",
      displayName: "Claude",
      capability: "claude.cli",
      summary: "Claude Code CLI TUI session",
      defaultCommand: "claude",
      creatable: true,
    },
    {
      kind: "gemini",
      displayName: "Gemini",
      capability: "gemini.cli",
      summary: "Gemini CLI TUI session",
      defaultCommand: "gemini",
      creatable: true,
    },
  ] as const;

export function getAgentProviderDefinition(
  kind: RuntimeKind,
  providers: readonly AgentProviderDefinition[] = DEFAULT_AGENT_PROVIDER_DEFINITIONS,
): AgentProviderDefinition | undefined {
  return providers.find((provider) => provider.kind === kind);
}

export function getRuntimeLabel(
  kind: RuntimeKind,
  providers: readonly AgentProviderDefinition[] = DEFAULT_AGENT_PROVIDER_DEFINITIONS,
): string {
  return getAgentProviderDefinition(kind, providers)?.displayName ?? "Other";
}

export function getCreatableAgentProviders(
  providers: readonly AgentProviderDefinition[] = DEFAULT_AGENT_PROVIDER_DEFINITIONS,
): readonly AgentProviderDefinition[] {
  return providers.filter((provider) => provider.creatable);
}

export function isCreatableRuntimeKind(
  kind: RuntimeKind,
  providers: readonly AgentProviderDefinition[] = DEFAULT_AGENT_PROVIDER_DEFINITIONS,
): kind is AgentProviderKind {
  return Boolean(getAgentProviderDefinition(kind, providers)?.creatable);
}

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
  workspace_path?: string;
  workspace_name?: string;
  git_repository?: boolean;
  origin?: SessionOrigin;
  registered?: boolean;
}

export interface SessionListPayload {
  sessions: CodexSession[];
  default_cwd?: string;
  providers?: AgentProviderDefinition[];
  workspaces?: WorkspaceDefinition[];
}

export interface SessionCreatePayload {
  runtime_kind?: RuntimeKind;
  title?: string;
  cwd?: string;
  workspace_path?: string;
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

export interface SessionRenamePayload {
  session_id: string;
  title: string;
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

export type WorkspaceStatus = "available" | "missing" | "permission_denied";

export type WorkspaceSource = "tmux" | "session" | "recent" | "default";

export interface WorkspaceDefinition {
  name?: string;
  path: string;
  isGitRepository: boolean;
  gitRoot?: string;
  status: WorkspaceStatus;
  source: WorkspaceSource;
}

export interface WorkspaceListPayload {
  workspaces: WorkspaceDefinition[];
}

export interface WorkspaceStatusPayload {
  workspace: WorkspaceDefinition;
}

export interface FilesListRequestPayload {
  workspacePath: string;
  relativePath?: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export interface FilesListPayload {
  workspacePath: string;
  relativePath: string;
  entries: WorkspaceFileEntry[];
}

export interface FilesReadRequestPayload {
  workspacePath: string;
  relativePath: string;
}

export interface FilesReadPayload {
  workspacePath: string;
  relativePath: string;
  content?: string;
  encoding: "utf8" | "binary" | "too_large";
  size: number;
}

export interface WorkspaceGitStatus {
  workspacePath: string;
  isGitRepository: boolean;
  branch?: string;
  headSha?: string;
  ahead?: number;
  behind?: number;
  hasChanges: boolean;
  files: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  }>;
}

export interface GitStatusRequestPayload {
  workspacePath: string;
}

export interface GitStatusPayload {
  workspacePath: string;
  status: WorkspaceGitStatus;
}

export interface GitDiffRequestPayload {
  workspacePath: string;
  relativePath?: string;
}

export interface GitDiffPayload {
  workspacePath: string;
  relativePath?: string;
  diff: string;
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

  return `${PAIRING_LINK_SCHEME}://${PAIRING_LINK_HOST}?${params.toString()}`;
}

export function parsePairingLink(input: string): PairingLinkPayload | null {
  const query = extractPairingQuery(input);
  if (!query) {
    return null;
  }

  const params = parseQueryParams(query);

  const rawVersion = searchParam(params, "v");
  if (rawVersion !== undefined && Number(rawVersion) !== PROTOCOL_VERSION) {
    return null;
  }

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

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TunnelUpgradeProposePayload {
  upgrade_id: string;
  ice_servers: IceServerConfig[];
  role: "offerer" | "answerer";
}

export interface TunnelUpgradeOfferPayload {
  upgrade_id: string;
  sdp: string;
}

export interface TunnelUpgradeAnswerPayload {
  upgrade_id: string;
  sdp: string;
}

export interface TunnelUpgradeCandidatePayload {
  upgrade_id: string;
  candidate: string;
  sdp_mid: string | null;
  sdp_mline_index: number | null;
}

export interface TunnelUpgradeCommittedPayload {
  upgrade_id: string;
}

export interface TunnelUpgradeDowngradePayload {
  upgrade_id: string;
  reason: string;
}

export interface TransportPingPayload {
  upgrade_id?: string;
  seq: number;
  sent_at: string;
}

export interface TransportPongPayload {
  upgrade_id?: string;
  seq: number;
  sent_at: string;
  received_at: string;
}

export * from "./schemas.ts";
export * from "./transport.ts";
export * from "./webrtc.ts";
