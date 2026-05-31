/**
 * Zod schemas for the OmniWork wire protocol.
 *
 * Goal: 在 TypeScript 类型之外，再为关键报文提供运行时校验来源。
 * 范围：当前覆盖跨端最频繁、最敏感的 envelope + 鉴权 + 终端 + 会话四类报文，
 * 后续可逐步补全其余 message_type。其余类型仍在 src/index.ts 中维护，
 * 本文件不做重复声明，避免双向漂移。
 */
import { z } from "zod";

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

/**
 * 通用信封 schema，仅校验跨端通信都依赖的元字段，payload 留给具体消息 schema。
 */
export const messageEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: messageId,
  type: z.string().min(1),
  device_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
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

export const authProofPayloadSchema = z.object({
  key_id: z.string().min(1),
  nonce: z.string().min(1),
  proof: z.string().min(1),
});

export const authVerifyPayloadSchema = authProofPayloadSchema.extend({
  connection_id: z.string().min(1).optional(),
});

export const authOkPayloadSchema = z.object({
  agent_instance_id: z.string().min(1),
  connection_id: z.string().min(1).optional(),
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
    required: z.literal(true),
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
    protocol: protocolSupportSchema,
    e2e: e2eSupportSchema,
    transport_preference: z
      .enum(["auto", "relay_only", "prefer_p2p"])
      .optional(),
  })
  .strict();

const protocolVersionsSchema = z
  .object({
    outer_v: z.literal(PROTOCOL_VERSION),
    inner_v: z.literal(INNER_PROTOCOL_VERSION),
    e2e_v: z.literal(E2E_PROTOCOL_VERSION),
  })
  .strict();

export const e2eHandshakeInitPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
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
    handshake_id: z.string().min(1),
    transcript_hash: z.string().min(1),
  })
  .strict();

export const e2eMessagePayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    e2e_version: z.literal(E2E_PROTOCOL_VERSION),
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
    request_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
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
});

export const terminalSnapshotPayloadSchema = z.object({
  data: z.string(),
  size: terminalSizeSchema,
  captured_at: isoDateTime,
});

export const terminalResizePayloadSchema = terminalSizeSchema;

export const terminalErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});

/**
 * 会话相关 schemas。
 *
 * 与 src/index.ts 的 `CodexSession` / `SESSION_FIELDS` / `SESSION_REQUIRED_FIELDS`
 * 严格对齐：`codexSessionSchema` 用 `.strict()` 拒绝额外字段，必填集合通过
 * `SESSION_REQUIRED_FIELDS` 强制；contract.test 会在跨端对账中覆盖。
 */
export const sessionStatusSchema = z.enum([...SUPPORTED_SESSION_STATUSES] as [
  string,
  ...string[],
]);

export const sessionOriginSchema = z.enum(["managed", "external"]);

export const codexSessionSchema = z
  .object({
    session_id: z.string().min(1),
    runtime_kind: z.string().min(1),
    runtime_label: z.string().min(1),
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

const agentProviderDefinitionSchema = z
  .object({
    kind: z.string().min(1),
    displayName: z.string().min(1),
    capability: z.string().min(1),
    summary: z.string(),
    defaultCommand: z.string(),
    creatable: z.boolean(),
  })
  .strict();

const workspaceDefinitionSchema = z
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
    sessions: z.array(codexSessionSchema),
    default_cwd: z.string().optional(),
    providers: z.array(agentProviderDefinitionSchema).optional(),
    workspaces: z.array(workspaceDefinitionSchema).optional(),
  })
  .strict();

export const sessionCreatePayloadSchema = z
  .object({
    runtime_kind: z.string().min(1).optional(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    workspace_path: z.string().optional(),
    command: z.string().optional(),
    terminal_size: terminalSizeSchema.optional(),
  })
  .strict();

export const sessionCreatedPayloadSchema = z
  .object({
    session: codexSessionSchema,
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

export const sessionKillTmuxPayloadSchema = z
  .object({
    session_id: z.string().min(1),
  })
  .strict();
