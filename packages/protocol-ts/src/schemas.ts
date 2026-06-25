/**
 * Zod schemas for the OmniWork wire protocol.
 *
 * Goal: 在 TypeScript 类型之外，再为关键报文提供运行时校验来源。
 * 范围：覆盖跨端最频繁、最敏感的 envelope、鉴权、E2E、终端、会话、
 * workspace/files/git、P2P upgrade 与 transport health 报文；暂未建模的
 * codex.* 扩展消息仍只校验 envelope。
 */
import { z } from "zod";
import type { MessageEnvelope, MessageType } from "./index.ts";

import {
  E2E_PROTOCOL_VERSION,
  INNER_PROTOCOL_VERSION,
  NOISE_SUITE_NNPSK0_V1,
  PROTOCOL_VERSION,
  SUPPORTED_SESSION_STATUSES,
} from "./constants.ts";

const isoDateTime = z
  .string()
  .min(1, "ts must be a non-empty ISO timestamp string");

const messageId = z.string().min(1, "id must be a non-empty string");
const emptyPayloadSchema = z.object({}).strict();

export const messageTypeSchema = z.enum([
  "agent.hello",
  "agent.heartbeat",
  "mobile.connect",
  "auth.challenge",
  "auth.proof",
  "auth.verify",
  "auth.ok",
  "auth.failed",
  "app.network.changed",
  "app.connection.heartbeat",
  "app.connection.goodbye",
  "e2e.handshake.init",
  "e2e.handshake.reply",
  "e2e.ready",
  "e2e.message",
  "e2e.failed",
  "e2e.rekey.init",
  "e2e.rekey.reply",
  "e2e.rekey.ready",
  "e2e.close",
  "protocol.error",
  "device.list",
  "session.list",
  "session.create",
  "session.rename",
  "session.close",
  "session.kill_terminal",
  "session.attach",
  "session.detach",
  "session.status",
  "workspace.list",
  "workspace.status",
  "files.list",
  "files.read",
  "files.write",
  "git.status",
  "git.diff",
  "terminal.frame",
  "terminal.input",
  "terminal.resize",
  "terminal.snapshot",
  "terminal.stream.start",
  "terminal.stream.ready",
  "terminal.stream.data",
  "terminal.stream.stop",
  "terminal.stream.error",
  "terminal.ack",
  "terminal.error",
  "codex.thread.list",
  "codex.thread.start",
  "codex.thread.resume",
  "codex.turn.event",
  "codex.approval.request",
  "codex.approval.answer",
  "codex.diff.event",
  "codex.error",
  "agent.message",
  "agent.message.list",
  "agent.message.read",
  "agent.message.ack",
  "agent.notification.settings.get",
  "agent.notification.settings.set",
  "tunnel.upgrade.propose",
  "tunnel.upgrade.offer",
  "tunnel.upgrade.answer",
  "tunnel.upgrade.candidate",
  "tunnel.upgrade.committed",
  "tunnel.upgrade.downgrade",
  "transport.ping",
  "transport.pong",
] as const satisfies readonly [MessageType, ...MessageType[]]);

/**
 * 通用信封 schema，仅校验跨端通信都依赖的元字段，payload 留给具体消息 schema。
 */
export const messageEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: messageId,
  type: messageTypeSchema,
  device_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  surface_id: z.string().min(1).optional(),
  app_connection_id: z.string().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  ts: isoDateTime,
  payload: z.unknown(),
});
export type MessageEnvelopeShape = z.infer<typeof messageEnvelopeSchema>;

export const authChallengePayloadSchema = z.object({
  nonce: z.string().min(1),
  key_id: z.string().min(1),
  expires_at: isoDateTime,
});

const appClientPlatformSchema = z.enum(["ios", "android", "web", "desktop"]);

