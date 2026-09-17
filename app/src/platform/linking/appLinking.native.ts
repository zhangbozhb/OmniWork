import { Linking } from "react-native";

export interface AppLinkSubscription {
  remove(): void;
}

export async function getInitialAppUrl(): Promise<string | null> {
  return (await Linking.getInitialURL()) ?? null;
}

export function addAppUrlListener(
  handler: (url: string) => void,
): AppLinkSubscription {
  return Linking.addEventListener("url", ({ url }) => handler(url));
}

export async function openSystemSettings(): Promise<void> {
  await Linking.openSettings();
}
