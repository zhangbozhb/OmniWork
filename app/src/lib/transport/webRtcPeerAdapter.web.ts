import type { WebRtcPeerAdapter } from "../../../../packages/protocol-ts/src/index";

interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface MobileWebRtcPeerAdapterOptions {
  iceServers: IceServerLike[];
  role: "offerer" | "answerer";
}

export function createMobileWebRtcPeerAdapter(
  _opts: MobileWebRtcPeerAdapterOptions,
): WebRtcPeerAdapter | null {
  // Web 暂不支持原生 WebRTC P2P 升级路径。
  return null;
}