export const appInfoPayloadSchema = z
  .object({
    instance_id: z.string().min(1),
    runtime_id: z.string().min(1),
    name: z.string().min(1).optional(),
    device_name: z.string().min(1).optional(),
    platform: appClientPlatformSchema.optional(),
    version: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const authProofPayloadSchema = z.object({
  key_id: z.string().min(1),
  nonce: z.string().min(1),
  app_info: appInfoPayloadSchema,
  proof: z.string().min(1),
});

export const authVerifyPayloadSchema = authProofPayloadSchema.extend({
  connection_id: z.string().min(1).optional(),
});

export const authOkPayloadSchema = z.object({
  agent_instance_id: z.string().min(1),
  connection_id: z.string().min(1).optional(),
  business_security_mode: z
    .enum(["e2e_required", "plaintext_allowed"])
    .optional(),
  e2e: z
    .object({
      required: z.boolean(),
      versions: z
        .array(z.number().int().positive())
        .min(1)
        .refine((versions) => versions.includes(E2E_PROTOCOL_VERSION), {
          message: "E2E v1 support is required",
        }),
      suites: z
        .array(z.string().min(1))
        .min(1)
        .refine((suites) => suites.includes(NOISE_SUITE_NNPSK0_V1), {
          message: "Noise NNpsk0 v1 support is required",
        }),
    })
    .strict()
    .optional(),
  expires_at: isoDateTime.optional(),
});

export const authFailureReasonSchema = z.enum([
  "key_mismatch",
  "agent_restarted",
  "key_expired",
  "device_not_online",
  "too_many_attempts",
  "malformed_proof",
]);

export const authFailedPayloadSchema = z.object({
  reason: authFailureReasonSchema,
  connection_id: z.string().min(1).optional(),
  retry_after_ms: z.number().int().nonnegative().optional(),
});

const protocolSupportSchema = z
  .object({
    current: z.literal(PROTOCOL_VERSION),
    min_supported: z.literal(PROTOCOL_VERSION),
  })
  .strict();

const e2eSupportSchema = z
  .object({
    required: z.boolean(),
    versions: z
      .array(z.number().int().positive())
      .min(1)
      .refine((versions) => versions.includes(E2E_PROTOCOL_VERSION), {
        message: "E2E v1 support is required",
      }),
    suites: z
      .array(z.string().min(1))
      .min(1)
      .refine((suites) => suites.includes(NOISE_SUITE_NNPSK0_V1), {
        message: "Noise NNpsk0 v1 support is required",
      }),
  })
  .strict();

export const agentHelloPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    device_id: z.string().min(1),
    agent_instance_id: z.string().min(1),
    key_id: z.string().min(1),
    protocol: protocolSupportSchema,
    e2e: e2eSupportSchema,
    business_security_mode: z
      .enum(["e2e_required", "plaintext_allowed"])
      .optional(),
    hostname: z.string().min(1),
    platform: z.literal("darwin"),
    agent_version: z.string().min(1),
    providers: z.array(z.unknown()).optional(),
    workspaces: z.array(z.unknown()).optional(),
    capabilities: z.array(z.string().min(1)),
  })
  .strict();

export const mobileConnectPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    device_id: z.string().min(1),
    key_id: z.string().min(1),
    app_info: appInfoPayloadSchema,
    protocol: protocolSupportSchema,
    e2e: e2eSupportSchema,
    transport_preference: z
      .enum(["auto", "relay_only", "prefer_p2p"])
      .optional(),
  })
  .strict();

export const appNetworkChangedPayloadSchema = z
  .object({
    app_connection_id: z.string().min(1),
    reason: z.enum(["foreground_resume", "network_changed"]),
    network_type: z.string().optional(),
    is_connected: z.boolean().optional(),
    is_internet_reachable: z.boolean().optional(),
  })
  .strict();

const protocolVersionsSchema = z
  .object({
    outer_v: z.literal(PROTOCOL_VERSION),
    inner_v: z.literal(INNER_PROTOCOL_VERSION),
    e2e_v: z.literal(E2E_PROTOCOL_VERSION),
  })
  .strict();

export const appConnectionHeartbeatPayloadSchema = z
  .object({
    sent_at: isoDateTime,
    seq: z.number().int().nonnegative(),
    current_path: z.enum(["relay", "p2p", "unknown"]).optional(),
  })
  .strict();

export const appConnectionGoodbyePayloadSchema =
  appConnectionHeartbeatPayloadSchema.extend({
    reason: z.string().min(1).optional(),
  });

