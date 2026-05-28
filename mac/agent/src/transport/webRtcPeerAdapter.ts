import type {
  IceCandidateInit,
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
type DataHandler = (data: string) => void;
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
    // 与浏览器 RTCDataChannel 互通时对端可能把 string 落到 binary 通道，
    // 这里强制 binaryType=arraybuffer 并在 onmessage 中统一解码为 string。
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
