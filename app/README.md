# OmniWork App

Android/iOS installable app built with React Native CLI. The same React Native
codebase also exposes a Web single-page app through `react-native-web` for
browser access without introducing a second UI stack.

## MVP

- Target pairing-link import with Desktop Agent Admin approval by default.
- Long-term App identity in platform secure storage. Pairing links and saved
  targets contain the Relay URL and Agent device ID; the App verifies the
  Relay-provided Agent public key during authentication. Settings displays the
  current `APP1-...` ID for comparison with Agent Admin without exposing the
  private key.
- Relay-driven, mutually signed App-Agent authentication.
- Workspace-first session management through the connected computer, with a Workspace Detail bottom-tab layout for `Sessions`, `Git`, and `Files`.
- Sessions are grouped by Terminal Provider inside each Workspace, with secondary management actions moved behind a `More` dialog.
- Workspace picker for new sessions, using computer-discovered remote project directories instead of requiring users to type common working directories.
- Optional managed-worktree isolation when creating a Session in a Git Workspace. The Desktop Agent creates an `omniwork/*` branch from the current `HEAD` and starts the Session in the managed worktree as one request.
- Workspace file browser and guarded UTF-8 text editor for supported files inside the selected workspace boundary.
- Git status/diff views and explicit file-level stage/unstage controls, shown only for workspaces that the connected computer reports as Git repositories. These controls modify only the Git index; discard, commit, push, and worktree deletion are not exposed.
- Git Review line notes are kept locally in the App, rejected after the reviewed `HEAD` changes, and sent as one revision prompt to a running structured Agent in the same Workspace.
- User-editable session titles, with Terminal screens using the session title as the primary header.
- Terminal screen with Native WebView/xterm rendering, local generated xterm assets, and quick keys.
- Shared SVG icon system through `react-native-svg`, used by icon-first buttons across pairing, devices, sessions, terminal, scanner, and confirmation flows.
- Shared TypeScript protocol and terminal input helpers.
- Configured Terminal Provider metadata from the connected computer for capability display and session creation, with App-local hide, sort, and default-provider preferences.
- Shared ConfirmDialog UI for destructive actions across Android, iOS, and Web.
- Web SPA entry that reuses the React Native screens and disables QR scanning.
- Codex, Claude Code, and TraeX structured sessions, with prompt
  submission, incremental conversation rendering, and a separate activity
  summary. Structured Surface events are synchronized from the Desktop Agent
  with a cursor after session discovery, so reconnecting clients can restore
  persisted timeline events. Pending command, file, permission, and user-input
  interactions are restored separately and can be answered from the Agent
  session screen. The prompt composer can browse the session Workspace and
  attach up to ten text-file references without uploading file contents from
  the App.
- Local Agent message inbox with read/handled state, bulk deletion, message
  actions, and notification preferences. The App synchronizes the Desktop
  inbox after Relay or P2P authentication, and Workbench session rows surface
  pending approval or input state. APNs/FCM push delivery is not yet connected.
- English and Simplified Chinese UI, terminal text-size preferences, and
  Relay/P2P connection preferences.
- Native gesture app lock with configurable auto-lock timing. The Web target
  intentionally does not persist app-lock configuration.

## Run

Install workspace dependencies first, then:

```sh
pnpm --filter @omni-work/app start
```

Web SPA development server:

```sh
pnpm --filter @omni-work/app web:dev
```

The development server proxies same-origin `/relay/ws/*` WebSocket requests to
the local Relay at `127.0.0.1:8787`. Set `OMNIWORK_WEB_RELAY_URL` to override
the default Relay URL shown by the Web pairing form.

Web production build:

```sh
pnpm --filter @omni-work/app web:build
```

The Web build outputs static SPA assets under `app/dist/web`. Deployment should
serve `index.html` for all routes.

Three-target verification:

```sh
pnpm --filter @omni-work/app verify:targets
```

This runs TypeScript checking, iOS Metro bundle, Android Metro bundle, and the
Web production build.

Native WebView terminal and editor assets are generated from the installed
`@xterm/*` and CodeMirror packages before app start, bundle, build, typecheck,
lint, and test scripts.
Run `pnpm --filter @omni-work/app generate:xterm-assets` manually after changing
xterm or CodeMirror dependencies if you need to inspect the generated files
before packaging.

## Toolchain Baseline

- React Native `0.87.1` with React `19.2.3` and the public Strict TypeScript API.
- Node.js `^22.13.0`, `^24.3.0`, or `>=26.0.0`.
- iOS `15.1` or newer, CocoaPods `1.16+`, and Hermes V1 `250829098.0.17`.
- The iOS host uses the UIKit scene lifecycle; `SceneDelegate` owns the app
  window and `Info.plist` must retain its `UIApplicationSceneManifest`.
- Android Build Tools / compile SDK `37`, target SDK `36`, Gradle `9.4.1`,
  Android Gradle Plugin `9`, Kotlin `2.2.0`, and JDK `17+`.