export const e2eHandshakeInitPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
    app_connection_id: z.string().min(1),
    handshake_id: z.string().min(1),
    key_id: z.string().min(1),
    suite: z.literal(NOISE_SUITE_NNPSK0_V1),
    app_protocol: protocolVersionsSchema,
    message: z.string().min(1),
  })
  .strict();

export const e2eHandshakeReplyPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
    app_connection_id: z.string().min(1),
    handshake_id: z.string().min(1),
    key_id: z.string().min(1),
    suite: z.literal(NOISE_SUITE_NNPSK0_V1),
    agent_protocol: protocolVersionsSchema,
    message: z.string().min(1),
  })
  .strict();

export const e2eReadyPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
    app_connection_id: z.string().min(1),
    handshake_id: z.string().min(1),
    transcript_hash: z.string().min(1),
  })
  .strict();

export const e2eMessagePayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
    app_connection_id: z.string().min(1),
    e2e_session_id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    ciphertext: z.string().min(1),
  })
  .strict();

export const e2eFailureReasonSchema = z.enum([
  "unsupported_outer_version",
  "unsupported_e2e_version",
  "unsupported_suite",
  "key_mismatch",
  "handshake_failed",
  "timeout",
  "replay_detected",
  "decrypt_failed",
]);

export const e2eFailedPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
    app_connection_id: z.string().min(1).optional(),
    handshake_id: z.string().min(1).optional(),
    reason: e2eFailureReasonSchema,
  })
  .strict();

export const protocolErrorCodeSchema = z.enum([
  "unsupported_protocol_version",
  "unsupported_message_type",
  "invalid_state",
  "schema_invalid",
  "e2e_required",
  "plaintext_business_rejected",
  "route_not_found",
]);

export const protocolErrorPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    code: protocolErrorCodeSchema,
    detail: z.string().optional(),
    retryable: z.boolean(),
  })
  .strict();

export const innerEnvelopeSchema = z
  .object({
    v: z.literal(INNER_PROTOCOL_VERSION),
    id: messageId,
    type: z.string().min(1),
    created_at: isoDateTime,
    seq: z.number().int().nonnegative().optional(),
    request_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    surface_id: z.string().min(1).optional(),
    payload: z.unknown(),
  })
  .strict();

export const terminalSizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const terminalInputPayloadSchema = z.object({
  kind: z.enum(["text", "key", "paste"]),
  data: z.string(),
});

export const terminalFramePayloadSchema = z.object({
  data: z.string(),
  snapshot: z.boolean().optional(),
  captured_at: isoDateTime.optional(),
  byte_length: z.number().int().nonnegative().optional(),
});

export const terminalSnapshotPayloadSchema = z.object({
  data: z.string(),
  size: terminalSizeSchema,
  captured_at: isoDateTime,
});

export const terminalStreamStartPayloadSchema = z
  .object({
    encoding: z.literal("utf8").optional(),
  })
  .strict();

export const terminalStreamReadyPayloadSchema = z
  .object({
    stream_id: z.string().min(1),
    encoding: z.literal("utf8"),
    started_at: isoDateTime,
  })
  .strict();

export const terminalStreamDataPayloadSchema = z
  .object({
    stream_id: z.string().min(1),
    encoding: z.literal("utf8"),
    data: z.string(),
    emitted_at: isoDateTime,
    byte_length: z.number().int().nonnegative().optional(),
  })
  .strict();

export const terminalStreamStopPayloadSchema = z
  .object({
    stream_id: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .strict();

export const terminalStreamErrorPayloadSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

export const terminalResizePayloadSchema = terminalSizeSchema;

export const terminalErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});

