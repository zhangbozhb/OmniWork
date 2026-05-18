import { RTCPeerConnection } from "react-native-webrtc";

import type {
  WebRtcPeerConnectionFactory,
  WebRtcPeerConnectionLike,
} from "../../../../packages/relay-client/src/index.ts";

export function createPeerConnectionFactory(): WebRtcPeerConnectionFactory {
  return () => {
    return new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    }) as unknown as WebRtcPeerConnectionLike;
  };
}