Native Agent inbox storage uses `@op-engineering/op-sqlite`. Its database
location is pinned to the former `react-native-quick-sqlite` locations
(`Documents` on iOS and `filesDir` on Android) so an app upgrade keeps existing
local messages.

## Installable Builds

Android release APK:

```sh
pnpm --filter @omni-work/app build:android:apk
```

Android release AAB:

```sh
pnpm --filter @omni-work/app build:android:aab
```

The Android Gradle build reads `OMNIWORK_APP_VERSION`,
`OMNIWORK_ANDROID_VERSION_CODE`, and `OMNIWORK_ANDROID_PACKAGE` for
`versionName` / `versionCode` / `applicationId`. Provide
`OMNIWORK_RELEASE_KEYSTORE`, `OMNIWORK_RELEASE_KEYSTORE_PASSWORD`,
`OMNIWORK_RELEASE_KEY_ALIAS`, and `OMNIWORK_RELEASE_KEY_PASSWORD` for a real
release signature; missing values fall back to the debug signing config (only
useful for local smoke artifacts, not for distribution). Set
`OMNIWORK_REQUIRE_RELEASE_SIGNING=true` to make incomplete signing
configuration fatal. The GitHub Release workflow always enables this strict
mode, requires `OMNIWORK_RELEASE_CERT_SHA256`, and verifies the built APK
certificate with `apksigner` before publishing. The current
`AndroidManifest.xml` hard-codes `usesCleartextTraffic="true"` so release builds
can pair against `ws://` relays during testing — flip it back to `"false"` and
switch the relay to `wss://` before shipping.

iOS release build (signed):

```sh
pnpm --filter @omni-work/app build:ios
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
pnpm --filter @omni-work/app build:ios:dev
```

Prepare the iOS workspace for building in Xcode:

```sh
pnpm --filter @omni-work/app setup:ios
```

Use `pnpm --filter @omni-work/app pods:ios` to force a full `pod install` after
native dependency changes.

See [app/.env.example](./.env.example) for the full list of release
environment variables.

Local native runs:

```sh
pnpm --filter @omni-work/app android
pnpm --filter @omni-work/app ios
```

The Native entry installs `crypto.getRandomValues`, `Buffer`, and UTF-8
`TextEncoder` / `TextDecoder` before loading protocol code. These globals are
provided by browsers but are required explicitly by Hermes for App identity
signatures and the encrypted session handshake.

For a physical iOS or Android device to use a local Relay, the Relay listener
must bind to a non-loopback interface, for example:

```yml
server:
  host: 0.0.0.0
  port: 8787
  allowPlaintextWs: true
```

Keep the Admin listener on `127.0.0.1`. The Web development server hides this
difference because it proxies `/relay/ws/*` to the loopback Relay itself.

The terminal surface uses xterm through Web/native WebView assets. The React
Native snapshot path is only a fallback for compatibility.

## Relay Sign-In

If Relay uses `auth.mode=email_link`, Native and cross-site Web Apps need an
independent Relay session token. Open that Relay's `https://<relay-host>/auth/`,
sign in as the enrolled Agent's owner, and click **Create App sign-in token**.
Paste the private token into **Relay sign-in token (optional)** on the device
details, link, or edit screen. For local `ws://` development, use `http://`;
use HTTPS and `wss://` in production because Relay sign-in precedes App-Agent E2E.

Enter or scan the target first, then enter the token and save. Scanning fills
the form so you can check the Relay before connecting. Same-site Web can use its Relay login cookie;
`auth.mode=none` needs no token. Shared links and QR codes never carry the token.
Importing the exact same Relay URL and device ID preserves a saved token unless
a new one is entered. Editing lets you replace or clear it; changing the Relay
origin clears it in manual entry, links, scans, and mode switches so it is not
sent to another Relay.

Tokens expire according to Relay's `auth.sessionTtlMs`; create a new one when
needed. Logging out of `/auth/` clears the displayed token and browser session,
but does not revoke independently issued App tokens. Relay login does not
replace local approval of this App in Desktop Agent Admin.

## Web Support

The Web target is intentionally kept in the React Native stack:

- UI uses the same React Native screens via `react-native-web`.
- Platform differences live under `src/platform/` or small `.native/.web` components.
- Web pairing does not use camera scanning; users enter the Relay URL and Agent
  device ID, paste a pairing link, or open a URL containing `pairing=`.
- Native stores the App identity in Keychain and target link configuration in
  secure storage. Web stores its non-extractable App private key in IndexedDB
  and target link configuration in browser storage. Web Relay session tokens
  are kept only in `sessionStorage`; `localStorage` contains the non-secret
  Relay URL, Agent device ID, and optional display name.
- Web P2P uses the browser WebRTC API when available; browsers without WebRTC stay on the relay path or fail in direct-only mode.
- `OMNIWORK_TERMINAL_STREAM_ENABLED=true` opts the App/Web into the experimental terminal byte stream path. The default remains the snapshot renderer for compatibility.

## Native Projects

This package does not use Expo or EAS. The React Native CLI `android/` and
`ios/` projects are checked in; use the documented setup/build commands rather
than regenerating them during a normal dependency install.
