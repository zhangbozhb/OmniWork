import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  E2E_PROTOCOL_VERSION,
  INNER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SIGNATURE_DOMAINS,
  SIGNED_X25519_SUITE_V2,
  e2eInitSignatureFields,
  e2eReplySignatureFields,
  fromBase64Url,
  identityMatchesPublicKey,
  signIdentityFields,
  toBase64Url,
  verifyIdentityFields,
  type E2EHandshakeInitPayload,
  type E2EHandshakeReplyPayload,
  type E2EMessagePayload,
  type InnerEnvelope,
} from "@omni-work/protocol-ts";

const AEAD_TAG_LEN = 16;
const MESSAGE_AAD_PREFIX = "omniwork:e2e-message:v2";
const SESSION_KDF_INFO = "omniwork:e2e-session-keys:v2";

export type E2ERole = "initiator" | "responder";

export type E2EErrorCode =
  | "invalid_handshake_message"
  | "identity_mismatch"
  | "invalid_signature"
  | "handshake_failed"
  | "decrypt_failed"
  | "replay_detected"
  | "unsupported_suite";

export class E2EError extends Error {
  readonly code: E2EErrorCode;

  constructor(code: E2EErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "E2EError";
  }
}

export interface SignedHandshakeContext {
  deviceId: string;
  agentPublicKey: string;
  appId: string;
  appPublicKey: string;
  agentConnectionId: string;
  appConnectionId: string;
  handshakeId?: string;
}

export interface InitiatorHandshakeOptions extends SignedHandshakeContext {
  signApp(fields: readonly string[]): string | Promise<string>;
}

export interface ResponderHandshakeOptions extends SignedHandshakeContext {
  agentPrivateKey: string;
}

export interface InitiatorHandshakeState {
  init: E2EHandshakeInitPayload;
  complete(reply: E2EHandshakeReplyPayload): E2ESession;
}

export interface ResponderHandshakeResult {
  reply: E2EHandshakeReplyPayload;
  session: E2ESession;
}

export interface EncryptedFrame {
  payload: E2EMessagePayload;
  plaintextBytes: number;
}

interface X25519KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export async function createInitiatorHandshake(
  options: InitiatorHandshakeOptions,
): Promise<InitiatorHandshakeState> {
  validateContext(options);
  const handshakeId = options.handshakeId ?? createId("e2e_hs");
  const localEphemeral = generateX25519KeyPair();
  const unsignedInit: Omit<E2EHandshakeInitPayload, "signature"> = {
    v: PROTOCOL_VERSION,
    e2e_version: E2E_PROTOCOL_VERSION,
    agent_connection_id: options.agentConnectionId,
    app_connection_id: options.appConnectionId,
    handshake_id: handshakeId,
    suite: SIGNED_X25519_SUITE_V2,
    device_id: options.deviceId,
    app_id: options.appId,
    app_public_key: options.appPublicKey,
    app_ephemeral_key: toBase64Url(localEphemeral.publicKey),
    app_protocol: {
      outer_v: PROTOCOL_VERSION,
      inner_v: INNER_PROTOCOL_VERSION,
      e2e_v: E2E_PROTOCOL_VERSION,
    },
  };
  const init: E2EHandshakeInitPayload = {
    ...unsignedInit,
    signature: await options.signApp(e2eInitSignatureFields(unsignedInit)),
  };

  return {
    init,
    complete(reply: E2EHandshakeReplyPayload): E2ESession {
      validateReply(options, init, reply);
      const remoteEphemeral = decodeDhKey(reply.agent_ephemeral_key);
      const transcriptHash = createTranscriptHash(init, reply);
      const [initiatorKey, responderKey] = deriveSessionKeys(
        x25519.getSharedSecret(localEphemeral.privateKey, remoteEphemeral),
        transcriptHash,
      );
      return new E2ESession({
        role: "initiator",
        handshakeId,
        sessionId: deriveSessionId(transcriptHash),
        appConnectionId: options.appConnectionId,
        transcriptHash: toBase64Url(transcriptHash),
        txKey: initiatorKey,
        rxKey: responderKey,
      });
    },
  };
}

