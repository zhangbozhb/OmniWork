import type { ExpoConfig } from "expo/config";

const defaultRelayUrl = process.env.EXPO_PUBLIC_DEFAULT_RELAY_URL ?? "wss://relay.company.example/mobile";
const appVersion = process.env.OMNIWORK_APP_VERSION ?? "0.1.0";
const iosBundleIdentifier = process.env.OMNIWORK_IOS_BUNDLE_ID ?? "com.omniwork.mobile";
const androidPackage = process.env.OMNIWORK_ANDROID_PACKAGE ?? "com.omniwork.mobile";

const config: ExpoConfig = {
  name: "OmniWork",
  slug: "omniwork",
  owner: process.env.EXPO_OWNER,
  version: appVersion,
  scheme: "omniwork",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  plugins: ["expo-secure-store"],
  ios: {
    bundleIdentifier: iosBundleIdentifier,
    buildNumber: process.env.OMNIWORK_IOS_BUILD_NUMBER ?? "1",
    supportsTablet: true,
    infoPlist: {
      NSLocalNetworkUsageDescription:
        "OmniWork connects to your Mac Agent on the company network when local relay testing is enabled.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: androidPackage,
    versionCode: Number(process.env.OMNIWORK_ANDROID_VERSION_CODE ?? "1"),
    permissions: ["INTERNET"],
  },
  extra: {
    defaultRelayUrl,
    terminal: {
      cols: 100,
      rows: 32,
    },
    eas: {
      projectId: process.env.EAS_PROJECT_ID,
    },
  },
};

export default config;
