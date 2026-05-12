# OmniWork App

Android/iOS installable app built with React Native + Expo. The deliverables are APK and IPA files, not a web page or PWA.

## Current MVP

- Pairing screen for Relay URL, Mac device ID, and the 32-character temporary key.
- Secure pairing persistence through platform secure storage.
- Relay-driven device connection and HMAC key proof.
- Session list and session creation through the Mac Agent.
- Terminal screen with native React Native terminal snapshot surface, polling refresh, and quick keys.
- Shared TypeScript protocol and terminal input helpers.

## Run

Install workspace dependencies first, then:

```sh
pnpm --filter @omniwork/app start
```

## Installable Builds

Android APK:

```sh
pnpm --filter @omniwork/app build:apk
```

iOS IPA:

```sh
pnpm --filter @omniwork/app build:ipa
```

Local native runs:

```sh
pnpm --filter @omniwork/app android
pnpm --filter @omniwork/app ios
```

The terminal surface is implemented as native React Native UI for the MVP. A higher-fidelity native terminal renderer can be added later if the TUI needs full ANSI behavior.
