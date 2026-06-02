import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s as nobleBlake2s } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  E2E_PROTOCOL_VERSION,
  INNER_PROTOCOL_VERSION,
  NOISE_SUITE_NNPSK0_V1,
  PROTOCOL_VERSION,
  type E2EMessagePayload,
  type InnerEnvelope,
} from "@omniwork/protocol-ts";

const HASHLEN = 32;
const DH_LEN = 32;
const AEAD_TAG_LEN = 16;
const PROTOCOL_NAME = "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s";
const PSK_SALT = "omniwork:pairing-key:v1";
const PSK_INFO_PREFIX = "omniwork:e2e-noise-psk:v1";
const MESSAGE_AAD_PREFIX = "omniwork:e2e-message:v1";

export type NoiseRole = "initiator" | "responder";

export type E2ENoiseErrorCode =
  | "invalid_handshake_message"
  | "handshake_failed"
  | "decrypt_failed"
  | "replay_detected"
  | "unsupported_suite";

export class E2ENoiseError extends Error {
  readonly code: E2ENoiseErrorCode;

  constructor(code: E2ENoiseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "E2ENoiseError";
  }
}

export interface NoiseContext {
  pairingKey: string;
  deviceId: string;
  keyId: string;
  agentInstanceId: string;
  appConnectionId: string;
  handshakeId?: string;
}

export interface HandshakeInit {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  handshake_id: string;
  key_id: string;
  suite: typeof NOISE_SUITE_NNPSK0_V1;
  app_protocol: {
    outer_v: typeof PROTOCOL_VERSION;
    inner_v: typeof INNER_PROTOCOL_VERSION;
    e2e_v: typeof E2E_PROTOCOL_VERSION;
  };
  message: string;
}

export interface HandshakeReply {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  handshake_id: string;
  key_id: string;
  suite: typeof NOISE_SUITE_NNPSK0_V1;
  agent_protocol: {
    outer_v: typeof PROTOCOL_VERSION;
    inner_v: typeof INNER_PROTOCOL_VERSION;
    e2e_v: typeof E2E_PROTOCOL_VERSION;
  };
  message: string;
}

export interface ReadyPayload {
  v: typeof PROTOCOL_VERSION;
  e2e_version: typeof E2E_PROTOCOL_VERSION;
  app_connection_id: string;
  handshake_id: string;
  transcript_hash: string;
}

export interface InitiatorHandshakeState {
  init: HandshakeInit;
  complete(reply: HandshakeReply): E2ENoiseSession;
}

export interface ResponderHandshakeResult {
  reply: HandshakeReply;
  session: E2ENoiseSession;
}

export interface EncryptedFrame {
  payload: E2EMessagePayload;
  plaintextBytes: number;
}

interface SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
}

interface X25519KeyPair {
  privateKey: Uint8Array;
  publicRaw: Uint8Array;
}

export function createInitiatorHandshake(
  context: NoiseContext,
): InitiatorHandshakeState {
  const handshakeId = context.handshakeId ?? createId("e2e_hs");
  const state = initializeSymmetric(context);
  const localEphemeral = generateX25519KeyPair();
  mixHash(state, localEphemeral.publicRaw);

  const init: HandshakeInit = {
    v: PROTOCOL_VERSION,
    e2e_version: E2E_PROTOCOL_VERSION,
    app_connection_id: context.appConnectionId,
    handshake_id: handshakeId,
    key_id: context.keyId,
    suite: NOISE_SUITE_NNPSK0_V1,
    app_protocol: {
      outer_v: PROTOCOL_VERSION,
      inner_v: INNER_PROTOCOL_VERSION,
      e2e_v: E2E_PROTOCOL_VERSION,
    },
    message: toBase64Url(localEphemeral.publicRaw),
  };

  return {
    init,
    complete(reply: HandshakeReply): E2ENoiseSession {
      assertSuite(reply.suite);
      if (
        reply.handshake_id !== handshakeId ||
        reply.app_connection_id !== context.appConnectionId ||
        reply.key_id !== context.keyId ||
        reply.e2e_version !== E2E_PROTOCOL_VERSION
      ) {
        throw new E2ENoiseError(
          "handshake_failed",
          "Handshake reply does not match the initiator context.",
        );
      }

      const remotePublic = fromBase64Url(reply.message);
      assertDhMessage(remotePublic);
      mixHash(state, remotePublic);
      mixKey(state, dh(localEphemeral.privateKey, remotePublic));
      const [initiatorKey, responderKey] = split(state);

      return new E2ENoiseSession({
        role: "initiator",
        handshakeId,
        sessionId: deriveSessionId(state.hash),
        appConnectionId: context.appConnectionId,
        transcriptHash: toBase64Url(state.hash),
        txKey: initiatorKey,
        rxKey: responderKey,
      });
    },
  };
}

