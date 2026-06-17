import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

import {
  PAIRING_LINK_HOST,
  PAIRING_LINK_SCHEME,
  PROTOCOL_VERSION,
} from "./constants.ts";
import type { PairingLinkPayload } from "./index.ts";

export type PairingQrSource = "ios" | "android" | "agent";

export interface EncryptedPairingLinkEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: "pairing_qr_encrypted";
  alg: "CHACHA20-POLY1305";
  kdf: "SHA256";
  salt: string;
  nonce: string;
  source: PairingQrSource;
  iat: number;
  exp: number;
  ct: string;
}

export interface CreateEncryptedPairingLinkOptions {
  source: PairingQrSource;
  nowMs?: number;
  ttlMs?: number;
}

export interface EncryptedPairingShare {
  link: string;
  password: string;
  expiresAt: Date;
  envelope: EncryptedPairingLinkEnvelope;
}

export type PairingLinkDecryptErrorCode =
  | "invalid_format"
  | "invalid_password"
  | "expired";

export class PairingLinkDecryptError extends Error {
  readonly code: PairingLinkDecryptErrorCode;

  constructor(code: PairingLinkDecryptErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PairingLinkDecryptError";
  }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const PAYLOAD_NONCE_LEN = 18;

export function createEncryptedPairingShare(
  payload: PairingLinkPayload,
  options: CreateEncryptedPairingLinkOptions,
): EncryptedPairingShare {
  const password = createPairingPassword();
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const envelope = encryptPairingLink(payload, password, {
    ...options,
    nowMs,
    ttlMs,
  });
  return {
    link: createEncryptedPairingLink(envelope),
    password,
    expiresAt: new Date(nowMs + ttlMs),
    envelope,
  };
}

export function encryptPairingLink(
  payload: PairingLinkPayload,
  password: string,
  options: CreateEncryptedPairingLinkOptions,
): EncryptedPairingLinkEnvelope {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + ttlMs) / 1000);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const inner = {
    source: options.source,
    iat,
    exp,
    nonce: toBase64Url(randomBytes(PAYLOAD_NONCE_LEN)),
    payload,
  };
  const key = deriveKey(password, salt);
  const aad = pairingAad(options.source, iat, exp);
  const cipher = chacha20poly1305(key, nonce, aad);
  const ciphertext = cipher.encrypt(encodeUtf8(JSON.stringify(inner)));

  return {
    v: PROTOCOL_VERSION,
    kind: "pairing_qr_encrypted",
    alg: "CHACHA20-POLY1305",
    kdf: "SHA256",
    salt: toBase64Url(salt),
    nonce: toBase64Url(nonce),
    source: options.source,
    iat,
    exp,
    ct: toBase64Url(ciphertext),
  };
}

export function createEncryptedPairingLink(
  envelope: EncryptedPairingLinkEnvelope,
): string {
  const params = new URLSearchParams();
  params.set("v", String(envelope.v));
  params.set("kind", envelope.kind);
  params.set("alg", envelope.alg);
  params.set("kdf", envelope.kdf);
  params.set("salt", envelope.salt);
  params.set("nonce", envelope.nonce);
  params.set("source", envelope.source);
  params.set("iat", String(envelope.iat));
  params.set("exp", String(envelope.exp));
  params.set("ct", envelope.ct);
  return `${PAIRING_LINK_SCHEME}://${PAIRING_LINK_HOST}?${params.toString()}`;
}

export function decryptPairingLink(
  input: string,
  password: string,
  nowMs = Date.now(),
): PairingLinkPayload {
  const envelope = parseEncryptedPairingLink(input);
  if (!envelope) {
    throw new PairingLinkDecryptError(
      "invalid_format",
      "Pairing link is not an encrypted OmniWork QR code.",
    );
  }
  if (Math.floor(nowMs / 1000) > envelope.exp) {
    throw new PairingLinkDecryptError("expired", "Pairing QR code expired.");
  }

  const key = deriveKey(password, fromBase64Url(envelope.salt));
  const aad = pairingAad(envelope.source, envelope.iat, envelope.exp);
  try {
    const cipher = chacha20poly1305(
      key,
      fromBase64Url(envelope.nonce),
      aad,
    );
    const plaintext = cipher.decrypt(fromBase64Url(envelope.ct));
    const decoded = JSON.parse(decodeUtf8(plaintext)) as {
      source?: unknown;
      iat?: unknown;
      exp?: unknown;
      payload?: unknown;
    };
    if (
      decoded.source !== envelope.source ||
      decoded.iat !== envelope.iat ||
      decoded.exp !== envelope.exp ||
      !isPairingLinkPayload(decoded.payload)
    ) {
      throw new Error("Decrypted pairing payload does not match envelope.");
    }
    return decoded.payload;
  } catch (error) {
    throw new PairingLinkDecryptError(
      "invalid_password",
      error instanceof Error
        ? error.message
        : "Unable to decrypt pairing QR code.",
    );
  }
}

