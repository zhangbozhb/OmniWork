export type PairingTransport = "websocket" | "webrtc";

export const DEFAULT_PAIRING_TRANSPORT: PairingTransport = "websocket";

export interface PairingConfig {
  relayUrl: string;
  deviceId: string;
  key: string;
  keyId?: string;
  transport: PairingTransport;
}
