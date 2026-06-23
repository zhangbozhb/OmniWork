// Mobile simulator that drives the P2P upgrade end-to-end against a real
// relay + agent. Pass the pairing key and key_id printed by the agent.
//
// Usage:
//   node scripts/verify/mobile-upgrade-simulator.mjs \
//     --relay ws://127.0.0.1:8787/relay/ws/mobile \
//     --device test-device \
//     --key <KEY> \
//     --key-id <KEY_ID>

import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// 借用 desktop/agent 的 node_modules（其中已安装 @roamhq/wrtc）
const require = createRequire(
  new URL("../../desktop/agent/package.json", import.meta.url),
);
const wrtc = require("@roamhq/wrtc");

const args = parseArgs(process.argv.slice(2));
const relayUrl = args.relay ?? "ws://127.0.0.1:8787/relay/ws/mobile";
const deviceId = args.device ?? "test-device";
const key = required(args, "key");
const keyId = required(args, "key-id");
const appInstanceId = args.appInstanceId ?? `app_${randomUUID()}`;
const appRuntimeId = args.appRuntimeId ?? `runtime_${randomUUID()}`;

const ws = new WebSocket(relayUrl);
let pc = null;
let dc = null;
let upgradeId = null;
let committedSent = false;
let peerCommitted = false;
let p2pVerified = false;

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

function send(message) {
  ws.send(JSON.stringify(message));
}

function envelope(type, payload, extra = {}) {
  return {
    v: 1,
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
    device_id: deviceId,
    key_id: keyId,
    app_info: {
      instance_id: appInstanceId,
      runtime_id: appRuntimeId,
    },
  }));
});

ws.addEventListener("message", async (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
  log("recv", { type: msg.type });

  switch (msg.type) {
    case "auth.challenge": {
      const proof = createHmac("sha256", key)
        .update([msg.payload.nonce, appInstanceId, appRuntimeId].join("\n"))
        .digest("base64url");
      send(
        envelope("auth.proof", {
          key_id: msg.payload.key_id,
          nonce: msg.payload.nonce,
          app_info: {
            instance_id: appInstanceId,
            runtime_id: appRuntimeId,
          },
          proof,
        }),
      );
      break;
    }
    case "auth.ok":
      log("authenticated", { connection_id: msg.payload.connection_id });
      break;
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
});

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
      send(
        envelope("tunnel.upgrade.candidate", {
          upgrade_id: upgradeId,
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
      send(
        envelope("tunnel.upgrade.committed", { upgrade_id: upgradeId }),
      );
      maybeFinish();
    }
  };

  dc = pc.createDataChannel("omniwork");
  dc.onopen = () => {
    log("dc_open");
    // 发个测试 echo
    setTimeout(() => {
      try {
        dc.send(
          JSON.stringify({
            v: 1,
            id: randomUUID(),
            ts: new Date().toISOString(),
            device_id: deviceId,
            type: "transport.ping",
            payload: { seq: 999, sent_at: new Date().toISOString() },
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
  send(
    envelope("tunnel.upgrade.offer", {
      upgrade_id: upgradeId,
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
}, 30000);

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

function required(args, name) {
  const v = args[name];
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return v;
}