export function acceptInitiatorHandshake(
  context: NoiseContext,
  init: HandshakeInit,
): ResponderHandshakeResult {
  assertSuite(init.suite);
  if (
    init.key_id !== context.keyId ||
    init.app_connection_id !== context.appConnectionId ||
    init.e2e_version !== E2E_PROTOCOL_VERSION
  ) {
    throw new E2ENoiseError(
      "handshake_failed",
      "Handshake init does not match the responder context.",
    );
  }

  const remotePublic = fromBase64Url(init.message);
  assertDhMessage(remotePublic);

  const state = initializeSymmetric({
    ...context,
    handshakeId: init.handshake_id,
  });
  mixHash(state, remotePublic);

  const localEphemeral = generateX25519KeyPair();
  mixHash(state, localEphemeral.publicRaw);
  mixKey(state, dh(localEphemeral.privateKey, remotePublic));
  const [initiatorKey, responderKey] = split(state);

  const reply: HandshakeReply = {
    v: PROTOCOL_VERSION,
    e2e_version: E2E_PROTOCOL_VERSION,
    app_connection_id: context.appConnectionId,
    handshake_id: init.handshake_id,
    key_id: context.keyId,
    suite: NOISE_SUITE_NNPSK0_V1,
    agent_protocol: {
      outer_v: PROTOCOL_VERSION,
      inner_v: INNER_PROTOCOL_VERSION,
      e2e_v: E2E_PROTOCOL_VERSION,
    },
    message: toBase64Url(localEphemeral.publicRaw),
  };

  return {
    reply,
    session: new E2ENoiseSession({
      role: "responder",
      handshakeId: init.handshake_id,
      sessionId: deriveSessionId(state.hash),
      appConnectionId: context.appConnectionId,
      transcriptHash: toBase64Url(state.hash),
      txKey: responderKey,
      rxKey: initiatorKey,
    }),
  };
}

export class E2ENoiseSession {
  readonly role: NoiseRole;
  readonly handshakeId: string;
  readonly sessionId: string;
  readonly appConnectionId: string;
  readonly transcriptHash: string;
  private readonly options: {
    role: NoiseRole;
    handshakeId: string;
    sessionId: string;
    appConnectionId: string;
    transcriptHash: string;
    txKey: Uint8Array;
    rxKey: Uint8Array;
  };

  private txSeq = 0;
  private expectedRxSeq = 1;

  constructor(options: {
    role: NoiseRole;
    handshakeId: string;
    sessionId: string;
    appConnectionId: string;
    transcriptHash: string;
    txKey: Uint8Array;
    rxKey: Uint8Array;
  }) {
    this.options = options;
    this.role = options.role;
    this.handshakeId = options.handshakeId;
    this.sessionId = options.sessionId;
    this.appConnectionId = options.appConnectionId;
    this.transcriptHash = options.transcriptHash;
  }

  readyPayload(): ReadyPayload {
    return {
      v: PROTOCOL_VERSION,
      e2e_version: E2E_PROTOCOL_VERSION,
      app_connection_id: this.appConnectionId,
      handshake_id: this.handshakeId,
      transcript_hash: this.transcriptHash,
    };
  }

