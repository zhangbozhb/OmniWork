type ExtraConfig = {
  defaultRelayUrl?: string;
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
  terminal: {
    cols: extra.terminal?.cols ?? 100,
    rows: extra.terminal?.rows ?? 32,
  },
};
