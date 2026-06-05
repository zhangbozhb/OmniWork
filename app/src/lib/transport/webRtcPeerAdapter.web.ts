import {
  P2P_CHANNEL_KINDS,
  P2P_CHANNEL_LABELS,
  p2pChannelKindFromLabel,
} from "@omniwork/protocol-ts";
import type {
  IceCandidateInit,
  P2pChannelKind,
  PeerState,
  WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";

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
type DataHandler = (data: string, channel?: P2pChannelKind) => void;
type StateHandler = (state: PeerState) => void;

interface BrowserWebRtcGlobals {
  RTCPeerConnection: typeof RTCPeerConnection;
  RTCSessionDescription: typeof RTCSessionDescription;
  RTCIceCandidate: typeof RTCIceCandidate;
}

/**
 * 在浏览器（Web/PWA）环境下加载原生 WebRTC API；缺失时返回 null，让 coordinator
 * 走 peer_unavailable 路径。
 */
function loadBrowserWebRtc(): BrowserWebRtcGlobals | null {
  const g = globalThis as unknown as Partial<BrowserWebRtcGlobals>;
  if (!g.RTCPeerConnection || !g.RTCSessionDescription || !g.RTCIceCandidate) {
    return null;
  }
  return {
    RTCPeerConnection: g.RTCPeerConnection,
    RTCSessionDescription: g.RTCSessionDescription,
    RTCIceCandidate: g.RTCIceCandidate,
  };
}

/**
 * dataChannel 尚未 open 时 send() 的最多暂存条数：
 * - 协商成功到 channel.onopen 之间通常只有几十毫秒；
 * - 上限主要用于防御异常场景（如 ICE connected 但 SCTP 永远握不上手），
 *   超出后丢弃最旧消息以避免内存膨胀。
 */
const PENDING_SEND_LIMIT = 256;
class BrowserWebRtcPeerAdapter implements WebRtcPeerAdapter {
  private readonly pc: RTCPeerConnection;
  private readonly mod: BrowserWebRtcGlobals;
  private readonly role: "offerer" | "answerer";
  private readonly dataChannels = new Map<P2pChannelKind, RTCDataChannel>();
  private readonly candidateHandlers = new Set<CandidateHandler>();
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  /**
   * dataChannel 尚未 open 时 send() 的暂存队列；onopen 后一次性 flush。
   * 解决 ICE connected 与 SCTP open 不同步导致 commit 后首批业务消息被静默丢弃的问题。
   */
  private pendingSends = new Map<P2pChannelKind, string[]>();
  private closed = false;

  constructor(
    pc: RTCPeerConnection,
    mod: BrowserWebRtcGlobals,
    role: "offerer" | "answerer",
  ) {
    this.pc = pc;
    this.mod = mod;
    this.role = role;

    pc.onicecandidate = (event) => {
      const c = event.candidate;
      if (!c || !c.candidate) return;
      // 与 native 一致：默认禁用 TURN，丢弃 typ relay candidate。
      if (typeof c.candidate === "string" && / typ relay\b/.test(c.candidate)) {
        return;
      }
      const init: IceCandidateInit = {
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
      };
      for (const handler of this.candidateHandlers) handler(init);
    };

    const emitState = () => {
      const state = this.resolveState();
      for (const handler of this.stateHandlers) handler(state);
    };
    pc.oniceconnectionstatechange = emitState;
    pc.onconnectionstatechange = emitState;

    if (this.role === "offerer") {
      this.attachDataChannel(
        "control",
        pc.createDataChannel(P2P_CHANNEL_LABELS.control),
      );
      this.attachDataChannel(
        "input",
        pc.createDataChannel(P2P_CHANNEL_LABELS.input),
      );
      this.attachDataChannel(
        "display",
        pc.createDataChannel(P2P_CHANNEL_LABELS.display, {
          ordered: false,
          maxRetransmits: 1,
        }),
      );
    } else {
      pc.ondatachannel = (event) => {
        this.attachDataChannel(
          p2pChannelKindFromLabel(event.channel.label),
          event.channel,
        );
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

  private attachDataChannel(
    kind: P2pChannelKind,
    channel: RTCDataChannel,
  ): void {
    this.dataChannels.set(kind, channel);
    // 与 @roamhq/wrtc 互通时对端可能把 string 落到 binary 通道，
    // 这里强制 binaryType=arraybuffer 并在 onmessage 中统一解码为 string。
    try {
      channel.binaryType = "arraybuffer";
    } catch {
      /* ignore: 部分实现不支持赋值 */
    }
    channel.onopen = () => {
      // SCTP 握手完成：先 flush 暂存的业务消息，再向上层广播 connected。
      this.flushPendingSends(kind);
      if (kind === "control") {
        for (const handler of this.stateHandlers) handler("connected");
      }
    };
    channel.onclose = () => {
      if (kind === "control") {
        for (const handler of this.stateHandlers) handler("closed");
      }
    };
    channel.onmessage = (event) => {
      const decoded = decodeDataChannelMessage(event.data);
      if (decoded === null) return;
      for (const handler of this.dataHandlers) handler(decoded, kind);
    };
    if (channel.readyState === "open") {
      this.flushPendingSends(kind);
    }
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

  send(data: string, channel: P2pChannelKind = "control"): void {
    if (this.closed) return;
    const dataChannel = this.dataChannels.get(channel);
    if (dataChannel && dataChannel.readyState === "open") {
      dataChannel.send(data);
      return;
    }
    if (!dataChannel || dataChannel.readyState === "connecting") {
      // SCTP 握手或 answerer 尚未收到 ondatachannel：暂存到 attach/onopen 时再 flush。
      this.queuePendingSend(channel, data);
      return;
    }
    // closing / closed：静默丢弃，由上层 health check 触发降级。
  }

  getBufferedAmount(channel?: P2pChannelKind): number {
    if (!channel) {
      return P2P_CHANNEL_KINDS.reduce(
        (total, kind) => total + this.getBufferedAmount(kind),
        0,
      );
    }
    const dataChannel = this.dataChannels.get(channel);
    if (!dataChannel || dataChannel.readyState !== "open") return 0;
    const value = dataChannel.bufferedAmount;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingSends.clear();
    for (const channel of this.dataChannels.values()) {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }

  private flushPendingSends(kind: P2pChannelKind): void {
    const pending = this.pendingSends.get(kind);
    if (!pending || pending.length === 0) return;
    const channel = this.dataChannels.get(kind);
    if (!channel || channel.readyState !== "open") return;
    const queued = pending;
    this.pendingSends.delete(kind);
    for (const data of queued) {
      try {
        channel.send(data);
      } catch {
        /* ignore: 单条失败不影响后续 flush */
      }
    }
  }

  private queuePendingSend(kind: P2pChannelKind, data: string): void {
    const pending = this.pendingSends.get(kind) ?? [];
    if (pending.length >= PENDING_SEND_LIMIT) {
      pending.shift();
    }
    pending.push(data);
    this.pendingSends.set(kind, pending);
  }
}

export function createMobileWebRtcPeerAdapter(
  opts: MobileWebRtcPeerAdapterOptions,
): WebRtcPeerAdapter | null {
  const mod = loadBrowserWebRtc();
  if (!mod) {
    console.warn(
      "[omniwork-app] Browser WebRTC API unavailable; P2P upgrade disabled",
    );
    return null;
  }
  const pc = new mod.RTCPeerConnection({ iceServers: opts.iceServers });
  return new BrowserWebRtcPeerAdapter(pc, mod, opts.role);
}

/**
 * DataChannel 上 string 消息的兼容解码：
 * - 浏览器原生通常给 string；
 * - 与 @roamhq/wrtc 互通时可能拿到 ArrayBuffer（已设 binaryType=arraybuffer）；
 * - 极少数实现会给 Blob（PWA 场景）。
 *
 * 任意非 UTF-8 / 非字符串载荷一律忽略。
 */
function decodeDataChannelMessage(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    try {
      return new TextDecoder("utf-8").decode(data);
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(data)) {
    try {
      const view = data as ArrayBufferView;
      return new TextDecoder("utf-8").decode(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      );
    } catch {
      return null;
    }
  }
  return null;
}