  encrypt(inner: InnerEnvelope): EncryptedFrame {
    const seq = ++this.txSeq;
    const plaintext = encode(JSON.stringify(inner));
    const cipher = chacha20poly1305(
      this.options.txKey,
      nonceFromSeq(seq),
      this.messageAad(seq, "tx"),
    );
    const ciphertext = cipher.encrypt(plaintext);

    return {
      plaintextBytes: plaintext.byteLength,
      payload: {
        v: PROTOCOL_VERSION,
        e2e_version: E2E_PROTOCOL_VERSION,
        app_connection_id: this.appConnectionId,
        e2e_session_id: this.sessionId,
        seq,
        ciphertext: toBase64Url(ciphertext),
      },
    };
  }

  decrypt(payload: E2EMessagePayload): InnerEnvelope {
    if (payload.e2e_session_id !== this.sessionId) {
      throw new E2ENoiseError(
        "decrypt_failed",
        "E2E session id does not match this Noise session.",
      );
    }
    if (payload.app_connection_id !== this.appConnectionId) {
      throw new E2ENoiseError(
        "decrypt_failed",
        "App connection id does not match this Noise session.",
      );
    }
    if (payload.seq !== this.expectedRxSeq) {
      throw new E2ENoiseError(
        "replay_detected",
        `Unexpected E2E sequence ${payload.seq}; expected ${this.expectedRxSeq}.`,
      );
    }

    const frame = fromBase64Url(payload.ciphertext);
    if (frame.byteLength < AEAD_TAG_LEN) {
      throw new E2ENoiseError(
        "decrypt_failed",
        "Ciphertext frame is too short.",
      );
    }

    try {
      const decipher = chacha20poly1305(
        this.options.rxKey,
        nonceFromSeq(payload.seq),
        this.messageAad(payload.seq, "rx"),
      );
      const plaintext = decipher.decrypt(frame);
      const decoded = JSON.parse(decodeUtf8(plaintext)) as InnerEnvelope;
      this.expectedRxSeq += 1;
      return decoded;
    } catch (error) {
      throw new E2ENoiseError(
        "decrypt_failed",
        error instanceof Error ? error.message : "Unable to decrypt E2E frame.",
      );
    }
  }

  private messageAad(seq: number, direction: "tx" | "rx"): Uint8Array {
    const semanticDirection =
      this.role === "initiator"
        ? direction === "tx"
          ? "app_to_agent"
          : "agent_to_app"
        : direction === "tx"
          ? "agent_to_app"
          : "app_to_agent";
    return encode(
      [
        MESSAGE_AAD_PREFIX,
        this.sessionId,
        this.appConnectionId,
        semanticDirection,
        String(seq),
      ].join("|"),
    );
  }
}

export function deriveNoisePsk(context: {
  pairingKey: string;
  deviceId: string;
  keyId: string;
}): Uint8Array {
  return hkdf(
    sha256,
    encode(context.pairingKey),
    encode(PSK_SALT),
    encode(`${PSK_INFO_PREFIX}|${context.deviceId}|${context.keyId}`),
    32,
  );
}

function initializeSymmetric(context: NoiseContext): SymmetricState {
  const protocolName = encode(PROTOCOL_NAME);
  const initial =
    protocolName.byteLength <= HASHLEN
      ? concat(protocolName, new Uint8Array(HASHLEN - protocolName.byteLength))
      : blake2s(protocolName);
  const state: SymmetricState = {
    chainingKey: initial,
    hash: initial,
  };
  mixHash(state, encode(prologue(context)));
  mixKeyAndHash(state, deriveNoisePsk(context));
  return state;
}

function prologue(context: NoiseContext): string {
  return [
    "OmniWork E2E",
    `outer=${PROTOCOL_VERSION}`,
    `inner=${INNER_PROTOCOL_VERSION}`,
    `e2e=${E2E_PROTOCOL_VERSION}`,
    `device=${context.deviceId}`,
    `key=${context.keyId}`,
    `agent=${context.agentInstanceId}`,
    `app=${context.appConnectionId}`,
    `suite=${NOISE_SUITE_NNPSK0_V1}`,
  ].join("|");
}

function mixHash(state: SymmetricState, data: Uint8Array): void {
  state.hash = blake2s(concat(state.hash, data));
}

