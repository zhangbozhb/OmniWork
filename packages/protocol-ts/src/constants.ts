export const PROTOCOL_VERSION = 1 as const;
export const E2E_PROTOCOL_VERSION = 1 as const;
export const INNER_PROTOCOL_VERSION = 1 as const;
export const NOISE_SUITE_NNPSK0_V1 =
  "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s" as const;
export const E2E_NOISE_NNPSK0_CAPABILITY_V1 =
  "e2e.noise.nnpsk0.v1" as const;
export const ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1 =
  "business.encrypted-only.v1" as const;
export const PAIRING_LINK_SCHEME = "omniwork" as const;
export const PAIRING_LINK_HOST = "pair" as const;

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
