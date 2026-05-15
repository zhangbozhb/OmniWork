import type {
  WebRtcPeerConnectionFactory,
  WebRtcPeerConnectionLike,
} from "../../../packages/relay-client/src/webrtcTransport.ts";
import nodeWebRtc from "@roamhq/wrtc";

type GlobalWithWebRtc = typeof globalThis & {
  RTCPeerConnection?: new (configuration?: unknown) => WebRtcPeerConnectionLike;
};

type NodeWebRtcRuntime = {
  RTCPeerConnection?: new (configuration?: unknown) => WebRtcPeerConnectionLike;
};

export function createDefaultPeerConnectionFactory(
  iceServers: Array<{ urls: string | string[] }> = [],
): WebRtcPeerConnectionFactory | null {
  const ctor =
    (globalThis as GlobalWithWebRtc).RTCPeerConnection ??
    (nodeWebRtc as unknown as NodeWebRtcRuntime).RTCPeerConnection;
  if (!ctor) {
    return null;
  }

  return () => new ctor({ iceServers });
}
