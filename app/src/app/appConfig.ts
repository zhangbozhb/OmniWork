import Constants from "expo-constants";

type ExtraConfig = {
  defaultRelayUrl?: string;
  terminal?: {
    cols?: number;
    rows?: number;
  };
};

const extra = (Constants.expoConfig?.extra ?? {}) as ExtraConfig;

export const appConfig = {
  defaultRelayUrl: extra.defaultRelayUrl ?? "wss://relay.company.example/mobile",
  terminal: {
    cols: extra.terminal?.cols ?? 100,
    rows: extra.terminal?.rows ?? 32,
  },
};