export function acceptInitiatorHandshake(
  options: ResponderHandshakeOptions,
  init: E2EHandshakeInitPayload,
): ResponderHandshakeResult {
  validateContext(options);
  validateInit(options, init);
  const remoteEphemeral = decodeDhKey(init.app_ephemeral_key);
  const localEphemeral = generateX25519KeyPair();
  const unsignedReply: Omit<E2EHandshakeReplyPayload, "signature"> = {
    v: PROTOCOL_VERSION,
    e2e_version: E2E_PROTOCOL_VERSION,
    agent_connection_id: options.agentConnectionId,
    app_connection_id: options.appConnectionId,
    handshake_id: init.handshake_id,
    suite: SIGNED_X25519_SUITE_V2,
    device_id: options.deviceId,
    agent_public_key: options.agentPublicKey,
    app_id: options.appId,
    agent_ephemeral_key: toBase64Url(localEphemeral.publicKey),
    agent_protocol: {
      outer_v: PROTOCOL_VERSION,
      inner_v: INNER_PROTOCOL_VERSION,
      e2e_v: E2E_PROTOCOL_VERSION,
    },
  };
  const reply: E2EHandshakeReplyPayload = {
    ...unsignedReply,
    signature: signIdentityFields(
      options.agentPrivateKey,
      SIGNATURE_DOMAINS.e2eReply,
      e2eReplySignatureFields({
        reply: unsignedReply,
        appEphemeralKey: init.app_ephemeral_key,
      }),
    ),
  };
  const transcriptHash = createTranscriptHash(init, reply);
  const [initiatorKey, responderKey] = deriveSessionKeys(
    x25519.getSharedSecret(localEphemeral.privateKey, remoteEphemeral),
    transcriptHash,
  );

  return {
    reply,
    session: new E2ESession({
      role: "responder",
      handshakeId: init.handshake_id,
      sessionId: deriveSessionId(transcriptHash),
      appConnectionId: options.appConnectionId,
      transcriptHash: toBase64Url(transcriptHash),
      txKey: responderKey,
      rxKey: initiatorKey,
    }),
  };
}

export class E2ESession {
  readonly role: E2ERole;
  readonly handshakeId: string;
  readonly sessionId: string;
  readonly appConnectionId: string;
  readonly transcriptHash: string;
  private readonly txKey: Uint8Array;
  private readonly rxKey: Uint8Array;
  private txSeq = 0;
  private expectedRxSeq = 1;

  constructor(options: {
    role: E2ERole;
    handshakeId: string;
    sessionId: string;
    appConnectionId: string;
    transcriptHash: string;
    txKey: Uint8Array;
    rxKey: Uint8Array;
  }) {
    this.role = options.role;
    this.handshakeId = options.handshakeId;
    this.sessionId = options.sessionId;
    this.appConnectionId = options.appConnectionId;
    this.transcriptHash = options.transcriptHash;
    this.txKey = options.txKey;
    this.rxKey = options.rxKey;
  }

