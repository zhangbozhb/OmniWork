// Mobile simulator that drives pairing and P2P upgrade end-to-end against a
// real Relay and Agent. Approve its generated App identity in Agent Admin.
//
// Usage:
//   node scripts/verify/mobile-upgrade-simulator.mjs \
//     --pairing 'omniwork://pair?...'
//   node scripts/verify/mobile-upgrade-simulator.mjs \
//     --relay ws://127.0.0.1:8787/relay/ws/mobile \
//     --device DEV1-...

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// 借用 desktop/agent 的 node_modules（其中已安装 @roamhq/wrtc）
const require = createRequire(
  new URL("../../desktop/agent/package.json", import.meta.url),
);
const wrtc = require("@roamhq/wrtc");
const {
  E2E_SUPPORT_V2,
  PROTOCOL_VERSION,
  PROTOCOL_SUPPORT_V2,
  SIGNATURE_DOMAINS,
  agentAuthOkSignatureFields,
  appAuthSignatureFields,
  generateIdentityKeyPair,
  identityMatchesPublicKey,
  innerToMessage,
  messageToInner,
  normalizeIdentityId,
  parsePairingLink,
  signIdentityFields,
  verifyIdentityFields,
} = await import(require.resolve("@omni-work/protocol-ts"));
const { createInitiatorHandshake } = await import(
  require.resolve("@omni-work/e2e-noise")
);

const args = parseArgs(process.argv.slice(2));
const target = resolveTarget(args);
const relayUrl = target.relayUrl;
const deviceId = target.deviceId;
const sessionToken =
  typeof (args.sessionToken ?? args["session-token"]) === "string"
    ? (args.sessionToken ?? args["session-token"])
    : undefined;
let agentPublicKey = null;
const appIdentity = generateIdentityKeyPair("app");
const appInstanceId = args.appInstanceId ?? appIdentity.id;
const appRuntimeId = args.appRuntimeId ?? `runtime_${randomUUID()}`;

const ws = new WebSocket(relayUrl);
let pc = null;
let dc = null;
let upgradeId = null;
let committedSent = false;
let peerCommitted = false;
let p2pVerified = false;
let appConnectionId = null;
let e2eHandshake = null;
let e2eSession = null;
let e2ePeerReady = false;

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

function send(message) {
  ws.send(JSON.stringify(message));
}

function sendBusiness(message) {
  if (!e2eSession || !e2ePeerReady) {
    throw new Error(`E2E session is not ready for ${message.type}`);
  }
  send(
    envelope(
      "e2e.message",
      e2eSession.encrypt(messageToInner(message)).payload,
    ),
  );
}

function envelope(type, payload, extra = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    device_id: deviceId,
    type,
    payload,
    ...extra,
  };
}

ws.addEventListener("open", () => {
  log("ws_open");
  send(envelope("mobile.connect", {
    v: PROTOCOL_SUPPORT_V2.current,
    device_id: deviceId,
    app_id: appIdentity.id,
    app_public_key: appIdentity.publicKey,
    app_info: {
      instance_id: appInstanceId,
      runtime_id: appRuntimeId,
    },
    protocol: PROTOCOL_SUPPORT_V2,
    e2e: E2E_SUPPORT_V2,
    ...(sessionToken ? { session_token: sessionToken } : {}),
  }));
});

ws.addEventListener("message", async (event) => {
  const msg = JSON.parse(
    typeof event.data === "string" ? event.data : event.data.toString(),
  );
  await handleMessage(msg);
});

