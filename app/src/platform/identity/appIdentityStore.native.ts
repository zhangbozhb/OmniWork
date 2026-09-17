import * as Keychain from "react-native-keychain";

import {
  generateIdentityKeyPair,
  signIdentityFields,
  validateIdentityKeyPair,
  type IdentityKeyPair,
} from "@omni-work/protocol-ts";
import type { AppIdentity } from "../../features/auth/appIdentity";
import { createAppIdentityStore } from "./appIdentityStoreCache";

const IDENTITY_KEY = "omniwork.app.identity.v1";
const SERVICE = "com.omniwork.mobile.identity.v1";

export const { getOrCreateAppIdentity, resetAppIdentity } =
  createAppIdentityStore(loadIdentity, async () => {
    await Keychain.resetGenericPassword({ service: SERVICE });
  });

async function loadIdentity(): Promise<AppIdentity> {
  const stored = await Keychain.getGenericPassword({ service: SERVICE });
  if (stored && stored.username === IDENTITY_KEY) {
    const parsed = JSON.parse(stored.password) as IdentityKeyPair;
    if (!validateIdentityKeyPair(parsed, "app")) {
      throw new Error(
        "The stored App identity is invalid. Reset it explicitly before continuing.",
      );
    }
    return createHandle(parsed);
  }

  const identity = generateIdentityKeyPair("app");
  await Keychain.setGenericPassword(IDENTITY_KEY, JSON.stringify(identity), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return createHandle(identity);
}

function createHandle(identity: IdentityKeyPair): AppIdentity {
  const { privateKey: _privateKey, ...record } = identity;
  return {
    record: record as AppIdentity["record"],
    sign: async (domain, fields) =>
      signIdentityFields(identity.privateKey, domain, fields),
  };
}