export const terminalAckPayloadSchema = z
  .object({
    ack_seq: z.number().int().nonnegative(),
    received_bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * 会话相关 schemas。
 *
 * 与 src/index.ts 的 `TerminalSession` / `SESSION_FIELDS` / `SESSION_REQUIRED_FIELDS`
 * 严格对齐：`terminalSessionSchema` 用 `.strict()` 拒绝额外字段，必填集合通过
 * `SESSION_REQUIRED_FIELDS` 强制；contract.test 会在跨端对账中覆盖。
 */
export const sessionStatusSchema = z.enum([...SUPPORTED_SESSION_STATUSES] as [
  string,
  ...string[],
]);

export const sessionOriginSchema = z.enum(["managed", "external"]);

const surfaceDefinitionSchema = z
  .object({
    surface_id: z.string().min(1),
    session_id: z.string().min(1),
    kind: z.enum(["terminal", "agent", "file", "diff"]),
    title: z.string(),
    status: z.enum(["active", "detached", "ended"]),
    provider: z.string().min(1).optional(),
  })
  .strict();

export const terminalSessionSchema = z
  .object({
    session_id: z.string().min(1),
    primary_surface_id: z.string().min(1),
    surfaces: z.array(surfaceDefinitionSchema).min(1),
    terminal_provider_kind: z.string().min(1),
    terminal_provider_label: z.string().min(1),
    title: z.string(),
    cwd: z.string(),
    command: z.string(),
    status: sessionStatusSchema,
    created_at: isoDateTime,
    last_active_at: isoDateTime,
    terminal_size: terminalSizeSchema,
    tmux_session_name: z.string().min(1),
    tmux_server_pid: z.number().int().positive().optional(),
    tmux_session_uid: z.string().min(1).optional(),
    workspace_path: z.string().optional(),
    workspace_name: z.string().optional(),
    git_repository: z.boolean().optional(),
    origin: sessionOriginSchema.optional(),
    registered: z.boolean().optional(),
  })
  .strict();

const terminalProviderDefinitionSchema = z
  .object({
    kind: z.string().min(1),
    displayName: z.string().min(1),
    capability: z.string().min(1),
    summary: z.string(),
    defaultCommand: z.string(),
    creatable: z.boolean(),
  })
  .strict();

export const workspaceDefinitionSchema = z
  .object({
    name: z.string().optional(),
    path: z.string().min(1),
    isGitRepository: z.boolean(),
    gitRoot: z.string().optional(),
    status: z.enum(["available", "missing", "permission_denied"]),
    source: z.enum(["tmux", "session", "recent", "default"]),
  })
  .strict();

export const sessionListPayloadSchema = z
  .object({
    sessions: z.array(terminalSessionSchema),
    default_cwd: z.string().optional(),
    providers: z.array(terminalProviderDefinitionSchema).optional(),
    workspaces: z.array(workspaceDefinitionSchema).optional(),
  })
  .strict();

export const sessionCreatePayloadSchema = z
  .object({
    terminal_provider_kind: z.string().min(1).optional(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    workspace_path: z.string().optional(),
    command: z.string().optional(),
    terminal_size: terminalSizeSchema.optional(),
  })
  .strict();

export const sessionCreatedPayloadSchema = z
  .object({
    session: terminalSessionSchema,
  })
  .strict();

export const sessionAttachPayloadSchema = z
  .object({
    session_id: z.string().min(1),
  })
  .strict();

export const sessionClosePayloadSchema = z
  .object({
    session_id: z.string().min(1),
  })
  .strict();

export const sessionRenamePayloadSchema = z
  .object({
    session_id: z.string().min(1),
    title: z.string(),
  })
  .strict();

export const sessionKillTerminalPayloadSchema = z
  .object({
    session_id: z.string().min(1),
  })
  .strict();

export const workspaceListPayloadSchema = z
  .object({
    workspaces: z.array(workspaceDefinitionSchema),
  })
  .strict();

export const workspaceStatusPayloadSchema = z
  .object({
    workspace: workspaceDefinitionSchema,
  })
  .strict();

export const filesListRequestPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().optional(),
  })
  .strict();

const workspaceFileEntrySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    relativePath: z.string(),
    type: z.enum(["file", "directory"]),
    isSymlink: z.boolean().optional(),
    size: z.number().int().nonnegative().optional(),
    modifiedAt: isoDateTime.optional(),
  })
  .strict();

export const filesListPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string(),
    entries: z.array(workspaceFileEntrySchema),
  })
  .strict();

export const filesReadRequestPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

