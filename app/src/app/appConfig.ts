import {
  isTransportPreference,
  type TransportPreference,
} from "@omniwork/protocol-ts";

type ExtraConfig = {
  defaultRelayUrl?: string;
  appVersion?: string;
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
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const appGlobal = globalThis as AppGlobal;
const extra = appGlobal.__OMNIWORK_APP_CONFIG__ ?? {};
const env = appGlobal.process?.env ?? {};

export const appConfig = {
  appName: "OmniWork",
  appVersion: extra.appVersion ?? env.OMNIWORK_APP_VERSION ?? "0.1.0",
  defaultRelayUrl:
    extra.defaultRelayUrl ??
    env.OMNIWORK_DEFAULT_RELAY_URL ??
    inferSameOriginRelayUrl() ??
    "",
  transportPreference: isTransportPreference(extra.transportPreference)
    ? extra.transportPreference
    : ("auto" as TransportPreference),
  terminal: {
    cols: extra.terminal?.cols ?? 100,
    rows: extra.terminal?.rows ?? 32,
  },
};

function inferSameOriginRelayUrl(): string | undefined {
  const location = globalThis.location;
  if (!location?.host || !["http:", "https:"].includes(location.protocol)) {
    return undefined;
  }

  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${location.host}/relay/ws/mobile`;
}
