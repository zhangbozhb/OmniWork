import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptInitiatorHandshake,
  createInitiatorHandshake,
  type E2ENoiseSession,
} from "@omniwork/e2e-noise";
import {
  INNER_PROTOCOL_VERSION,
  createMessage,
  type InnerEnvelope,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";
import { MobileRelaySession } from "../src/lib/relay-client/mobileRelaySession.ts";

const pairing = {
  relayUrl: "wss://relay.test",
  deviceId: "mac_test",
  key: "test-pairing-key-32-bytes",
  keyId: "key_test",
  appInstanceId: "app_test_1",
};

function createSessionPair(): {
  appSession: E2ENoiseSession;
  agentSession: E2ENoiseSession;
} {
  const context = {
    pairingKey: pairing.key,
    deviceId: pairing.deviceId,
    keyId: pairing.keyId,
    agentInstanceId: "agent_test",
    appConnectionId: "conn_app_1",
    handshakeId: "hs_test",
  };
  const initiator = createInitiatorHandshake(context);
  const responder = acceptInitiatorHandshake(context, initiator.init);
  return {
    appSession: initiator.complete(responder.reply),
    agentSession: responder.session,
  };
}

function createReadyRelaySession(
  appSession: E2ENoiseSession,
): MobileRelaySession {
  const relaySession = new MobileRelaySession(pairing);
  const internals = relaySession as unknown as {
    e2eSession: E2ENoiseSession;
    e2ePeerReady: boolean;
    businessSecurityMode: "e2e_required";
    plaintextReady: boolean;
    appConnectionId: string;
  };
  internals.e2eSession = appSession;
  internals.e2ePeerReady = true;
  internals.businessSecurityMode = "e2e_required";
  internals.plaintextReady = false;
  internals.appConnectionId = "conn_app_1";
  return relaySession;
}

function makeInner(type: InnerEnvelope["type"]): InnerEnvelope {
  return {
    v: INNER_PROTOCOL_VERSION,
    id: `inner_${type}`,
    type,
    created_at: "2026-06-03T00:00:00.000Z",
    session_id: "sess_1",
    seq: 7,
    payload:
      type === "terminal.frame"
        ? { data: "frame", snapshot: true }
        : { data: "ls\n" },
  };
}

test("encodeForP2p encrypts business messages as e2e.message", () => {
  const { appSession, agentSession } = createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const input = createMessage(
    "terminal.input",
    { data: "ls\n" },
    { device_id: pairing.deviceId, session_id: "sess_1", seq: 3 },
  );

  const encoded = relaySession.encodeForP2p(input);

  assert.ok(encoded, "P2P encoding should return an envelope");
  assert.equal(encoded.type, "e2e.message");
  const decrypted = agentSession.decrypt(
    encoded.payload as Parameters<E2ENoiseSession["decrypt"]>[0],
  );
  assert.equal(decrypted.type, "terminal.input");
  assert.equal(decrypted.seq, 3);
});

test("receiveFromP2p decrypts e2e.message before dispatching business messages", async () => {
  const { appSession, agentSession } = createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const received: MessageEnvelope[] = [];
  relaySession.onMessage((message) => received.push(message));
  const encrypted = agentSession.encrypt(makeInner("terminal.frame"));
  const outer = createMessage("e2e.message", encrypted.payload, {
    device_id: pairing.deviceId,
  });

  relaySession.receiveFromP2p(outer);
  await Promise.resolve();

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "terminal.frame");
  assert.equal(received[0]?.seq, 7);
});

test("encodeForP2p does not send plaintext business messages before E2E is ready", () => {
  const relaySession = new MobileRelaySession(pairing);
  const input = createMessage("terminal.input", { data: "pwd\n" }, {
    device_id: pairing.deviceId,
  });

  assert.equal(relaySession.encodeForP2p(input), null);
});

test("upgrade control dispatch is scoped to current app_connection_id", () => {
  const { appSession } = createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const received: MessageEnvelope[] = [];
  relaySession.onMessage((message) => received.push(message));
  const internals = relaySession as unknown as {
    dispatchRelayUpgradeControl: (message: MessageEnvelope) => void;
  };

  internals.dispatchRelayUpgradeControl(
    createMessage(
      "tunnel.upgrade.propose",
      {
        upgrade_id: "upgrade_other",
        app_connection_id: "conn_other",
        ice_servers: [],
        role: "offerer",
        strict: true,
      },
      { device_id: pairing.deviceId },
    ),
  );
  internals.dispatchRelayUpgradeControl(
    createMessage(
      "tunnel.upgrade.propose",
      {
        upgrade_id: "upgrade_self",
        app_connection_id: "conn_app_1",
        ice_servers: [],
        role: "offerer",
        strict: true,
      },
      { device_id: pairing.deviceId },
    ),
  );

  assert.equal(received.length, 1);
  assert.equal(
    (received[0]?.payload as { app_connection_id?: string }).app_connection_id,
    "conn_app_1",
  );
});

test("onBusinessReady fires when E2E peer becomes ready", () => {
  const { appSession } = createSessionPair();
  const relaySession = createReadyRelaySession(appSession);
  const internals = relaySession as unknown as {
    e2eSession: E2ENoiseSession;
    e2ePeerReady: boolean;
    appConnectionId: string;
    handleE2EReady: (payload: ReturnType<E2ENoiseSession["readyPayload"]>) => void;
  };
  internals.e2ePeerReady = false;
  let readyCount = 0;
  relaySession.onBusinessReady(() => {
    readyCount += 1;
  });

  internals.handleE2EReady(internals.e2eSession.readyPayload());

  assert.equal(readyCount, 1);
});

test("relay_only does not probe WebRTC for private network hash", async () => {
  const previous = (
    globalThis as unknown as { RTCPeerConnection?: unknown }
  ).RTCPeerConnection;
  (
    globalThis as unknown as { RTCPeerConnection?: unknown }
  ).RTCPeerConnection = class {
    constructor() {
      throw new Error("should not probe WebRTC in relay_only mode");
    }
  };
  try {
    const relaySession = new MobileRelaySession(pairing, {
      transportPreference: "relay_only",
    });
    const internals = relaySession as unknown as {
      resolvePrivateNetworkHash: () => Promise<string | undefined>;
    };

    assert.equal(await internals.resolvePrivateNetworkHash(), undefined);
  } finally {
    (
      globalThis as unknown as { RTCPeerConnection?: unknown }
    ).RTCPeerConnection = previous;
  }
});
