export {
  E2E_NOISE_NNPSK0_CAPABILITY_V1,
  E2E_PROTOCOL_VERSION,
  ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1,
  INNER_PROTOCOL_VERSION,
  NOISE_SUITE_NNPSK0_V1,
  PAIRING_LINK_HOST,
  PAIRING_LINK_SCHEME,
  PLAINTEXT_BUSINESS_CAPABILITY_V1,
  PROTOCOL_VERSION,
  SUPPORTED_SESSION_STATUSES,
} from "./constants.ts";
import {
  E2E_NOISE_NNPSK0_CAPABILITY_V1,
  E2E_PROTOCOL_VERSION,
  ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1,
  INNER_PROTOCOL_VERSION,
  NOISE_SUITE_NNPSK0_V1,
  PAIRING_LINK_HOST,
  PAIRING_LINK_SCHEME,
  PLAINTEXT_BUSINESS_CAPABILITY_V1,
  PROTOCOL_VERSION,
  SUPPORTED_SESSION_STATUSES,
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
  | "app.network.changed"
  | "app.connection.heartbeat"
  | "app.connection.goodbye"
  | "e2e.handshake.init"
  | "e2e.handshake.reply"
  | "e2e.ready"
  | "e2e.message"
  | "e2e.failed"
  | "e2e.rekey.init"
  | "e2e.rekey.reply"
  | "e2e.rekey.ready"
  | "e2e.close"
  | "protocol.error"
  | "device.list"
  | "session.list"
  | "session.create"
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
  app_connection_id?: string;
  seq?: number;
  ts: string;
  payload: TPayload;
}

export interface AgentHelloPayload {
  v: typeof PROTOCOL_VERSION;
  device_id: string;
  agent_instance_id: string;
  key_id: string;
  protocol: ProtocolSupport;
  e2e: E2ESupport;
  business_security_mode?: BusinessSecurityMode;
  hostname: string;
  platform: "darwin";
  agent_version: string;
  providers?: AgentProviderDefinition[];
  workspaces?: WorkspaceDefinition[];
  capabilities: AgentCapability[];
}

export type KnownAgentCapability =
  | typeof E2E_NOISE_NNPSK0_CAPABILITY_V1
  | typeof ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1
  | typeof PLAINTEXT_BUSINESS_CAPABILITY_V1
  | "terminal.tui"
  | "terminal.snapshot"
  | "session.tmux"
  | "session.tmux.attach"
  | "session.tmux.kill"
  | "workspace.list"
  | "files.read"
  | "git.read"
  | "terminal.shell"
  | "codex.cli"
  | "codex.app_server"
  | "claude.cli"
  | "gemini.cli";
export type AgentCapability = KnownAgentCapability | (string & {});

export type AppClientPlatform = "ios" | "android" | "web" | "desktop";

export interface AppInfoPayload {
  instance_id: string;
  runtime_id: string;
  name?: string;
  device_name?: string;
  platform?: AppClientPlatform;
  version?: string;
  capabilities?: string[];
}

export interface MobileConnectPayload {
  v: typeof PROTOCOL_VERSION;
  device_id: string;
  key_id: string;
  app_info: AppInfoPayload;
  protocol: ProtocolSupport;
  e2e: E2ESupport;
  /**
   * App 端显式声明的传输偏好，由 Relay 在 propose 守门时读取：
   * - "auto"（缺省）：跟随 Relay 灰度/黑名单/退避策略
   * - "relay_only"：禁用 P2P 升级，Relay 跳过 propose，不进入退避，不计 metrics 失败
   * - "prefer_p2p"：严格 P2P。业务消息只允许走 DataChannel；协商或运行期失败时
   *   双端直接关闭 session（forceClose），不回退到 Relay。Relay 会在 propose
   *   payload 中带 strict=true，并跳过 rollout 灰度（仍受 enabled / blocklist /
   *   backoff 约束）；Web 等无 PeerConnection 的环境下 session 直接不可建立。
   */
  transport_preference?: TransportPreference;
}

export type AppNetworkChangedReason = "foreground_resume" | "network_changed";

export interface AppNetworkChangedPayload {
  app_connection_id: string;
  reason: AppNetworkChangedReason;
  network_type?: string;
  is_connected?: boolean;
  is_internet_reachable?: boolean;
}

export interface AppConnectionHeartbeatPayload {
  sent_at: string;
  seq: number;
  current_path?: "relay" | "p2p" | "unknown";
}

export interface AppConnectionGoodbyePayload {
  sent_at: string;
  seq: number;
  reason?: string;
}

export type TransportPreference = "auto" | "relay_only" | "prefer_p2p";

export const TRANSPORT_PREFERENCES: readonly TransportPreference[] = [
  "auto",
  "relay_only",
  "prefer_p2p",
];

export function isTransportPreference(
  value: unknown,
): value is TransportPreference {
  return (
    typeof value === "string" &&
    (TRANSPORT_PREFERENCES as readonly string[]).includes(value)
  );
}

