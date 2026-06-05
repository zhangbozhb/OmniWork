import {
  isTransportPreference,
  type TransportPreference,
} from "@omniwork/protocol-ts";

type ExtraConfig = {
  defaultRelayUrl?: string;
  /**
   * App 出厂默认的传输偏好；用户在 Devices 页可覆盖（持久化到 AsyncStorage）。
   * 详见 docs/relay-architecture.md "传输偏好可控"小节。
   */
  transportPreference?: TransportPreference;
  terminal?: {
    cols?: number;
    rows?: number;
  };
};

type AppGlobal = typeof globalThis & {
  __OMNIWORK_APP_CONFIG__?: ExtraConfig;
};

const extra = (globalThis as AppGlobal).__OMNIWORK_APP_CONFIG__ ?? {};

export const appConfig = {
  defaultRelayUrl: extra.defaultRelayUrl ?? "wss://relay.company.example/mobile",
  transportPreference: isTransportPreference(extra.transportPreference)
    ? extra.transportPreference
    : ("auto" as TransportPreference),
  terminal: {
    cols: extra.terminal?.cols ?? 100,
    rows: extra.terminal?.rows ?? 32,
  },
};
