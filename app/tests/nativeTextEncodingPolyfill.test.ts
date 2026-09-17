import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  INNER_PROTOCOL_VERSION,
  SIGNATURE_DOMAINS,
  generateIdentityKeyPair,
  signIdentityFields,
  type InnerEnvelope,
} from "@omni-work/protocol-ts";
import {
  acceptInitiatorHandshake,
  createInitiatorHandshake,
} from "@omni-work/e2e-noise";

import {
  installNativeTextEncodingPolyfill,
} from "../src/platform/nativeTextEncodingPolyfill.ts";

const require = createRequire(import.meta.url);

test("Native text encoding polyfill supports identity and E2E operations", async () => {
  const originalEncoder = globalThis.TextEncoder;
  const originalDecoder = globalThis.TextDecoder;
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "TextDecoder", {
    configurable: true,
    writable: true,
    value: undefined,
  });

  try {
    installNativeTextEncodingPolyfill(
      globalThis,
      require("text-encoding") as {
        TextEncoder: typeof TextEncoder;
        TextDecoder: typeof TextDecoder;
      },
    );
    assert.equal(typeof globalThis.TextEncoder, "function");
    assert.equal(typeof globalThis.TextDecoder, "function");

    const agentIdentity = generateIdentityKeyPair("agent");
    const appIdentity = generateIdentityKeyPair("app");
    const context = {
      deviceId: agentIdentity.id,
      agentPublicKey: agentIdentity.publicKey,
      appId: appIdentity.id,
      appPublicKey: appIdentity.publicKey,
      agentConnectionId: "conn_agent_native",
      appConnectionId: "conn_app_native",
      handshakeId: "hs_native",
    };
    const initiator = await createInitiatorHandshake({
      ...context,
      signApp: (fields) =>
        signIdentityFields(
          appIdentity.privateKey,
          SIGNATURE_DOMAINS.e2eInit,
          fields,
        ),
    });
    const responder = acceptInitiatorHandshake(
      {
        ...context,
        agentPrivateKey: agentIdentity.privateKey,
      },
      initiator.init,
    );
    const appSession = initiator.complete(responder.reply);
    const message: InnerEnvelope = {
      v: INNER_PROTOCOL_VERSION,
      id: "inner_native",
      type: "terminal.input",
      created_at: "2026-09-17T00:00:00.000Z",
      payload: { kind: "text", data: "连接成功\n" },
    };

    assert.deepEqual(
      responder.session.decrypt(appSession.encrypt(message).payload),
      message,
    );
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      writable: true,
      value: originalEncoder,
    });
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      writable: true,
      value: originalDecoder,
    });
  }
});
