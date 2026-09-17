export const PROTOCOL_VERSION = 2 as const;
export const E2E_PROTOCOL_VERSION = 2 as const;
export const INNER_PROTOCOL_VERSION = 1 as const;
export const SIGNED_X25519_SUITE_V2 =
  "OmniWork_SignedX25519_ChaChaPoly_SHA256_v2" as const;
export const E2E_SIGNED_X25519_CAPABILITY_V2 =
  "e2e.signed-x25519.v2" as const;
export const TERMINAL_STREAM_CAPABILITY_V1 = "terminal.stream.v1" as const;
export const PAIRING_LINK_SCHEME = "omniwork" as const;
export const PAIRING_LINK_HOST = "pair" as const;
export const RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE = 4402 as const;
export const RELAY_AGENT_SHUTDOWN_CLOSE_CODE = 4404 as const;
export const RELAY_AGENT_DISABLED_CLOSE_REASON = "agent_disabled" as const;
export const RELAY_AGENT_IP_BANNED_CLOSE_REASON = "ip_banned" as const;
export const RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON =
  "agent_approval_required" as const;
export const RELAY_AGENT_SUPERSEDED_CLOSE_REASON = "agent_superseded" as const;

/**
 * Agent 启动期 session store 的"应当被持久化保留"的 status 白名单。
 *
 * 放在 constants.ts 而非 index.ts，避免 schemas.ts ↔ index.ts 的循环依赖
 * 在运行时触发 TDZ。`SessionStatus` 类型仍在 index.ts 中定义，并通过
 * `as const satisfies readonly SessionStatus[]` 与本数组校验。
 */
export const SUPPORTED_SESSION_STATUSES = [
  "created",
  "starting",
  "running",
  "detached",
  "exited",
  "archived",
] as const;