  readyPayload(): {
    v: typeof PROTOCOL_VERSION;
    e2e_version: typeof E2E_PROTOCOL_VERSION;
    app_connection_id: string;
    handshake_id: string;
    transcript_hash: string;
  } {
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
    const plaintext = utf8(JSON.stringify(inner));
    const ciphertext = chacha20poly1305(
      this.txKey,
      nonceFromSeq(seq),
      this.messageAad(seq, "tx"),
    ).encrypt(plaintext);
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
    if (
      payload.e2e_session_id !== this.sessionId ||
      payload.app_connection_id !== this.appConnectionId
    ) {
      throw new E2EError(
        "decrypt_failed",
        "Encrypted frame does not belong to this session.",
      );
    }
    if (payload.seq !== this.expectedRxSeq) {
      throw new E2EError(
        "replay_detected",
        `Unexpected E2E sequence ${payload.seq}; expected ${this.expectedRxSeq}.`,
      );
    }
    try {
      const frame = fromBase64Url(payload.ciphertext);
      if (frame.byteLength < AEAD_TAG_LEN) {
        throw new E2EError("decrypt_failed", "Ciphertext frame is too short.");
      }
      const plaintext = chacha20poly1305(
        this.rxKey,
        nonceFromSeq(payload.seq),
        this.messageAad(payload.seq, "rx"),
      ).decrypt(frame);
      const decoded = JSON.parse(decodeUtf8(plaintext)) as InnerEnvelope;
      this.expectedRxSeq += 1;
      return decoded;
    } catch (error) {
      if (error instanceof E2EError) {
        throw error;
      }
      throw new E2EError(
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
    return utf8(
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

function validateContext(context: SignedHandshakeContext): void {
  if (
    !identityMatchesPublicKey(
      "agent",
      context.deviceId,
      context.agentPublicKey,
    ) ||
    !identityMatchesPublicKey("app", context.appId, context.appPublicKey)
  ) {
    throw new E2EError(
      "identity_mismatch",
      "Handshake identity does not match its public key.",
    );
  }
}

function validateInit(
  context: SignedHandshakeContext,
  init: E2EHandshakeInitPayload,
): void {
  assertSuite(init.suite);
  if (
    init.v !== PROTOCOL_VERSION ||
    init.e2e_version !== E2E_PROTOCOL_VERSION ||
    init.device_id !== context.deviceId ||
    init.app_id !== context.appId ||
    init.app_public_key !== context.appPublicKey ||
    init.agent_connection_id !== context.agentConnectionId ||
    init.app_connection_id !== context.appConnectionId
  ) {
    throw new E2EError(
      "handshake_failed",
      "Handshake init does not match the responder context.",
    );
  }
  const { signature, ...unsignedInit } = init;
  if (
    !verifyIdentityFields(
      init.app_public_key,
      SIGNATURE_DOMAINS.e2eInit,
      e2eInitSignatureFields(unsignedInit),
      signature,
    )
  ) {
    throw new E2EError(
      "invalid_signature",
      "App handshake signature is invalid.",
    );
  }
}

function validateReply(
  context: SignedHandshakeContext,
  init: E2EHandshakeInitPayload,
  reply: E2EHandshakeReplyPayload,
): void {
  assertSuite(reply.suite);
  if (
    reply.v !== PROTOCOL_VERSION ||
    reply.e2e_version !== E2E_PROTOCOL_VERSION ||
    reply.device_id !== context.deviceId ||
    reply.agent_public_key !== context.agentPublicKey ||
    reply.app_id !== context.appId ||
    reply.agent_connection_id !== context.agentConnectionId ||
    reply.app_connection_id !== context.appConnectionId ||
    reply.handshake_id !== init.handshake_id
  ) {
    throw new E2EError(
      "handshake_failed",
      "Handshake reply does not match the initiator context.",
    );
  }
  const { signature, ...unsignedReply } = reply;
  if (
    !verifyIdentityFields(
      reply.agent_public_key,
      SIGNATURE_DOMAINS.e2eReply,
      e2eReplySignatureFields({
        reply: unsignedReply,
        appEphemeralKey: init.app_ephemeral_key,
      }),
      signature,
    )
  ) {
    throw new E2EError(
      "invalid_signature",
      "Agent handshake signature is invalid.",
    );
  }
}

function createTranscriptHash(
  init: E2EHandshakeInitPayload,
  reply: E2EHandshakeReplyPayload,
): Uint8Array {
  return sha256(
    utf8(
      JSON.stringify([
        "omniwork:e2e-transcript:v2",
        ...e2eInitSignatureFields(stripInitSignature(init)),
        init.signature,
        ...e2eReplySignatureFields({
          reply: stripReplySignature(reply),
          appEphemeralKey: init.app_ephemeral_key,
        }),
        reply.signature,
      ]),
    ),
  );
}

function stripInitSignature(
  init: E2EHandshakeInitPayload,
): Omit<E2EHandshakeInitPayload, "signature"> {
  const { signature: _signature, ...unsigned } = init;
  return unsigned;
}

function stripReplySignature(
  reply: E2EHandshakeReplyPayload,
): Omit<E2EHandshakeReplyPayload, "signature"> {
  const { signature: _signature, ...unsigned } = reply;
  return unsigned;
}

function deriveSessionKeys(
  sharedSecret: Uint8Array,
  transcriptHash: Uint8Array,
): [Uint8Array, Uint8Array] {
  const keyMaterial = hkdf(
    sha256,
    sharedSecret,
    transcriptHash,
    utf8(SESSION_KDF_INFO),
    64,
  );
  return [keyMaterial.subarray(0, 32), keyMaterial.subarray(32, 64)];
}

function generateX25519KeyPair(): X25519KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { privateKey: secretKey, publicKey };
}

function decodeDhKey(value: string): Uint8Array {
  const key = fromBase64Url(value);
  if (key.byteLength !== 32) {
    throw new E2EError(
      "invalid_handshake_message",
      `Expected 32-byte X25519 public key, got ${key.byteLength}.`,
    );
  }
  return key;
}

function assertSuite(suite: string): void {
  if (suite !== SIGNED_X25519_SUITE_V2) {
    throw new E2EError(
      "unsupported_suite",
      `Unsupported E2E suite: ${suite}.`,
    );
  }
}

function nonceFromSeq(seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new E2EError("decrypt_failed", `Invalid sequence: ${seq}.`);
  }
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(seq / 0x1_0000_0000));
  view.setUint32(8, seq >>> 0);
  return nonce;
}

function deriveSessionId(transcriptHash: Uint8Array): string {
  return `e2e_${toBase64Url(
    sha256(concat(utf8("omniwork:e2e-session-id:v2"), transcriptHash)).subarray(
      0,
      18,
    ),
  )}`;
}

function createId(prefix: string): string {
  return `${prefix}_${toBase64Url(randomBytes(18))}`;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
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
