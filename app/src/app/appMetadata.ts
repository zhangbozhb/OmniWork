import type { AppClientPlatform, AppInfoPayload } from "@omniwork/protocol-ts";

import { appConfig } from "./appConfig.ts";

export interface AppMetadataOptions {
  name?: string;
  platform?: AppClientPlatform;
  version?: string;
  deviceName?: string;
  os?: string;
  osVersion?: string;
  privateNetworkHash?: string;
  capabilities?: string[];
}

export function createAppInfo(
  instanceId: string,
  runtimeId: string,
  options: AppMetadataOptions = {},
): AppInfoPayload {
  return {
    instance_id: instanceId,
    runtime_id: runtimeId,
    device: {
      name: options.deviceName,
      platform: options.platform ?? defaultAppPlatform(),
      os: options.os,
      os_version: options.osVersion,
      private_network_hash: options.privateNetworkHash,
    },
    app: {
      name: options.name ?? appConfig.appName,
      version: options.version ?? appConfig.appVersion,
      capabilities: options.capabilities,
    },
  };
}

function defaultAppPlatform(): AppClientPlatform {
  return typeof window === "undefined" ? "desktop" : "web";
}
