import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createKeyProof } from "../../app/src/features/auth/keyProof.ts";
import {
  createMessage,
} from "../../packages/protocol-ts/src/index.ts";
import {
  candidateToInit,
  DataChannelEnvelopeTransport,
  RelayClient,
} from "../../packages/relay-client/src/index.ts";

const requireFromRelay = createRequire(
  new URL("../../relay/server/package.json", import.meta.url),
);
const { RTCPeerConnection } = requireFromRelay("@roamhq/wrtc");

const relayBaseUrl = process.env.OMNIWORK_E2E_RELAY_URL ?? "ws://127.0.0.1:8787";
const deviceId = "e2e-device-webrtc";
const agentInstanceId = "e2e-agent-instance";
const keyId = "e2e-key";
const key = "0123456789abcdef0123456789abcdef";
const timeoutMs = Number(process.env.OMNIWORK_E2E_TIMEOUT_MS ?? "15000");

const agent = new RelayClient({ url: `${relayBaseUrl}/agent` });
const signaling = new RelayClient({ url: `${relayBaseUrl}/tunnel/mobile` });
const peer = new RTCPeerConnection({ iceServers: [] });

let dataTransport;
let tunnelSessionId;

try {
  const authOkPromise = withTimeout(waitForAuthOk(), timeoutMs);

  await agent.connect();
  agent.send(
    createMessage(
      "agent.hello",
      {
        device_id: deviceId,
        agent_instance_id: agentInstanceId,
        key_id: keyId,
        hostname: "e2e.local",
        platform: "darwin",
        agent_version: "e2e",
        capabilities: ["terminal.tui", "terminal.snapshot"],
      },
      { device_id: deviceId },
    ),
  );

  await signaling.connect();
  signaling.send(
    createMessage(
      "tunnel.mobile.join",
      {
        device_id: deviceId,
        key_id: keyId,
        transport: "webrtc",
      },
      { device_id: deviceId },
    ),
  );

  const authOk = await authOkPromise;
  assert.equal(authOk.payload.agent_instance_id, agentInstanceId);
  console.log("app webrtc tunnel e2e ok");
} finally {
  dataTransport?.close();
  peer.close();
  signaling.close();
  agent.close();
}

function waitForAuthOk() {
  return new Promise((resolve, reject) => {
    agent.onMessage(async (message) => {
      if (message.type !== "auth.verify") {
        return;
      }

      const payload = message.payload;
      const expectedProof = await createKeyProof(key, payload.nonce);
      if (payload.key_id === keyId && payload.proof === expectedProof) {
        agent.send(
          createMessage(
            "auth.ok",
            {
              agent_instance_id: agentInstanceId,
              connection_id: payload.connection_id,
            },
            { device_id: deviceId },
          ),
        );
        return;
      }

      agent.send(
        createMessage(
          "auth.failed",
          {
            reason: "key_mismatch",
            connection_id: payload.connection_id,
          },
          { device_id: deviceId },
        ),
      );
    });

    peer.onicecandidate = (event) => {
      if (!event.candidate || !tunnelSessionId) {
        return;
      }
      const candidate = candidateToInit(event.candidate);
      signaling.send(
        createMessage(
          "tunnel.session.candidate",
          {
            session_id: tunnelSessionId,
            device_id: deviceId,
            candidate: candidate.candidate,
            sdp_mid: candidate.sdpMid,
            sdp_m_line_index: candidate.sdpMLineIndex,
          },
          { device_id: deviceId, session_id: tunnelSessionId },
        ),
      );
    };

    peer.ondatachannel = (event) => {
      dataTransport = new DataChannelEnvelopeTransport({ channel: event.channel });
      dataTransport.onOpen(() => {
        dataTransport.send(
          createMessage(
            "mobile.connect",
            {
              device_id: deviceId,
              key_id: keyId,
            },
            { device_id: deviceId },
          ),
        );
      });
      dataTransport.onMessage(async (message) => {
        if (message.type === "auth.challenge") {
          const challenge = message.payload;
          dataTransport.send(
            createMessage(
              "auth.proof",
              {
                key_id: challenge.key_id,
                nonce: challenge.nonce,
                proof: await createKeyProof(key, challenge.nonce),
              },
              { device_id: deviceId },
            ),
          );
          return;
        }

        if (message.type === "auth.ok") {
          resolve(message);
          return;
        }

        if (message.type === "auth.failed") {
          reject(new Error(`auth failed: ${message.payload.reason}`));
        }
      });
      dataTransport.onClose((reason) => {
        reject(new Error(`data channel closed before auth.ok: ${reason}`));
      });
    };

    signaling.onMessage(async (message) => {
      if (message.type === "tunnel.session.offer") {
        tunnelSessionId = message.payload.session_id;
        await peer.setRemoteDescription({
          type: "offer",
          sdp: message.payload.sdp,
        });
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        const local = peer.localDescription ?? answer;
        signaling.send(
          createMessage(
            "tunnel.session.answer",
            {
              session_id: tunnelSessionId,
              device_id: deviceId,
              sdp: local.sdp ?? "",
              sdp_type: "answer",
            },
            { device_id: deviceId, session_id: tunnelSessionId },
          ),
        );
        return;
      }

      if (message.type === "tunnel.session.candidate") {
        await peer.addIceCandidate({
          candidate: message.payload.candidate,
          sdpMid: message.payload.sdp_mid,
          sdpMLineIndex: message.payload.sdp_m_line_index,
        });
        return;
      }

      if (message.type === "tunnel.session.failed") {
        reject(
          new Error(
            message.payload.message ??
              `tunnel failed: ${message.payload.reason}`,
          ),
        );
      }
    });

    signaling.onClose((event) => {
      reject(new Error(`signaling closed: ${event.reason ?? event.code ?? ""}`));
    });
  });
}

function withTimeout(promise, ms) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeout),
  );
}