export interface ProtocolSupport {
  current: typeof PROTOCOL_VERSION;
  min_supported: typeof PROTOCOL_VERSION;
}

export type NoiseSuite = typeof NOISE_SUITE_NNPSK0_V1;
export type BusinessSecurityMode = "e2e_required" | "plaintext_allowed";

export interface E2ESupport {
  required: boolean;
  versions: readonly [typeof E2E_PROTOCOL_VERSION, ...number[]];
  suites: readonly [NoiseSuite, ...string[]];
}

export const PROTOCOL_SUPPORT_V1: ProtocolSupport = {
  current: PROTOCOL_VERSION,
  min_supported: PROTOCOL_VERSION,
} as const;

export const E2E_SUPPORT_V1: E2ESupport = {
  required: true,
  versions: [E2E_PROTOCOL_VERSION],
  suites: [NOISE_SUITE_NNPSK0_V1],
} as const;

export interface E2EHandshakeInitPayload {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  handshake_id: string;
  key_id: string;
  suite: NoiseSuite;
  app_protocol: {
    outer_v: typeof PROTOCOL_VERSION;
    inner_v: typeof INNER_PROTOCOL_VERSION;
    e2e_v: typeof E2E_PROTOCOL_VERSION;
  };
  message: string;
}

export interface E2EHandshakeReplyPayload {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  handshake_id: string;
  key_id: string;
  suite: NoiseSuite;
  agent_protocol: {
    outer_v: typeof PROTOCOL_VERSION;
    inner_v: typeof INNER_PROTOCOL_VERSION;
    e2e_v: typeof E2E_PROTOCOL_VERSION;
  };
  message: string;
}

export interface E2EReadyPayload {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  handshake_id: string;
  transcript_hash: string;
}

export interface E2EMessagePayload {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  e2e_session_id: string;
  seq: number;
  ciphertext: string;
}

export type E2EFailureReason =
  | "unsupported_outer_version"
  | "unsupported_e2e_version"
  | "unsupported_suite"
  | "key_mismatch"
  | "handshake_failed"
  | "timeout"
  | "replay_detected"
  | "decrypt_failed";

export interface E2EFailedPayload {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id?: string;
  handshake_id?: string;
  reason: E2EFailureReason;
}

export type ProtocolErrorCode =
  | "unsupported_protocol_version"
  | "unsupported_message_type"
  | "invalid_state"
  | "schema_invalid"
  | "e2e_required"
  | "plaintext_business_rejected"
  | "route_not_found";

export interface ProtocolErrorPayload {
  v: typeof PROTOCOL_VERSION;
  code: ProtocolErrorCode;
  detail?: string;
  retryable: boolean;
}

export interface InnerEnvelope<TPayload = unknown> {
  v: typeof INNER_PROTOCOL_VERSION;
  id: string;
  type: MessageType;
  created_at: string;
  seq?: number;
  request_id?: string;
  session_id?: string;
  payload: TPayload;
}

export interface AuthChallengePayload {
  nonce: string;
  key_id: string;
  expires_at: string;
}

export interface AuthProofPayload {
  key_id: string;
  nonce: string;
  app_info: AppInfoPayload;
  proof: string;
}

export interface AuthVerifyPayload extends AuthProofPayload {
  connection_id?: string;
}

export interface AuthOkPayload {
  agent_instance_id: string;
  connection_id?: string;
  business_security_mode?: BusinessSecurityMode;
  e2e?: E2ESupport;
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
  display_name?: string;
  key: string;
  key_id?: string;
}

export type SessionStatus =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "archived";

/**
 * Agent 启动期 session store 的"应当被持久化保留"的 status 白名单。
 *
 * 与 `SessionStatus` 在概念上对齐：当前 `SessionStatus` 中的所有值都应可
 * 持久化（瞬态错误不再用 status 表达，而是通过 envelope error 直接反馈
 * 给前端）。常量本体定义在 constants.ts，避免 schemas.ts ↔ index.ts 的
 * 循环依赖在运行时触发 TDZ；这里通过编译期断言锁定二者的同步关系。
 *
 * 未来若新增"瞬态/不应落盘"的 status，可以从这里减除而无需动协议
 * 类型，避免一次破坏性变更。
 */
const _SUPPORTED_SESSION_STATUSES_TYPE_CHECK: readonly SessionStatus[] =
  SUPPORTED_SESSION_STATUSES;
void _SUPPORTED_SESSION_STATUSES_TYPE_CHECK;

export type PersistedSessionStatus =
  (typeof SUPPORTED_SESSION_STATUSES)[number];

