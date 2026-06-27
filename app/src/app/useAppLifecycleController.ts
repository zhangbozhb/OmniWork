import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { TransportPreference } from "@omniwork/protocol-ts";

import type {
  AppSessionTransport,
  AppView,
  ConnectionStatus,
} from "./appTypes";
import { subscribeNetworkChanges } from "./appTransport";
import type { PairingConfig } from "../features/auth/types";
import type { ConfirmOptions } from "../ui/confirm/ConfirmProvider";

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

type UseAppLifecycleControllerOptions = {
  appLockAvailable: boolean;
  connectionPath: string;
  connectionStatus: ConnectionStatus;
  connectionMessage: string;
  pairing: PairingConfig | null;
  currentView: AppView;
  selectedSessionId?: string;
  selectedSurfaceId?: string;
  transportPreference: TransportPreference;
  confirm: Confirm;
  lockIfInactive(): void;
  withActiveTransport(callback: (relay: AppSessionTransport) => void): void;
  requestP2pReconnect(reason: string, event?: unknown): void;
  requestTerminalSnapshotForCurrentSession(): void;
  shouldRefreshWorkbenchOnConnection(): boolean;
  requestSessionListRefresh(): void;
  reconnectActivePairing(): void;
  clearSelectedSession(): void;
  setView(view: AppView): void;
};

export function useAppLifecycleController({
  appLockAvailable,
  connectionPath,
  connectionStatus,
  connectionMessage,
  pairing,
  currentView,
  selectedSessionId,
  selectedSurfaceId,
  transportPreference,
  confirm,
  lockIfInactive,
  withActiveTransport,
  requestP2pReconnect,
  requestTerminalSnapshotForCurrentSession,
  shouldRefreshWorkbenchOnConnection,
  requestSessionListRefresh,
  reconnectActivePairing,
  clearSelectedSession,
  setView,
}: UseAppLifecycleControllerOptions): { clearFailureDialogState(): void } {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const failureDialogActiveRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const previous = appStateRef.current;
      appStateRef.current = next;
      if (appLockAvailable && next === "active" && previous !== "active") {
        lockIfInactive();
      }
      withActiveTransport((relay) => {
        if (relay.isStrictP2p()) {
          if (next === "active") {
            relay.resumeForForeground();
            if (previous !== "active") {
              relay.requestP2pReconnect("foreground_resume");
              requestTerminalSnapshotForCurrentSession();
            }
          } else {
            relay.pauseForBackground();
          }
          return;
        }
        if (next !== "active") {
          relay.forceDowngrade("app_background");
        } else if (previous !== "active") {
          relay.requestP2pReconnect("foreground_resume");
          requestTerminalSnapshotForCurrentSession();
        }
      });
    });
    return () => subscription.remove();
  }, [
    appLockAvailable,
    lockIfInactive,
    requestTerminalSnapshotForCurrentSession,
    withActiveTransport,
  ]);

  useEffect(() => {
    return subscribeNetworkChanges((event) => {
      requestP2pReconnect("network_changed", event);
      requestTerminalSnapshotForCurrentSession();
    });
  }, [requestP2pReconnect, requestTerminalSnapshotForCurrentSession]);

  useEffect(() => {
    if (connectionPath === "p2p" && connectionStatus === "authenticated") {
      if (
        transportPreference !== "prefer_p2p" &&
        shouldRefreshWorkbenchOnConnection()
      ) {
        requestSessionListRefresh();
      }
      requestTerminalSnapshotForCurrentSession();
    }
  }, [
    connectionPath,
    connectionStatus,
    requestSessionListRefresh,
    requestTerminalSnapshotForCurrentSession,
    selectedSessionId,
    selectedSurfaceId,
    shouldRefreshWorkbenchOnConnection,
    transportPreference,
  ]);

  useEffect(() => {
    if (
      connectionStatus !== "failed" ||
      !pairing ||
      (currentView !== "workbench" &&
        currentView !== "terminal" &&
        currentView !== "terminalFiles") ||
      failureDialogActiveRef.current
    ) {
      return;
    }

    failureDialogActiveRef.current = true;
    const message =
      connectionMessage || "Lost connection to the connected computer.";
    confirm({
      title: "Connection lost",
      message: `${message}\n\nRetry now or return to the device list?`,
      confirmText: "Retry",
      cancelText: "Back to devices",
      tone: "primary",
    })
      .then((retry) => {
        failureDialogActiveRef.current = false;
        if (retry) {
          reconnectActivePairing();
        } else {
          clearSelectedSession();
          setView("devices");
        }
      })
      .catch(() => {
        failureDialogActiveRef.current = false;
      });
  }, [
    clearSelectedSession,
    confirm,
    connectionMessage,
    connectionStatus,
    currentView,
    pairing,
    reconnectActivePairing,
    setView,
  ]);

  function clearFailureDialogState(): void {
    failureDialogActiveRef.current = false;
  }

  return { clearFailureDialogState };
}
