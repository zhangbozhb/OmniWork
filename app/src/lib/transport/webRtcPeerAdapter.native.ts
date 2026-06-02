import type {
  IceCandidateInit,
  PeerState,
  WebRtcPeerAdapter,
} from "../../../../packages/protocol-ts/src/index";

interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface MobileWebRtcPeerAdapterOptions {
  iceServers: IceServerLike[];
  role: "offerer" | "answerer";
}

type CandidateHandler = (c: IceCandidateInit) => void;
type DataHandler = (data: string) => void;
type StateHandler = (state: PeerState) => void;

interface WrtcModule {
  RTCPeerConnection: new (config: { iceServers: IceServerLike[] }) => any;
  RTCSessionDescription: new (init: { sdp: string; type: "offer" | "answer" }) => any;
  RTCIceCandidate: new (init: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  }) => any;
}

function loadWrtc(): WrtcModule | null {
  try {
    // 通过 require 动态加载，避免在未安装依赖的环境下编译失败。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("react-native-webrtc") as WrtcModule;
    return mod;
  } catch (error) {
    console.warn(
      "[omniwork-app] react-native-webrtc unavailable; P2P upgrade disabled",
      { error: (error as Error)?.message },
    );
    return null;
  }
}

/**
 * dataChannel 尚未 open 时 send() 的最多暂存条数，防御 SCTP 握手卡顿场景。
 */
const PENDING_SEND_LIMIT = 256;

class MobileWebRtcPeerAdapter implements WebRtcPeerAdapter {
  private readonly pc: any;
  private readonly mod: WrtcModule;
  private readonly role: "offerer" | "answerer";
  private dataChannel: any = null;
  private readonly candidateHandlers = new Set<CandidateHandler>();
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  /**
   * dataChannel 尚未 open 时 send() 的暂存队列；onopen 后一次性 flush。
   * 解决 ICE connected 与 SCTP open 不同步导致 commit 后首批业务消息被静默丢弃的问题。
   */
  private pendingSends: string[] = [];
  private closed = false;

  constructor(pc: any, mod: WrtcModule, role: "offerer" | "answerer") {
    this.pc = pc;
    this.mod = mod;
    this.role = role;

    pc.onicecandidate = (event: any) => {
      const c = event?.candidate;
      if (!c || !c.candidate) {
        return;
      }
      // 默认禁用 TURN：丢弃 typ relay candidate，确保严格 P2P 模式下不会出现
      // 通过 TURN 中转的隐式连接。常规 auto 模式下也不需要 TURN（Relay 已经
      // 提供 TURN 等价能力），因此对所有路径生效，无需额外开关。
      if (typeof c.candidate === "string" && / typ relay\b/.test(c.candidate)) {
        return;
      }
      const init: IceCandidateInit = {
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
      };
      for (const handler of this.candidateHandlers) {
        handler(init);
      }
    };

    const emitState = () => {
      const state = this.resolveState();
      for (const handler of this.stateHandlers) {
        handler(state);
      }
    };
    pc.oniceconnectionstatechange = emitState;
    pc.onconnectionstatechange = emitState;

    if (this.role === "offerer") {
      this.attachDataChannel(pc.createDataChannel("omniwork"));
    } else {
      pc.ondatachannel = (event: any) => {
        this.attachDataChannel(event.channel);
      };
    }
  }

  private resolveState(): PeerState {
    const raw =
      (this.pc.connectionState as string | undefined) ??
      (this.pc.iceConnectionState as string | undefined);
    switch (raw) {
      case "new":
        return "new";
      case "connecting":
      case "checking":
        return "connecting";
      case "connected":
      case "completed":
        return "connected";
      case "disconnected":
        return "disconnected";
      case "failed":
        return "failed";
      case "closed":
        return "closed";
      default:
        return "new";
    }
  }

