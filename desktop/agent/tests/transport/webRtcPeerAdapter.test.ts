import { strict as assert } from "node:assert";

import { __testing } from "../../src/transport/webRtcPeerAdapter.ts";

type FakeChannel = {
  readyState: "connecting" | "open" | "closing" | "closed";
  sent: string[];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  send: (data: string) => void;
};

class FakePeerConnection {
  public ondatachannel?: (event: { channel: FakeChannel & { label: string } }) => void;
  public onicecandidate?: (event: { candidate: unknown }) => void;
  public onconnectionstatechange?: () => void;
  public oniceconnectionstatechange?: () => void;
  public readonly channels = new Map<string, FakeChannel & { label: string }>();
  public connectionState = "new";
  public iceConnectionState = "new";

  createDataChannel(label: string): FakeChannel & { label: string } {
    const channel = createFakeChannel(label, "connecting");
    this.channels.set(label, channel);
    return channel;
  }
}

function createFakeChannel(
  label: string,
  readyState: FakeChannel["readyState"] = "connecting",
): FakeChannel & { label: string } {
  return {
    label,
    readyState,
    sent: [],
    send(data: string): void {
      this.sent.push(data);
    },
  };
}

// 1. offerer：channel 已存在但尚未 open 时，send 应 pending 到 onopen 后 flush。
{
  const pc = new FakePeerConnection();
  const adapter = new __testing.AgentWebRtcPeerAdapter(pc, "offerer");
  const control = pc.channels.get("omniwork-control");
  assert.ok(control, "offerer should create control data channel");

  adapter.send("early-control", "control");
  assert.deepEqual(control.sent, []);

  control.readyState = "open";
  control.onopen?.();
  assert.deepEqual(control.sent, ["early-control"]);
}

// 2. answerer：目标 channel 尚未通过 ondatachannel attach 时，send 也应 pending。
{
  const pc = new FakePeerConnection();
  const adapter = new __testing.AgentWebRtcPeerAdapter(pc, "answerer");

  adapter.send("early-display", "display");
  const display = createFakeChannel("omniwork-display", "open");
  pc.ondatachannel?.({ channel: display });

  assert.deepEqual(display.sent, ["early-display"]);
}

console.log("webrtc-peer-adapter tests passed");
