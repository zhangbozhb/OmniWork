/**
 * Zod schemas for the OmniWork wire protocol.
 *
 * Goal: 在 TypeScript 类型之外，再为关键报文提供运行时校验来源。
 * 范围：当前覆盖跨端最频繁、最敏感的 envelope + 鉴权 + 终端三类报文，
 * 后续可逐步补全其余 message_type。其余类型仍在 src/index.ts 中维护，
 * 本文件不做重复声明，避免双向漂移。
 */
import { z } from "zod";

import { PROTOCOL_VERSION } from "./constants.ts";

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