  private attachDataChannel(channel: any): void {
    this.dataChannel = channel;
    try {
      channel.binaryType = "arraybuffer";
    } catch {
      /* ignore: 部分实现不支持赋值 */
    }
    channel.onopen = () => {
      // SCTP 握手完成：先 flush 暂存的业务消息，再向上层广播 connected。
      this.flushPendingSends();
      for (const handler of this.stateHandlers) {
        handler("connected");
      }
    };
    channel.onclose = () => {
      for (const handler of this.stateHandlers) {
        handler("closed");
      }
    };
    channel.onmessage = (event: any) => {
      const decoded = decodeDataChannelMessage(event?.data);
      if (decoded === null) {
        return;
      }
      for (const handler of this.dataHandlers) {
        handler(decoded);
      }
    };
  }

  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer.sdp as string;
  }

  async createAnswer(): Promise<string> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer.sdp as string;
  }

  async setRemoteDescription(
    sdp: string,
    type: "offer" | "answer",
  ): Promise<void> {
    const desc = new this.mod.RTCSessionDescription({ sdp, type });
    await this.pc.setRemoteDescription(desc);
  }

  async addIceCandidate(c: IceCandidateInit): Promise<void> {
    const candidate = new this.mod.RTCIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
    });
    await this.pc.addIceCandidate(candidate);
  }

  onLocalCandidate(handler: CandidateHandler): () => void {
    this.candidateHandlers.add(handler);
    return () => {
      this.candidateHandlers.delete(handler);
    };
  }

  onDataMessage(handler: DataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => {
      this.dataHandlers.delete(handler);
    };
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  send(data: string): void {
    if (this.closed) {
      return;
    }
    const channel = this.dataChannel;
    if (channel && channel.readyState === "open") {
      channel.send(data);
      return;
    }
    if (channel && channel.readyState === "connecting") {
      // SCTP 握手中：暂存到 channel.onopen 时再 flush；超出上限丢最旧的。
      if (this.pendingSends.length >= PENDING_SEND_LIMIT) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(data);
      return;
    }
    // closing / closed / 未创建：静默丢弃，由上层 health check 触发降级。
  }

  getBufferedAmount(): number {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return 0;
    }
    const value = this.dataChannel.bufferedAmount;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pendingSends = [];
    try {
      this.dataChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }

  private flushPendingSends(): void {
    if (this.pendingSends.length === 0) {
      return;
    }
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open") {
      return;
    }
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const data of queued) {
      try {
        channel.send(data);
      } catch {
        /* ignore: 单条失败不影响后续 flush */
      }
    }
  }
}

export function createMobileWebRtcPeerAdapter(
  opts: MobileWebRtcPeerAdapterOptions,
): WebRtcPeerAdapter | null {
  const mod = loadWrtc();
  if (!mod) {
    return null;
  }
  const pc = new mod.RTCPeerConnection({ iceServers: opts.iceServers });
  return new MobileWebRtcPeerAdapter(pc, mod, opts.role);
}

function decodeDataChannelMessage(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return decodeUtf8Bytes(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return decodeUtf8Bytes(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  return null;
}

function decodeUtf8Bytes(bytes: Uint8Array): string | null {
  try {
    let result = "";
    for (let index = 0; index < bytes.length; ) {
      const first = bytes[index];
      if ((first & 0x80) === 0) {
        result += String.fromCharCode(first);
        index += 1;
        continue;
      }
      if ((first & 0xe0) === 0xc0) {
        const second = bytes[index + 1];
        if (second === undefined || (second & 0xc0) !== 0x80) {
          return null;
        }
        result += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f));
        index += 2;
        continue;
      }
      if ((first & 0xf0) === 0xe0) {
        const second = bytes[index + 1];
        const third = bytes[index + 2];
        if (
          second === undefined ||
          third === undefined ||
          (second & 0xc0) !== 0x80 ||
          (third & 0xc0) !== 0x80
        ) {
          return null;
        }
        result += String.fromCharCode(
          ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
        );
        index += 3;
        continue;
      }
      if ((first & 0xf8) === 0xf0) {
        const second = bytes[index + 1];
        const third = bytes[index + 2];
        const fourth = bytes[index + 3];
        if (
          second === undefined ||
          third === undefined ||
          fourth === undefined ||
          (second & 0xc0) !== 0x80 ||
          (third & 0xc0) !== 0x80 ||
          (fourth & 0xc0) !== 0x80
        ) {
          return null;
        }
        const codePoint =
          ((first & 0x07) << 18) |
          ((second & 0x3f) << 12) |
          ((third & 0x3f) << 6) |
          (fourth & 0x3f);
        const adjusted = codePoint - 0x10000;
        result += String.fromCharCode(
          0xd800 | (adjusted >> 10),
          0xdc00 | (adjusted & 0x3ff),
        );
        index += 4;
        continue;
      }
      return null;
    }
    return result;
  } catch {
    return null;
  }
}
