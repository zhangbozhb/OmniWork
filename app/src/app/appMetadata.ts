import type { AppClientPlatform, AppInfoPayload } from "@omniwork/protocol-ts";

import { appConfig } from "./appConfig.ts";

export interface AppMetadataOptions {
  name?: string;
  platform?: AppClientPlatform;
  version?: string;
  deviceName?: string;
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
    name: options.name ?? appConfig.appName,
    device_name: options.deviceName,
    platform: options.platform ?? defaultAppPlatform(),
    version: options.version ?? appConfig.appVersion,
    capabilities: options.capabilities,
  };
}

function defaultAppPlatform(): AppClientPlatform {
  return typeof window === "undefined" ? "desktop" : "web";
}
