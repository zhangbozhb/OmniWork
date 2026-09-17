import type { IdentityKeyPair } from "@omni-work/protocol-ts";

export interface AppIdentity {
  readonly record: Omit<IdentityKeyPair, "privateKey"> & { role: "app" };
  sign(domain: string, fields: readonly string[]): Promise<string>;
}
