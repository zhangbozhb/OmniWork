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

class AgentWebRtcPeerAdapter implements WebRtcPeerAdapter {
  private readonly pc: any;
  private readonly role: "offerer" | "answerer";
  private dataChannel: any = null;
  private readonly candidateHandlers = new Set<CandidateHandler>();
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private closed = false;

  constructor(pc: any, role: "offerer" | "answerer") {
    this.pc = pc;
    this.role = role;

    pc.onicecandidate = (event: any) => {
      const c = event?.candidate;
      if (!c || !c.candidate) {
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
    channel.onopen = () => {
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
      const data = event?.data;
      if (typeof data === "string") {
        for (const handler of this.dataHandlers) {
          handler(data);
        }
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
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return;
    }
    this.dataChannel.send(data);
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