export function isSupportedSessionStatus(
  value: unknown,
): value is PersistedSessionStatus {
  return (
    typeof value === "string" &&
    (SUPPORTED_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

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
    {
      kind: "terminal",
      displayName: "Terminal",
      capability: "terminal.shell",
      summary: "Plain terminal session",
      defaultCommand: "",
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
  /**
   * tmux server 进程 pid（`#{pid}`）。tmux server 重启后会重置，因此可以
   * 把 (tmux_server_pid, tmux_session_uid) 当作"同一进程窗口"的强 ID。
   * create() 与 external 发现路径都会写入该字段，store 中的条目一律按强 ID 比对。
   */
  tmux_server_pid?: number;
  /**
   * tmux session 的稳定 uid（`#{session_id}`，形如 `$1`）。tmux 重启后从 0 开始
   * 重新分配，所以与 `tmux_server_pid` 组合即可识别"同名但新进程"。
   */
  tmux_session_uid?: string;
  workspace_path?: string;
  workspace_name?: string;
  git_repository?: boolean;
  origin?: SessionOrigin;
  registered?: boolean;
}

/**
 * `CodexSession` 的所有合法字段名（运行时清单）。
 *
 * 用作与 `protocol/sessions/session.schema.json` 的对账依据：
 * contract.test 会断言 schema `properties` 集合与本数组一致，以保证
 * ts 协议与 JSON Schema 不会无声漂移。新增 / 删除字段时只需同时改
 * 这里和 schema.json 即可被测试覆盖。
 */
export const SESSION_FIELDS = [
  "session_id",
  "runtime_kind",
  "runtime_label",
  "title",
  "cwd",
  "command",
  "status",
  "created_at",
  "last_active_at",
  "terminal_size",
  "tmux_session_name",
  "tmux_server_pid",
  "tmux_session_uid",
  "workspace_path",
  "workspace_name",
  "git_repository",
  "origin",
  "registered",
] as const satisfies readonly (keyof CodexSession)[];

/**
 * `CodexSession` 中的必填字段（与 schema.json#required 对齐）。
 */
export const SESSION_REQUIRED_FIELDS = [
  "session_id",
  "runtime_kind",
  "runtime_label",
  "title",
  "cwd",
  "command",
  "status",
  "created_at",
  "last_active_at",
  "terminal_size",
  "tmux_session_name",
] as const satisfies readonly (typeof SESSION_FIELDS)[number][];

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
  captured_at?: string;
  byte_length?: number;
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
    oldPath?: string;
    status: "modified" | "added" | "deleted" | "renamed" | "untracked";
    indexStatus?: string;
    worktreeStatus?: string;
    staged?: boolean;
    unstaged?: boolean;
    stagedAdditions?: number;
    stagedDeletions?: number;
    unstagedAdditions?: number;
    unstagedDeletions?: number;
    additions?: number;
    deletions?: number;
  }>;
}

export interface GitStatusRequestPayload {
  workspacePath: string;
}

export interface GitStatusPayload {
  workspacePath: string;
  status: WorkspaceGitStatus;
}

export type GitDiffScope = "all" | "staged" | "unstaged" | "untracked";

export interface GitDiffRequestPayload {
  workspacePath: string;
  relativePath?: string;
  scope?: GitDiffScope;
}

export interface GitDiffPayload {
  workspacePath: string;
  relativePath?: string;
  scope?: GitDiffScope;
  diff: string;
}

export function createMessage<TPayload>(
  type: MessageType,
  payload: TPayload,
  options: {
    id?: string;
    device_id?: string;
    session_id?: string;
    app_connection_id?: string;
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
    app_connection_id: options.app_connection_id,
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
  setOptionalParam(params, "display_name", payload.display_name);
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
    display_name: searchParam(params, "display_name"),
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
  app_connection_id: string;
  ice_servers: IceServerConfig[];
  role: "offerer" | "answerer";
  /**
   * Relay 在 mobile.connect.transport_preference="prefer_p2p" 时置为 true。
   * 双端在收到 strict 标记后会启用严格 P2P 模式：
   * - 升级前不放行 session.* / terminal.* 等业务消息（仅放行控制面）
   * - 协商或运行期失败 → 直接关闭 session（forceClose），不回退到 Relay
   * 字段缺省视为 false，保持 auto 行为。
   */
  strict?: boolean;
}

export interface TunnelUpgradeOfferPayload {
  upgrade_id: string;
  app_connection_id: string;
  sdp: string;
}

export interface TunnelUpgradeAnswerPayload {
  upgrade_id: string;
  app_connection_id: string;
  sdp: string;
}

export interface TunnelUpgradeCandidatePayload {
  upgrade_id: string;
  app_connection_id: string;
  candidate: string;
  sdp_mid: string | null;
  sdp_mline_index: number | null;
}

export interface TunnelUpgradeCommittedPayload {
  upgrade_id: string;
  app_connection_id: string;
}

export interface TunnelUpgradeDowngradePayload {
  upgrade_id: string;
  app_connection_id: string;
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
export * from "./e2eMessages.ts";
export * from "./transport.ts";
export * from "./webrtc.ts";
export * from "./pairingCrypto.ts";