export const filesReadPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().min(1),
    content: z.string().optional(),
    encoding: z.enum(["utf8", "binary", "too_large"]),
    size: z.number().int().nonnegative(),
    modifiedAt: isoDateTime.optional(),
    contentHash: z.string().min(1).optional(),
  })
  .strict();

export const filesWriteRequestPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().min(1),
    content: z.string(),
    encoding: z.literal("utf8"),
    baseHash: z.string().min(1),
  })
  .strict();

export const filesWritePayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().min(1),
    status: z.enum(["saved", "conflict", "unsupported"]),
    content: z.string().optional(),
    encoding: z.enum(["utf8", "binary", "too_large"]),
    size: z.number().int().nonnegative(),
    modifiedAt: isoDateTime.optional(),
    contentHash: z.string().min(1).optional(),
    baseHash: z.string().min(1).optional(),
    message: z.string().optional(),
  })
  .strict();

const workspaceGitStatusSchema = z
  .object({
    workspacePath: z.string().min(1),
    isGitRepository: z.boolean(),
    branch: z.string().optional(),
    headSha: z.string().optional(),
    ahead: z.number().int().optional(),
    behind: z.number().int().optional(),
    hasChanges: z.boolean(),
    files: z.array(
      z
        .object({
          path: z.string(),
          oldPath: z.string().optional(),
          status: z.enum([
            "modified",
            "added",
            "deleted",
            "renamed",
            "untracked",
          ]),
          indexStatus: z.string().optional(),
          worktreeStatus: z.string().optional(),
          staged: z.boolean().optional(),
          unstaged: z.boolean().optional(),
          stagedAdditions: z.number().int().nonnegative().optional(),
          stagedDeletions: z.number().int().nonnegative().optional(),
          unstagedAdditions: z.number().int().nonnegative().optional(),
          unstagedDeletions: z.number().int().nonnegative().optional(),
          additions: z.number().int().nonnegative().optional(),
          deletions: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const gitStatusRequestPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
  })
  .strict();

export const gitStatusPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    status: workspaceGitStatusSchema,
  })
  .strict();

export const gitDiffRequestPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().optional(),
    scope: z.enum(["all", "staged", "unstaged", "untracked"]).optional(),
  })
  .strict();

export const gitDiffPayloadSchema = z
  .object({
    workspacePath: z.string().min(1),
    relativePath: z.string().optional(),
    scope: z.enum(["all", "staged", "unstaged", "untracked"]).optional(),
    diff: z.string(),
  })
  .strict();

const iceServerConfigSchema = z
  .object({
    urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    username: z.string().optional(),
    credential: z.string().optional(),
  })
  .strict();

export const tunnelUpgradeProposePayloadSchema = z
  .object({
    upgrade_id: z.string().min(1),
    app_connection_id: z.string().min(1),
    ice_servers: z.array(iceServerConfigSchema),
    role: z.enum(["offerer", "answerer"]),
    strict: z.boolean().optional(),
  })
  .strict();

export const tunnelUpgradeOfferPayloadSchema = z
  .object({
    upgrade_id: z.string().min(1),
    app_connection_id: z.string().min(1),
    sdp: z.string(),
  })
  .strict();

export const tunnelUpgradeAnswerPayloadSchema =
  tunnelUpgradeOfferPayloadSchema;

