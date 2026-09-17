import {
  IDENTITY_ALGORITHM,
  IDENTITY_VERSION,
  createIdentitySignaturePayload,
  deriveIdentityId,
  toBase64Url,
} from "@omni-work/protocol-ts";
import type { AppIdentity } from "../../features/auth/appIdentity";
import { createAppIdentityStore } from "./appIdentityStoreCache.ts";

const DATABASE_NAME = "omniwork-identity-v1";
const STORE_NAME = "identity";
const RECORD_KEY = "app";

interface StoredWebIdentity {
  key: typeof RECORD_KEY;
  id: string;
  publicKey: string;
  publicCryptoKey: CryptoKey;
  privateCryptoKey: CryptoKey;
  createdAt: string;
}

export const { getOrCreateAppIdentity, resetAppIdentity } =
  createAppIdentityStore(loadIdentity, async () => {
    const database = await openIdentityDatabase();
    try {
      await deleteStoredIdentity(database);
    } finally {
      database.close();
    }
  });

async function loadIdentity(): Promise<AppIdentity> {
  const subtle = requireWebIdentityCrypto();
  const database = await openIdentityDatabase();
  try {
    const stored = await readStoredIdentity(database);
    const identity = stored ?? await createStoredIdentity(database, subtle);
    if (!(await validateStoredIdentity(identity, subtle))) {
      throw new Error(
        "The stored App identity is invalid. Reset it explicitly before continuing.",
      );
    }
    return createHandle(identity, subtle);
  } finally {
    database.close();
  }
}

async function createStoredIdentity(
  database: IDBDatabase,
  subtle: SubtleCrypto,
): Promise<StoredWebIdentity> {
  const pair = (await subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = toBase64Url(
    new Uint8Array(await subtle.exportKey("raw", pair.publicKey)),
  );
  const storedIdentity: StoredWebIdentity = {
    key: RECORD_KEY,
    id: deriveIdentityId("app", publicKey),
    publicKey,
    publicCryptoKey: pair.publicKey,
    privateCryptoKey: pair.privateKey,
    createdAt: new Date().toISOString(),
  };
  return writeStoredIdentity(database, storedIdentity);
}

function createHandle(
  identity: StoredWebIdentity,
  subtle: SubtleCrypto,
): AppIdentity {
  return {
    record: {
      version: IDENTITY_VERSION,
      role: "app",
      algorithm: IDENTITY_ALGORITHM,
      id: identity.id,
      publicKey: identity.publicKey,
      createdAt: identity.createdAt,
    },
    sign: async (domain, fields) =>
      toBase64Url(
        new Uint8Array(
          await subtle.sign(
            "Ed25519",
            identity.privateCryptoKey,
            asArrayBuffer(createIdentitySignaturePayload(domain, fields)),
          ),
        ),
      ),
  };
}

async function validateStoredIdentity(
  identity: StoredWebIdentity,
  subtle: SubtleCrypto,
): Promise<boolean> {
  if (
    identity.key !== RECORD_KEY ||
    identity.id !== deriveIdentityId("app", identity.publicKey) ||
    identity.privateCryptoKey.type !== "private" ||
    identity.publicCryptoKey.type !== "public"
  ) {
    return false;
  }
  const payload = createIdentitySignaturePayload("identity-check", [
    identity.id,
  ]);
  const signature = await subtle.sign(
    "Ed25519",
    identity.privateCryptoKey,
    asArrayBuffer(payload),
  );
  return subtle.verify(
    "Ed25519",
    identity.publicCryptoKey,
    signature,
    asArrayBuffer(payload),
  );
}

export function requireWebIdentityCrypto(
  cryptoApi: Pick<Crypto, "subtle"> | undefined = globalThis.crypto,
): SubtleCrypto {
  if (!cryptoApi?.subtle) {
    throw new Error(
      "Web App identity requires a secure browser context. Use http://127.0.0.1 or http://localhost for local development, or serve OmniWork over trusted HTTPS.",
    );
  }
  return cryptoApi.subtle;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open identity database."));
  });
}

function readStoredIdentity(
  database: IDBDatabase,
): Promise<StoredWebIdentity | null> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(RECORD_KEY);
    request.onsuccess = () =>
      resolve((request.result as StoredWebIdentity | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to read App identity."));
  });
}

function writeStoredIdentity(
  database: IDBDatabase,
  identity: StoredWebIdentity,
): Promise<StoredWebIdentity> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let selected = identity;
    // A different tab may have created its identity while WebCrypto was awaiting.
    const request = store.get(RECORD_KEY);
    request.onsuccess = () => {
      if (request.result) {
        selected = request.result as StoredWebIdentity;
      } else {
        store.add(identity);
      }
    };
    transaction.oncomplete = () => resolve(selected);
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error("Unable to store App identity."));
  });
}

function deleteStoredIdentity(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error("Unable to reset App identity."));
  });
}
