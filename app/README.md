# OmniWork App

Android/iOS installable app built with React Native CLI. The same React Native
codebase also exposes a Web single-page app through `react-native-web` for
browser access without introducing a second UI stack.

## Current MVP

- Pairing screen for Relay URL, Mac device ID, and the 32-character temporary key.
- Secure pairing persistence through platform secure storage.
- Relay-driven device connection and HMAC key proof.
- Workspace-first session management through the Mac Agent, with a Workspace Detail bottom-tab layout for `Sessions`, `Git`, and `Files`.
- Sessions are grouped by Agent Provider inside each Workspace, with secondary management actions moved behind a `More` dialog.
- Workspace picker for new sessions, using Mac Agent discovered remote project directories instead of requiring users to type common working directories.
- Read-only workspace file browser for viewing files inside the selected workspace boundary.
- Read-only Git status and diff views, shown only for workspaces that the Mac Agent reports as Git repositories.
- User-editable session titles, with Terminal screens using the session title as the primary header.
- Terminal screen with native React Native terminal snapshot surface, polling refresh, and quick keys.
- Shared SVG icon system through `react-native-svg`, used by icon-first buttons across pairing, devices, sessions, terminal, scanner, and confirmation flows.
- Shared TypeScript protocol and terminal input helpers.
- Configured Agent Provider metadata from the Mac Agent for capability display and session creation, with App-local hide, sort, and default-provider preferences.
- Shared ConfirmDialog UI for destructive actions across Android, iOS, and Web.
- Web SPA entry that reuses the React Native screens and disables QR scanning.

## Run

Install workspace dependencies first, then:

```sh
pnpm --filter @omniwork/app start
```

Web SPA development server:

```sh
pnpm --filter @omniwork/app web:dev
```

Web production build:

```sh
pnpm --filter @omniwork/app web:build
```

The Web build outputs static SPA assets under `app/dist/web`. Deployment should
serve `index.html` for all routes.

Three-target verification:

```sh
pnpm --filter @omniwork/app verify:targets
```

This runs TypeScript checking, iOS Metro bundle, Android Metro bundle, and the
Web production build.

## Installable Builds

Android release APK:

```sh
pnpm --filter @omniwork/app build:android:apk
```

Android release AAB:

```sh
pnpm --filter @omniwork/app build:android:aab
```

iOS release build:

```sh
xcodebuild -workspace ios/OmniWork.xcworkspace -scheme OmniWork -configuration Release -sdk iphoneos archive
```

Local native runs:

```sh
pnpm --filter @omniwork/app android
pnpm --filter @omniwork/app ios
```

The terminal surface is implemented as native React Native UI for the MVP. A higher-fidelity native terminal renderer can be added later if the TUI needs full ANSI behavior.

## Web Support

The Web target is intentionally kept in the React Native stack:

- UI uses the same React Native screens via `react-native-web`.
- Platform differences live under `src/platform/` or small `.native/.web` components.
- Web pairing does not use camera scanning; users paste the Relay URL, device ID, and temporary key, or open a URL containing `pairing=` or `relay_url`/`device_id`/`key` query parameters.
- Native storage continues to use Keychain, while Web uses browser `localStorage`.
- Native WebRTC continues to use `react-native-webrtc`, while Web uses the browser `RTCPeerConnection`.

## Native Projects

This package no longer uses Expo or EAS. Add or generate the `android/` and `ios/` native projects with React Native CLI before running local native builds.