export const tunnelUpgradeCandidatePayloadSchema = z
  .object({
    upgrade_id: z.string().min(1),
    app_connection_id: z.string().min(1),
    candidate: z.string(),
    sdp_mid: z.string().nullable(),
    sdp_mline_index: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const tunnelUpgradeCommittedPayloadSchema = z
  .object({
    upgrade_id: z.string().min(1),
    app_connection_id: z.string().min(1),
  })
  .strict();

export const tunnelUpgradeDowngradePayloadSchema =
  tunnelUpgradeCommittedPayloadSchema.extend({
    reason: z.string(),
  });

export const transportPingPayloadSchema = z
  .object({
    upgrade_id: z.string().min(1).optional(),
    seq: z.number().int().nonnegative(),
    sent_at: isoDateTime,
  })
  .strict();

export const transportPongPayloadSchema = transportPingPayloadSchema.extend({
  received_at: isoDateTime,
});

const payloadSchemaByType = {
  "agent.hello": agentHelloPayloadSchema,
  "mobile.connect": mobileConnectPayloadSchema,
  "auth.challenge": authChallengePayloadSchema,
  "auth.proof": authProofPayloadSchema,
  "auth.verify": authVerifyPayloadSchema,
  "auth.ok": authOkPayloadSchema,
  "auth.failed": authFailedPayloadSchema,
  "app.network.changed": appNetworkChangedPayloadSchema,
  "app.connection.heartbeat": appConnectionHeartbeatPayloadSchema,
  "app.connection.goodbye": appConnectionGoodbyePayloadSchema,
  "e2e.handshake.init": e2eHandshakeInitPayloadSchema,
  "e2e.handshake.reply": e2eHandshakeReplyPayloadSchema,
  "e2e.ready": e2eReadyPayloadSchema,
  "e2e.message": e2eMessagePayloadSchema,
  "e2e.failed": e2eFailedPayloadSchema,
  "protocol.error": protocolErrorPayloadSchema,
  "session.list": z.union([emptyPayloadSchema, sessionListPayloadSchema]),
  "session.create": sessionCreatePayloadSchema,
  "session.rename": sessionRenamePayloadSchema,
  "session.close": sessionClosePayloadSchema,
  "session.kill_terminal": sessionKillTerminalPayloadSchema,
  "session.attach": sessionAttachPayloadSchema,
  "session.status": sessionCreatedPayloadSchema,
  "workspace.list": z.union([emptyPayloadSchema, workspaceListPayloadSchema]),
  "workspace.status": workspaceStatusPayloadSchema,
  "files.list": z.union([filesListRequestPayloadSchema, filesListPayloadSchema]),
  "files.read": z.union([filesReadRequestPayloadSchema, filesReadPayloadSchema]),
  "files.write": z.union([
    filesWriteRequestPayloadSchema,
    filesWritePayloadSchema,
  ]),
  "git.status": z.union([gitStatusRequestPayloadSchema, gitStatusPayloadSchema]),
  "git.diff": z.union([gitDiffRequestPayloadSchema, gitDiffPayloadSchema]),
  "terminal.frame": terminalFramePayloadSchema,
  "terminal.input": terminalInputPayloadSchema,
  "terminal.resize": terminalResizePayloadSchema,
  "terminal.snapshot": z.union([emptyPayloadSchema, terminalSnapshotPayloadSchema]),
  "terminal.stream.start": terminalStreamStartPayloadSchema,
  "terminal.stream.ready": terminalStreamReadyPayloadSchema,
  "terminal.stream.data": terminalStreamDataPayloadSchema,
  "terminal.stream.stop": terminalStreamStopPayloadSchema,
  "terminal.stream.error": terminalStreamErrorPayloadSchema,
  "terminal.ack": terminalAckPayloadSchema,
  "terminal.error": terminalErrorPayloadSchema,
  "tunnel.upgrade.propose": tunnelUpgradeProposePayloadSchema,
  "tunnel.upgrade.offer": tunnelUpgradeOfferPayloadSchema,
  "tunnel.upgrade.answer": tunnelUpgradeAnswerPayloadSchema,
  "tunnel.upgrade.candidate": tunnelUpgradeCandidatePayloadSchema,
  "tunnel.upgrade.committed": tunnelUpgradeCommittedPayloadSchema,
  "tunnel.upgrade.downgrade": tunnelUpgradeDowngradePayloadSchema,
  "transport.ping": transportPingPayloadSchema,
  "transport.pong": transportPongPayloadSchema,
} satisfies Partial<Record<MessageType, z.ZodType<unknown>>>;

export function parseMessageEnvelope(input: unknown): MessageEnvelope | null {
  const envelopeResult = messageEnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) {
    return null;
  }

  const envelope = envelopeResult.data;
  const payloadSchema = (
    payloadSchemaByType as Partial<Record<MessageType, z.ZodType<unknown>>>
  )[envelope.type];
  if (!payloadSchema) {
    return envelope as MessageEnvelope;
  }

  const payloadResult = payloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    return null;
  }

  return {
    ...envelope,
    payload: payloadResult.data,
  } as MessageEnvelope;
}
