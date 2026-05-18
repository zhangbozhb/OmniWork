import type {
  WebRtcPeerConnectionFactory,
  WebRtcPeerConnectionLike,
} from "../../../../packages/relay-client/src/index.ts";

export function createPeerConnectionFactory(): WebRtcPeerConnectionFactory {
  return () => {
    if (!globalThis.RTCPeerConnection) {
      throw new Error("This browser does not support RTCPeerConnection.");
    }

    return new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    }) as unknown as WebRtcPeerConnectionLike;
  };
}