async function handleMessage(msg) {
  log("recv", { type: msg.type });

  switch (msg.type) {
    case "auth.challenge": {
      if (
        !identityMatchesPublicKey(
          "agent",
          deviceId,
          msg.payload.agent_public_key,
        ) ||
        (agentPublicKey &&
          agentPublicKey !== msg.payload.agent_public_key)
      ) {
        throw new Error("Relay challenge Agent identity is invalid.");
      }
      agentPublicKey = msg.payload.agent_public_key;
      const unsigned = {
        nonce: msg.payload.nonce,
        connection_id: msg.payload.connection_id,
        agent_connection_id: msg.payload.agent_connection_id,
        device_id: deviceId,
        agent_public_key: agentPublicKey,
        app_id: appIdentity.id,
        app_public_key: appIdentity.publicKey,
        app_info: {
          instance_id: appInstanceId,
          runtime_id: appRuntimeId,
        },
        requested_scopes: ["device.control"],
        timestamp: Date.now(),
      };
      send(
        envelope("auth.proof", {
          ...unsigned,
          signature: signIdentityFields(
            appIdentity.privateKey,
            SIGNATURE_DOMAINS.appAuth,
            appAuthSignatureFields(unsigned),
          ),
        }),
      );
      break;
    }
    case "auth.pending":
      log("approval_pending", {
        request_id: msg.payload.request_id,
        app_id: appIdentity.id,
      });
      break;
    case "auth.ok": {
      const { signature, e2e: _e2e, ...unsigned } = msg.payload;
      if (
        !agentPublicKey ||
        msg.payload.device_id !== deviceId ||
        msg.payload.agent_public_key !== agentPublicKey ||
        msg.payload.app_id !== appIdentity.id ||
        !verifyIdentityFields(
          agentPublicKey,
          SIGNATURE_DOMAINS.agentAuthOk,
          agentAuthOkSignatureFields(unsigned),
          signature,
        )
      ) {
        throw new Error("Agent authentication response is invalid.");
      }
      log("authenticated", { connection_id: msg.payload.connection_id });
      appConnectionId = msg.payload.connection_id;
      e2eHandshake = await createInitiatorHandshake({
        deviceId,
        agentPublicKey,
        appId: appIdentity.id,
        appPublicKey: appIdentity.publicKey,
        agentConnectionId: msg.payload.agent_connection_id,
        appConnectionId,
        signApp: (fields) =>
          signIdentityFields(
            appIdentity.privateKey,
            SIGNATURE_DOMAINS.e2eInit,
            fields,
          ),
      });
      send(envelope("e2e.handshake.init", e2eHandshake.init));
      break;
    }
    case "e2e.handshake.reply":
      if (!e2eHandshake) {
        throw new Error("received E2E reply without an active handshake");
      }
      e2eSession = e2eHandshake.complete(msg.payload);
      e2eHandshake = null;
      send(envelope("e2e.ready", e2eSession.readyPayload()));
      break;
    case "e2e.ready":
      if (
        !e2eSession ||
        msg.payload.app_connection_id !== appConnectionId ||
        msg.payload.handshake_id !== e2eSession.handshakeId ||
        msg.payload.transcript_hash !== e2eSession.transcriptHash
      ) {
        throw new Error("received mismatched E2E ready payload");
      }
      e2ePeerReady = true;
      log("e2e_ready", { app_connection_id: appConnectionId });
      break;
    case "e2e.message": {
      if (!e2eSession || !e2ePeerReady) {
        throw new Error("received E2E message before ready");
      }
      const inner = e2eSession.decrypt(msg.payload);
      await handleMessage(innerToMessage(inner, deviceId));
      break;
    }
    case "auth.failed":
      log("auth_failed", { reason: msg.payload.reason });
      process.exit(2);
      break;
    case "tunnel.upgrade.propose":
      await onPropose(msg.payload);
      break;
    case "tunnel.upgrade.answer":
      await onAnswer(msg.payload);
      break;
    case "tunnel.upgrade.candidate":
      await onCandidate(msg.payload);
      break;
    case "tunnel.upgrade.committed":
      onCommitted(msg.payload);
      break;
    case "tunnel.upgrade.downgrade":
      log("relay_downgrade", { reason: msg.payload.reason });
      break;
    default:
      break;
  }
}

ws.addEventListener("close", (event) => {
  log("ws_close", { code: event.code, reason: String(event.reason ?? "") });
});

ws.addEventListener("error", (event) => {
  log("ws_error", { error: String(event?.message ?? event) });
});