function mixKey(state: SymmetricState, inputKeyMaterial: Uint8Array): void {
  const [chainingKey] = noiseHkdf(state.chainingKey, inputKeyMaterial, 2);
  state.chainingKey = chainingKey;
}

function mixKeyAndHash(
  state: SymmetricState,
  inputKeyMaterial: Uint8Array,
): void {
  const [chainingKey, tempHash] = noiseHkdf(
    state.chainingKey,
    inputKeyMaterial,
    3,
  );
  state.chainingKey = chainingKey;
  mixHash(state, tempHash);
}

function split(state: SymmetricState): [Uint8Array, Uint8Array] {
  const [k1, k2] = noiseHkdf(state.chainingKey, new Uint8Array(), 2);
  return [k1, k2];
}

function noiseHkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  outputs: 2 | 3,
): Uint8Array[] {
  const expanded = hkdf(
    nobleBlake2s,
    inputKeyMaterial,
    chainingKey,
    new Uint8Array(),
    HASHLEN * outputs,
  );
  const result: Uint8Array[] = [];
  for (let index = 0; index < outputs; index += 1) {
    result.push(expanded.subarray(index * HASHLEN, (index + 1) * HASHLEN));
  }
  return result;
}

function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return {
    privateKey,
    publicRaw: x25519.getPublicKey(privateKey),
  };
}

function dh(privateKey: Uint8Array, remotePublicRaw: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, remotePublicRaw);
}

function assertDhMessage(message: Uint8Array): void {
  if (message.byteLength !== DH_LEN) {
    throw new E2ENoiseError(
      "invalid_handshake_message",
      `Expected ${DH_LEN} bytes X25519 public key, got ${message.byteLength}.`,
    );
  }
}

function assertSuite(suite: string): void {
  if (suite !== NOISE_SUITE_NNPSK0_V1) {
    throw new E2ENoiseError(
      "unsupported_suite",
      `Unsupported Noise suite: ${suite}.`,
    );
  }
}

function nonceFromSeq(seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new E2ENoiseError("decrypt_failed", `Invalid sequence: ${seq}.`);
  }
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(seq / 0x1_0000_0000));
  view.setUint32(8, seq >>> 0);
  return nonce;
}

function deriveSessionId(transcriptHash: Uint8Array): string {
  return `e2e_${toBase64Url(blake2s(concat(encode("session"), transcriptHash)).subarray(0, 18))}`;
}

function createId(prefix: string): string {
  return `${prefix}_${toBase64Url(randomBytes(18))}`;
}

function blake2s(data: Uint8Array): Uint8Array {
  return nobleBlake2s(data);
}

function encode(value: string): Uint8Array {
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
      const second = value[index + 1];
      if (second === undefined || (second & 0xc0) !== 0x80) {
        throw new E2ENoiseError(
          "decrypt_failed",
          "Invalid UTF-8 continuation byte.",
        );
      }
      const codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
      result += String.fromCharCode(codePoint);
      index += 2;
      continue;
    }
    if ((first & 0xf0) === 0xe0) {
      const second = value[index + 1];
      const third = value[index + 2];
      if (
        second === undefined ||
        third === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80
      ) {
        throw new E2ENoiseError(
          "decrypt_failed",
          "Invalid UTF-8 continuation byte.",
        );
      }
      const codePoint =
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      result += String.fromCharCode(codePoint);
      index += 3;
      continue;
    }
    if ((first & 0xf8) === 0xf0) {
      const second = value[index + 1];
      const third = value[index + 2];
      const fourth = value[index + 3];
      if (
        second === undefined ||
        third === undefined ||
        fourth === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (fourth & 0xc0) !== 0x80
      ) {
        throw new E2ENoiseError(
          "decrypt_failed",
          "Invalid UTF-8 continuation byte.",
        );
      }
      const codePoint =
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f);
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(
        0xd800 | (adjusted >> 10),
        0xdc00 | (adjusted & 0x3ff),
      );
      index += 4;
      continue;
    }
    throw new E2ENoiseError(
      "decrypt_failed",
      "Unsupported UTF-8 leading byte.",
    );
  }
  return result;
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

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(base64 + padding, "base64");
}
