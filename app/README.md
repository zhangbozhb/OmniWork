# OmniWork App

Android/iOS installable app built with React Native CLI. The same React Native
codebase also exposes a Web single-page app through `react-native-web` for
browser access without introducing a second UI stack.

## MVP

- Pairing screen for Relay URL, Mac device ID, and the 32-character temporary key.
- Secure pairing persistence through platform secure storage.
- Relay-driven device connection and HMAC key proof.
- Workspace-first session management through the Mac Agent, with a Workspace Detail bottom-tab layout for `Sessions`, `Git`, and `Files`.
- Sessions are grouped by Agent Provider inside each Workspace, with secondary management actions moved behind a `More` dialog.
- Workspace picker for new sessions, using Mac Agent discovered remote project directories instead of requiring users to type common working directories.
- Read-only workspace file browser for viewing files inside the selected workspace boundary.
- Read-only Git status and diff views, shown only for workspaces that the Mac Agent reports as Git repositories.
- User-editable session titles, with Terminal screens using the session title as the primary header.
- Terminal screen with Native WebView/xterm rendering, local generated xterm assets, and quick keys.
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

Native WebView terminal assets are generated from the installed `@xterm/*`
packages before app start, bundle, build, typecheck, lint, and test scripts.
Run `pnpm --filter @omniwork/app generate:xterm-assets` manually after changing
xterm dependencies if you need to inspect the generated file before packaging.

## Installable Builds

Android release APK:

```sh
pnpm --filter @omniwork/app build:android:apk
```

Android release AAB:

```sh
pnpm --filter @omniwork/app build:android:aab
```

The Android Gradle build reads `OMNIWORK_APP_VERSION`,
`OMNIWORK_ANDROID_VERSION_CODE`, and `OMNIWORK_ANDROID_PACKAGE` for
`versionName` / `versionCode` / `applicationId`. Provide
`OMNIWORK_RELEASE_KEYSTORE`, `OMNIWORK_RELEASE_KEYSTORE_PASSWORD`,
`OMNIWORK_RELEASE_KEY_ALIAS`, and `OMNIWORK_RELEASE_KEY_PASSWORD` for a real
release signature; missing values fall back to the debug signing config (only
useful for CI smoke artifacts, not for distribution). The current
`AndroidManifest.xml` hard-codes `usesCleartextTraffic="true"` so release builds
can pair against `ws://` relays during testing — flip it back to `"false"` and
switch the relay to `wss://` before shipping.

iOS release build (signed):

```sh
pnpm --filter @omniwork/app build:ios
```

This runs `app/scripts/ensureIosPods.mjs` before
`app/scripts/buildIosRelease.mjs`; the Pods step skips `pod install` when
`Podfile.lock` already matches `Pods/Manifest.lock`, then invokes
`react-native build-ios --mode Release`. It requires
`OMNIWORK_IOS_DEVELOPMENT_TEAM` and `OMNIWORK_IOS_PROVISIONING_PROFILE` (CI
injected) and exits with a clear error if either is missing.
`OMNIWORK_IOS_CODE_SIGN_STYLE` (default `Manual`),
`OMNIWORK_IOS_CODE_SIGN_IDENTITY` (default `Apple Distribution`),
`OMNIWORK_IOS_BUNDLE_ID`, `OMNIWORK_APP_VERSION`, and
`OMNIWORK_IOS_BUILD_NUMBER` are exported for the OmniWork app target's Xcode
build settings. They are not passed as global `xcodebuild` overrides, so Pods
targets do not receive the app provisioning profile.

iOS unsigned smoke build (local / CI compile check, do not distribute):

```sh
pnpm --filter @omniwork/app build:ios:dev
```

Prepare the iOS workspace for building in Xcode:

```sh
pnpm --filter @omniwork/app setup:ios
```

Use `pnpm --filter @omniwork/app pods:ios` to force a full `pod install` after
native dependency changes.

See [app/.env.example](./.env.example) for the full list of release
environment variables.

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
- Web pairing does not use camera scanning; users paste the Relay URL, device ID, and temporary key, or open a plaintext or encrypted URL containing `pairing=`. Encrypted links prompt for the 4-digit password before importing the device.
- Native storage continues to use Keychain, while Web stores pairing data in browser `sessionStorage` and clears the legacy `localStorage` key.
- Web P2P uses the browser WebRTC API when available; browsers without WebRTC stay on the relay path or fail in direct-only mode.

## Native Projects

This package no longer uses Expo or EAS. Add or generate the `android/` and `ios/` native projects with React Native CLI before running local native builds.
