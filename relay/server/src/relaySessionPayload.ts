import type { AppInfoPayload, MobileConnectPayload } from "@omniwork/protocol-ts";

import type { RelayAppInfo } from "./relayTypes.ts";

/**
 * 构造 auth.proof 限流键：(key_id, device_id, remote_ip)。
 * 任一字段缺失时使用 "_" 占位，确保未携带身份的连接也会被限流。
 */
export function buildAuthRateLimitKey(
  keyId: string | undefined,
  deviceId: string | undefined,
  remoteIp: string | undefined,
): string {
  return [keyId ?? "_", deviceId ?? "_", remoteIp ?? "_"].join("|");
}

export function appInfoFromMobileConnect(
  payload: MobileConnectPayload,
): RelayAppInfo {
  return {
    instanceId: payload.app_info.instance_id,
    runtimeId: payload.app_info.runtime_id,
    device: payload.app_info.device,
    app: payload.app_info.app,
  };
}

export function appInfoToPayload(appInfo: RelayAppInfo): AppInfoPayload {
  return {
    instance_id: appInfo.instanceId,
    runtime_id: appInfo.runtimeId,
    device: appInfo.device,
    app: appInfo.app,
  };
}
