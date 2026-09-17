import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const IDENTITY_ALGORITHM = "Ed25519" as const;
export const IDENTITY_VERSION = 1 as const;

export type IdentityRole = "agent" | "app";

export interface IdentityKeyPair {
  version: typeof IDENTITY_VERSION;
  role: IdentityRole;
  algorithm: typeof IDENTITY_ALGORITHM;
  id: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ID_BODY_BYTES = 20;
const ID_BODY_CHARS = 32;
const ID_CHECKSUM_CHARS = 4;
const ID_PAYLOAD_CHARS = ID_BODY_CHARS + ID_CHECKSUM_CHARS;

export function generateIdentityKeyPair(
  role: IdentityRole,
  now = new Date(),
): IdentityKeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  const encodedPublicKey = toBase64Url(publicKey);
  return {
    version: IDENTITY_VERSION,
    role,
    algorithm: IDENTITY_ALGORITHM,
    id: deriveIdentityId(role, encodedPublicKey),
    publicKey: encodedPublicKey,
    privateKey: toBase64Url(secretKey),
    createdAt: now.toISOString(),
  };
}

export function deriveIdentityPublicKey(privateKey: string): string {
  const secretKey = fromBase64Url(privateKey);
  if (!ed25519.utils.isValidSecretKey(secretKey)) {
    throw new Error("Invalid Ed25519 private key.");
  }
  return toBase64Url(ed25519.getPublicKey(secretKey));
}

export function deriveIdentityId(
  role: IdentityRole,
  publicKey: string,
): string {
  const publicKeyBytes = fromBase64Url(publicKey);
  if (
    publicKeyBytes.byteLength !== ed25519.lengths.publicKey ||
    !ed25519.utils.isValidPublicKey(publicKeyBytes, false)
  ) {
    throw new Error("Invalid Ed25519 public key.");
  }

  const prefix = identityPrefix(role);
  const digest = sha256(
    concat(
      utf8("omniwork-identity-v1"),
      new Uint8Array([0]),
      utf8(role),
      new Uint8Array([0]),
      utf8(IDENTITY_ALGORITHM.toLowerCase()),
      new Uint8Array([0]),
      publicKeyBytes,
    ),
  );
  const body = toCrockfordBase32(digest.subarray(0, ID_BODY_BYTES));
  const checksumDigest = sha256(
    concat(
      utf8("omniwork-id-check-v1"),
      new Uint8Array([0]),
      utf8(prefix),
      new Uint8Array([0]),
      utf8(body),
    ),
  );
  const checksum = toCrockfordBase32(checksumDigest).slice(
    0,
    ID_CHECKSUM_CHARS,
  );
  return formatIdentityId(prefix, body + checksum);
}

export function normalizeIdentityId(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[\s-]+/gu, "");
  if (compact.length !== 4 + ID_PAYLOAD_CHARS) {
    return null;
  }
  const prefix = compact.slice(0, 4);
  if (prefix !== "DEV1" && prefix !== "APP1") {
    return null;
  }
  const payload = compact.slice(4);
  if (
    payload.length !== ID_PAYLOAD_CHARS ||
    [...payload].some((character) => !BASE32_ALPHABET.includes(character))
  ) {
    return null;
  }
  const body = payload.slice(0, ID_BODY_CHARS);
  const expectedChecksum = toCrockfordBase32(
    sha256(
      concat(
        utf8("omniwork-id-check-v1"),
        new Uint8Array([0]),
        utf8(prefix),
        new Uint8Array([0]),
        utf8(body),
      ),
    ),
  ).slice(0, ID_CHECKSUM_CHARS);
  if (payload.slice(ID_BODY_CHARS) !== expectedChecksum) {
    return null;
  }
  return formatIdentityId(prefix, payload);
}

export function isValidIdentityId(
  value: string,
  role?: IdentityRole,
): boolean {
  const normalized = normalizeIdentityId(value);
  return (
    normalized !== null &&
    (role === undefined || normalized.startsWith(`${identityPrefix(role)}-`))
  );
}

export function identityMatchesPublicKey(
  role: IdentityRole,
  id: string,
  publicKey: string,
): boolean {
  const normalized = normalizeIdentityId(id);
  if (!normalized) {
    return false;
  }
  try {
    return normalized === deriveIdentityId(role, publicKey);
  } catch {
    return false;
  }
}

export function validateIdentityKeyPair(
  identity: IdentityKeyPair,
  expectedRole?: IdentityRole,
): boolean {
  if (
    identity.version !== IDENTITY_VERSION ||
    identity.algorithm !== IDENTITY_ALGORITHM ||
    (expectedRole !== undefined && identity.role !== expectedRole)
  ) {
    return false;
  }
  try {
    const publicKey = deriveIdentityPublicKey(identity.privateKey);
    return (
      publicKey === identity.publicKey &&
      deriveIdentityId(identity.role, publicKey) === identity.id
    );
  } catch {
    return false;
  }
}

export function signIdentityFields(
  privateKey: string,
  domain: string,
  fields: readonly string[],
): string {
  const secretKey = fromBase64Url(privateKey);
  if (!ed25519.utils.isValidSecretKey(secretKey)) {
    throw new Error("Invalid Ed25519 private key.");
  }
  return toBase64Url(
    ed25519.sign(createIdentitySignaturePayload(domain, fields), secretKey),
  );
}

export function verifyIdentityFields(
  publicKey: string,
  domain: string,
  fields: readonly string[],
  signature: string,
): boolean {
  try {
    const publicKeyBytes = fromBase64Url(publicKey);
    const signatureBytes = fromBase64Url(signature);
    return (
      publicKeyBytes.byteLength === ed25519.lengths.publicKey &&
      signatureBytes.byteLength === 64 &&
      ed25519.verify(
        signatureBytes,
        createIdentitySignaturePayload(domain, fields),
        publicKeyBytes,
        { zip215: false },
      )
    );
  } catch {
    return false;
  }
}

export function toBase64Url(value: Uint8Array): string {
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

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url value.");
  }
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

function identityPrefix(role: IdentityRole): "DEV1" | "APP1" {
  return role === "agent" ? "DEV1" : "APP1";
}

function formatIdentityId(prefix: string, payload: string): string {
  const groups = payload.match(/.{1,6}/gu);
  if (!groups || groups.join("").length !== ID_PAYLOAD_CHARS) {
    throw new Error("Invalid identity payload.");
  }
  return `${prefix}-${groups.join("-")}`;
}

export function createIdentitySignaturePayload(
  domain: string,
  fields: readonly string[],
): Uint8Array {
  if (!/^[a-z0-9_.-]+$/u.test(domain)) {
    throw new Error("Identity signature domain is invalid.");
  }
  return utf8(JSON.stringify([`omniwork:${domain}:v1`, ...fields]));
}

function toCrockfordBase32(value: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

function base64Index(value: string): number {
  const index = BASE64_ALPHABET.indexOf(value);
  if (index < 0) {
    throw new Error("Invalid base64url value.");
  }
  return index;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