async function onPropose(payload) {
  upgradeId = payload.upgrade_id;
  log("upgrade_propose", { upgrade_id: upgradeId, role: payload.role });

  if (payload.role !== "offerer") {
    log("unexpected_role", { role: payload.role });
    return;
  }

  pc = new wrtc.RTCPeerConnection({ iceServers: payload.ice_servers });
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendBusiness(
        envelope("tunnel.upgrade.candidate", {
          upgrade_id: upgradeId,
          app_connection_id: appConnectionId,
          candidate: e.candidate.candidate,
          sdp_mid: e.candidate.sdpMid,
          sdp_mline_index: e.candidate.sdpMLineIndex,
        }),
      );
    }
  };
  pc.onconnectionstatechange = () => {
    log("pc_state", { state: pc.connectionState });
    if (pc.connectionState === "connected" && !committedSent) {
      committedSent = true;
      sendBusiness(
        envelope("tunnel.upgrade.committed", {
          upgrade_id: upgradeId,
          app_connection_id: appConnectionId,
        }),
      );
      maybeFinish();
    }
  };

  dc = pc.createDataChannel("omniwork-control");
  dc.onopen = () => {
    log("dc_open");
    // 发个测试 echo
    setTimeout(() => {
      try {
        dc.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            id: randomUUID(),
            ts: new Date().toISOString(),
            device_id: deviceId,
            type: "transport.ping",
            payload: {
              upgrade_id: upgradeId,
              seq: 999,
              sent_at: new Date().toISOString(),
            },
          }),
        );
        log("p2p_ping_sent");
      } catch (e) {
        log("p2p_send_error", { error: String(e) });
      }
    }, 200);
  };
  dc.onmessage = (e) => {
    p2pVerified = true;
    log("dc_message", { data: String(e.data).slice(0, 200) });
    maybeFinish();
  };
  dc.onclose = () => log("dc_close");

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendBusiness(
    envelope("tunnel.upgrade.offer", {
      upgrade_id: upgradeId,
      app_connection_id: appConnectionId,
      sdp: offer.sdp,
    }),
  );
}

async function onAnswer(payload) {
  if (payload.upgrade_id !== upgradeId) return;
  await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
  log("answer_applied");
}

async function onCandidate(payload) {
  if (payload.upgrade_id !== upgradeId) return;
  try {
    await pc.addIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdp_mid,
      sdpMLineIndex: payload.sdp_mline_index,
    });
  } catch (e) {
    log("addIceCandidate_error", { error: String(e) });
  }
}

function onCommitted(payload) {
  if (payload.upgrade_id !== upgradeId) return;
  peerCommitted = true;
  log("peer_committed");
  maybeFinish();
}

function maybeFinish() {
  if (committedSent && peerCommitted && p2pVerified) {
    log("upgrade_verified", { upgrade_id: upgradeId });
    // 多保留 6s 让 transport 自身的 ping/pong 至少运转一次（默认 5s/次）。
    setTimeout(() => {
      ws.close();
      pc?.close();
      process.exit(0);
    }, 6000);
  }
}

setTimeout(() => {
  log("timeout", { committedSent, peerCommitted, p2pVerified });
  process.exit(committedSent && peerCommitted ? 0 : 3);
}, 150000);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

function resolveTarget(args) {
  if (typeof args.pairing === "string") {
    if (args.relay || args.device) {
      failUsage("Use either --pairing or --relay with --device.");
    }
    const pairing = parsePairingLink(args.pairing);
    if (!pairing || !isWebSocketUrl(pairing.relay_url)) {
      failUsage("The pairing link is invalid.");
    }
    return {
      relayUrl: pairing.relay_url,
      deviceId: pairing.device_id,
    };
  }

  if (typeof args.relay !== "string" || typeof args.device !== "string") {
    failUsage("Provide --pairing or both --relay and --device.");
  }
  const deviceId = normalizeIdentityId(args.device);
  if (!deviceId?.startsWith("DEV1-") || !isWebSocketUrl(args.relay)) {
    failUsage("The Relay URL or Agent device ID is invalid.");
  }
  return {
    relayUrl: args.relay.trim(),
    deviceId,
  };
}

function isWebSocketUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

function failUsage(message) {
  console.error(message);
  console.error(
    [
      "Usage:",
      "  pnpm verify:upgrade:simulator -- --pairing 'omniwork://pair?...'",
      "  pnpm verify:upgrade:simulator -- --relay ws://127.0.0.1:8787/relay/ws/mobile --device DEV1-...",
      "Optional: --session-token <relay-user-session-token>",
    ].join("\n"),
  );
  process.exit(1);
}
