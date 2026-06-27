import type { PairingConfig } from "../features/auth/types";
import type { AppView, PrimaryTabView } from "./appTypes";
import { getPairingDisplayName } from "./pairingState.ts";

export function getHeaderSubtitle(
  view: AppView,
  deviceCount: number,
  activePairing: PairingConfig | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (view === "devices") {
    return t("app.subtitle.linkedDevices", { count: deviceCount });
  }
  if (view === "settings") {
    return t("app.subtitle.globalPreferences");
  }
  if (view === "messages") {
    return t("app.subtitle.agentMessages");
  }
  if (view === "connectionPreference") {
    return t("app.subtitle.connectionSettings");
  }

  return activePairing ? getPairingDisplayName(activePairing) : "";
}

export function isPrimaryTabView(view: AppView): view is PrimaryTabView {
  return view === "devices" || view === "messages" || view === "settings";
}
