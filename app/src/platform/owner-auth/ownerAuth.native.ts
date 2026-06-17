import * as Keychain from "react-native-keychain";

const OWNER_AUTH_KEY = "omniwork.ownerAuth";
const SERVICE = "com.omniwork.mobile.owner-auth";

export type OwnerAuthResult = "authenticated" | "cancelled" | "unavailable";

export async function authenticateDeviceOwner({
  title,
  subtitle,
  description,
  cancel,
}: {
  title: string;
  subtitle?: string;
  description?: string;
  cancel: string;
}): Promise<OwnerAuthResult> {
  const canAuthenticate = await canUseDeviceOwnerAuthentication();
  if (!canAuthenticate) {
    return "unavailable";
  }

  try {
    await Keychain.setGenericPassword(OWNER_AUTH_KEY, String(Date.now()), {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      accessControl: Keychain.ACCESS_CONTROL.USER_PRESENCE,
    });
    const credentials = await Keychain.getGenericPassword({
      service: SERVICE,
      accessControl: Keychain.ACCESS_CONTROL.USER_PRESENCE,
      authenticationPrompt: {
        title,
        subtitle,
        description,
        cancel,
      },
    });
    return credentials && credentials.username === OWNER_AUTH_KEY
      ? "authenticated"
      : "cancelled";
  } catch {
    return "cancelled";
  } finally {
    await Keychain.resetGenericPassword({ service: SERVICE }).catch(() => {
      // 临时认证项清理失败不改变本次认证结果。
    });
  }
}

async function canUseDeviceOwnerAuthentication(): Promise<boolean> {
  const [canImplyAuthentication, passcodeAvailable] = await Promise.all([
    Keychain.canImplyAuthentication({
      authenticationType: Keychain.AUTHENTICATION_TYPE.DEVICE_PASSCODE_OR_BIOMETRICS,
    }).catch(() => false),
    Keychain.isPasscodeAuthAvailable().catch(() => false),
  ]);
  return canImplyAuthentication || passcodeAvailable;
}
