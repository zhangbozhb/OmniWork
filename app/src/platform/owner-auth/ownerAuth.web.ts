export type OwnerAuthResult = "authenticated" | "cancelled" | "unavailable";

export async function authenticateDeviceOwner(): Promise<OwnerAuthResult> {
  return "unavailable";
}
