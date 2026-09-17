# Changelog

All notable release changes to OmniWork are documented in this file.

## Unreleased

### Changed

- Replace shared pairing keys and Noise NNpsk0 with protocol v2 Ed25519
  identities, explicit Agent/App authorization, and signed ephemeral X25519
  E2E sessions.
- Make pairing/share links target-only and add Relay App session tokens for
  native and cross-site Web clients when `email_link` authentication is enabled.
- Add Relay Admin Agent approvals and Desktop Agent Admin App
  approve/reject/revoke/remove workflows with English and Simplified Chinese UI.
- Upgrade the App to React Native 0.87.1 and React 19.2.3, move iOS startup to
  the UIKit scene lifecycle, and update the Android build toolchain.
- Replace `react-native-quick-sqlite` with `@op-engineering/op-sqlite` while
  preserving the existing native Agent Inbox database locations.
- Ignore stale asynchronous WebRTC peer results after a connection is closed,
  replaced, or force-closed.

## 0.1.1 - 2026-07-24

### Fixed

- Compile npm runtime packages to JavaScript and publish declaration files.
- Make the desktop agent and Relay server runnable after npm installation.
- Add package READMEs, npm metadata, repository links, and MIT licensing.
- Verify packed artifacts in a clean temporary installation before publishing.

## 0.1.0 - 2026-07-23

- Initial npm publication under the `@omni-work` scope.