export function parseEncryptedPairingLink(
  input: string,
): EncryptedPairingLinkEnvelope | null {
  const query = extractPairingQuery(input);
  if (!query) {
    return null;
  }
  const params = new URLSearchParams(query);
  const envelope: EncryptedPairingLinkEnvelope = {
    v: PROTOCOL_VERSION,
    kind: "pairing_qr_encrypted",
    alg: "CHACHA20-POLY1305",
    kdf: "SHA256",
    salt: params.get("salt")?.trim() ?? "",
    nonce: params.get("nonce")?.trim() ?? "",
    source: params.get("source") as PairingQrSource,
    iat: Number(params.get("iat")),
    exp: Number(params.get("exp")),
    ct: params.get("ct")?.trim() ?? "",
  };

  if (
    Number(params.get("v")) !== PROTOCOL_VERSION ||
    params.get("kind") !== envelope.kind ||
    params.get("alg") !== envelope.alg ||
    params.get("kdf") !== envelope.kdf ||
    !isPairingQrSource(envelope.source) ||
    !Number.isInteger(envelope.iat) ||
    !Number.isInteger(envelope.exp) ||
    envelope.exp < envelope.iat ||
    !envelope.salt ||
    !envelope.nonce ||
    !envelope.ct
  ) {
    return null;
  }

  return envelope;
}

export function createPairingPassword(): string {
  while (true) {
    const bytes = randomBytes(2);
    const value = (bytes[0] << 8) | bytes[1];
    if (value < 60_000) {
      return String(value % 10_000).padStart(4, "0");
    }
  }
}

function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return sha256(
    concat(
      encodeUtf8("omniwork:pairing-qr-pin-key:v1"),
      new Uint8Array([0]),
      salt,
      new Uint8Array([0]),
      encodeUtf8(password),
    ),
  );
}

function pairingAad(
  source: PairingQrSource,
  iat: number,
  exp: number,
): Uint8Array {
  return encodeUtf8(`omniwork:pairing-qr:v1:${source}:${iat}:${exp}`);
}

function isPairingQrSource(value: unknown): value is PairingQrSource {
  return value === "ios" || value === "android" || value === "agent";
}

function isPairingLinkPayload(value: unknown): value is PairingLinkPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<PairingLinkPayload>;
  return (
    payload.v === PROTOCOL_VERSION &&
    typeof payload.relay_url === "string" &&
    payload.relay_url.length > 0 &&
    typeof payload.device_id === "string" &&
    payload.device_id.length > 0 &&
    typeof payload.key === "string" &&
    payload.key.length > 0 &&
    (payload.display_name === undefined ||
      typeof payload.display_name === "string") &&
    (payload.key_id === undefined || typeof payload.key_id === "string")
  );
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (
      codePoint >= 0xd800 &&
      codePoint <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(value: Uint8Array): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const first = value[index];
    if ((first & 0x80) === 0) {
      result += String.fromCharCode(first);
      index += 1;
      continue;
    }
    if ((first & 0xe0) === 0xc0) {
      result += String.fromCharCode(
        ((first & 0x1f) << 6) | (value[index + 1] & 0x3f),
      );
      index += 2;
      continue;
    }
    if ((first & 0xf0) === 0xe0) {
      result += String.fromCharCode(
        ((first & 0x0f) << 12) |
          ((value[index + 1] & 0x3f) << 6) |
          (value[index + 2] & 0x3f),
      );
      index += 3;
      continue;
    }
    const codePoint =
      ((first & 0x07) << 18) |
      ((value[index + 1] & 0x3f) << 12) |
      ((value[index + 2] & 0x3f) << 6) |
      (value[index + 3] & 0x3f);
    const adjusted = codePoint - 0x10000;
    result += String.fromCharCode(
      0xd800 | (adjusted >> 10),
      0xdc00 | (adjusted & 0x3ff),
    );
    index += 4;
  }
  return result;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64Url(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index];
    const second = value[index + 1];
    const third = value[index + 2];
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output +=
      second === undefined
        ? "="
        : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : BASE64_ALPHABET[third & 63];
  }
  return output.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const chunk = padded.slice(index, index + 4);
    const first = base64Index(chunk[0]);
    const second = base64Index(chunk[1]);
    const third = chunk[2] === "=" ? 0 : base64Index(chunk[2]);
    const fourth = chunk[3] === "=" ? 0 : base64Index(chunk[3]);
    bytes.push((first << 2) | (second >> 4));
    if (chunk[2] !== "=") {
      bytes.push(((second & 15) << 4) | (third >> 2));
    }
    if (chunk[3] !== "=") {
      bytes.push(((third & 3) << 6) | fourth);
    }
  }
  return new Uint8Array(bytes);
}

function base64Index(value: string): number {
  const index = BASE64_ALPHABET.indexOf(value);
  if (index < 0) {
    throw new Error("Invalid base64url value.");
  }
  return index;
}
