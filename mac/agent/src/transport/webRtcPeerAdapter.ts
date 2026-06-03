import {
  P2P_CHANNEL_KINDS,
  P2P_CHANNEL_LABELS,
  p2pChannelKindFromLabel,
} from "../../../../packages/protocol-ts/src/index.ts";
import type {
  IceCandidateInit,
  P2pChannelKind,
  PeerState,
  WebRtcPeerAdapter,
} from "../../../../packages/protocol-ts/src/index.ts";

interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface AgentWebRtcPeerAdapterOptions {
  iceServers: IceServerLike[];
  role: "offerer" | "answerer";
}

type CandidateHandler = (c: IceCandidateInit) => void;
type DataHandler = (data: string, channel?: P2pChannelKind) => void;
type StateHandler = (state: PeerState) => void;

interface WrtcModule {
  RTCPeerConnection: new (config: { iceServers: IceServerLike[] }) => any;
}

let wrtcModulePromise: Promise<WrtcModule | null> | null = null;

async function loadWrtc(): Promise<WrtcModule | null> {
  if (wrtcModulePromise) {
    return wrtcModulePromise;
  }
  wrtcModulePromise = (async () => {
    try {
      // 使用变量包装模块标识符，避免 TypeScript 在依赖未安装时报模块不存在。
      const moduleName = "@roamhq/wrtc";
      const mod = (await import(moduleName)) as unknown as
        | WrtcModule
        | { default?: WrtcModule };
      const resolved =
        (mod as { RTCPeerConnection?: unknown }).RTCPeerConnection
          ? (mod as WrtcModule)
          : ((mod as { default?: WrtcModule }).default ?? null);
      return resolved;
    } catch (error) {
      console.warn(
        "[omniwork-agent] @roamhq/wrtc unavailable; P2P upgrade disabled",
        { error: (error as Error)?.message },
      );
      return null;
    }
  })();
  return wrtcModulePromise;
}

/**
 * dataChannel 尚未 open 时 send() 的最多暂存条数，防御 SCTP 握手卡顿场景。
 */
const PENDING_SEND_LIMIT = 256;
class AgentWebRtcPeerAdapter implements WebRtcPeerAdapter {
  private readonly pc: any;
  private readonly role: "offerer" | "answerer";
  private readonly dataChannels = new Map<P2pChannelKind, any>();
  private readonly candidateHandlers = new Set<CandidateHandler>();
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  /**
   * dataChannel 尚未 open 时 send() 的暂存队列；onopen 后一次性 flush。
   * 解决 ICE connected 与 SCTP open 不同步导致 commit 后首批业务消息被静默丢弃的问题。
   */
  private pendingSends = new Map<P2pChannelKind, string[]>();
  private closed = false;

  constructor(pc: any, role: "offerer" | "answerer") {
    this.pc = pc;
    this.role = role;

    pc.onicecandidate = (event: any) => {
      const c = event?.candidate;
      if (!c || !c.candidate) {
        return;
      }
      // 默认禁用 TURN：丢弃 typ relay candidate，避免严格 P2P 模式下出现
      // 通过 TURN 中转的隐式连接。Relay 已经提供 TURN 等价能力，常规 auto
      // 模式也不依赖 TURN，因此对所有路径生效。
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
      pc.ondatachannel = (event: any) => {
        this.attachDataChannel(
          p2pChannelKindFromLabel(event.channel?.label),
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

  private attachDataChannel(kind: P2pChannelKind, channel: any): void {
    this.dataChannels.set(kind, channel);
    // 与浏览器 RTCDataChannel 互通时对端可能把 string 落到 binary 通道，
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
        for (const handler of this.stateHandlers) {
          handler("connected");
        }
      }
    };
    channel.onclose = () => {
      if (kind === "control") {
        for (const handler of this.stateHandlers) {
          handler("closed");
        }
      }
    };
    channel.onmessage = (event: any) => {
      const decoded = decodeDataChannelMessage(event?.data);
      if (decoded === null) {
        return;
      }
      for (const handler of this.dataHandlers) {
        handler(decoded, kind);
      }
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
    await this.pc.setRemoteDescription({ sdp, type });
  }

  async addIceCandidate(c: IceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
    });
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
    if (this.closed) {
      return;
    }
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
    if (this.closed) {
      return;
    }
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
    if (!pending || pending.length === 0) {
      return;
    }
    const channel = this.dataChannels.get(kind);
    if (!channel || channel.readyState !== "open") {
      return;
    }
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

export const __testing = {
  AgentWebRtcPeerAdapter,
};

export async function createAgentWebRtcPeerAdapter(
  opts: AgentWebRtcPeerAdapterOptions,
): Promise<WebRtcPeerAdapter | null> {
  const wrtc = await loadWrtc();
  if (!wrtc) {
    return null;
  }
  const pc = new wrtc.RTCPeerConnection({ iceServers: opts.iceServers });
  return new AgentWebRtcPeerAdapter(pc, opts.role);
}

/**
 * DataChannel 上 string 消息的兼容解码：
 * - 同实现互通通常给 string；
 * - 与浏览器互通时 @roamhq/wrtc 可能给 ArrayBuffer / Buffer / TypedArray。
 *
 * 任意非 UTF-8 / 非字符串载荷一律忽略。
 */
function decodeDataChannelMessage(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(data)) {
    return (data as Buffer).toString("utf-8");
  }
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
