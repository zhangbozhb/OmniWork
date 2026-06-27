import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import type { ConnectionStatus, AppView } from "../../app/appTypes";
import { formatErrorMessage } from "../../app/connectionMessages";
import {
  getPairingDisplayName,
  isSamePairing,
  upsertPairing,
} from "../../app/pairingState";
import {
  addAppUrlListener,
  getInitialAppUrl,
} from "../../platform/linking/appLinking";
import {
  clearPairing,
  loadPairings,
  savePairings,
} from "../../platform/secure-storage/securePairingStore";
import type { ConfirmOptions } from "../../ui/confirm/ConfirmProvider";
import {
  decryptPairingConfig,
  isEncryptedPairingConfig,
  parsePairingConfig,
} from "./pairingConfig";
import type { PairingConfig } from "./types";

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

type UsePairingControllerOptions = {
  t(key: string): string;
  confirm: Confirm;
  getConnectionStatus(): ConnectionStatus;
  setView(view: AppView): void;
  setConnectionStatus(status: ConnectionStatus): void;
  setConnectionMessage(message: string): void;
  onClearActiveDeviceData(): void;
  onCloseActiveTransport(): void;
  onReconnectActivePairing(): void;
  onRequestActiveDeviceRefresh(): void;
  setPendingAutoOpenSessions(value: boolean): void;
};

export function usePairingController({
  t,
  confirm,
  getConnectionStatus,
  setView,
  setConnectionStatus,
  setConnectionMessage,
  onClearActiveDeviceData,
  onCloseActiveTransport,
  onReconnectActivePairing,
  onRequestActiveDeviceRefresh,
  setPendingAutoOpenSessions,
}: UsePairingControllerOptions) {
  const [pairings, setPairings] = useState<PairingConfig[]>([]);
  const [pairing, setPairing] = useState<PairingConfig | null>(null);
  const [editingPairing, setEditingPairing] = useState<
    PairingConfig | undefined
  >();
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [pendingEncryptedPairingLink, setPendingEncryptedPairingLink] =
    useState<string | undefined>();
  const [encryptedPairingPassword, setEncryptedPairingPassword] = useState("");
  const [encryptedPairingError, setEncryptedPairingError] = useState<
    string | undefined
  >();
  const pairingRef = useRef<PairingConfig | null>(null);
  const pairingsRef = useRef<PairingConfig[]>([]);

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    pairingsRef.current = pairings;
  }, [pairings]);

  useEffect(() => {
    let active = true;
    Promise.all([loadPairings(), getInitialAppUrl()])
      .then(async ([savedPairings, initialUrl]) => {
        if (!active) {
          return;
        }
        const scannedPairing = initialUrl
          ? parsePairingConfig(initialUrl)
          : null;
        if (scannedPairing) {
          await saveAndActivatePairing(scannedPairing, savedPairings, {
            autoOpenSessions: true,
          });
          setConnectionMessage("Pairing imported from link. Connecting...");
          return;
        }

        if (initialUrl && isEncryptedPairingConfig(initialUrl)) {
          pairingsRef.current = savedPairings;
          setPairings(savedPairings);
          setPairing(savedPairings[0] ?? null);
          setPendingEncryptedPairingLink(initialUrl);
          setEncryptedPairingPassword("");
          setEncryptedPairingError(undefined);
          setConnectionMessage("Encrypted pairing link detected.");
          setView(savedPairings.length > 0 ? "devices" : "pairing");
          return;
        }

        pairingsRef.current = savedPairings;
        setPairings(savedPairings);
        setPairing(savedPairings[0] ?? null);
        setView(savedPairings.length > 0 ? "devices" : "pairing");
      })
      .catch(() => {
        if (active) {
          setPairingError(
            "Could not restore the saved pairing. Enter the latest key again.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const subscription = addAppUrlListener((url) => {
      handlePairingUrl(url).catch((error: unknown) => {
        setPairingError(
          `Could not import pairing link: ${formatErrorMessage(error)}`,
        );
      });
    });

    return () => subscription.remove();
  }, []);

  async function handlePair(nextPairing: PairingConfig): Promise<void> {
    setPairingError(undefined);
    const nextPairings = editingPairing
      ? pairings.map((item) =>
          isSamePairing(item, editingPairing) ? nextPairing : item,
        )
      : upsertPairing(pairings, nextPairing);
    await savePairings(nextPairings);
    pairingsRef.current = nextPairings;
    setPairings(nextPairings);
    setPairing(nextPairing);
    setEditingPairing(undefined);
    setView("devices");
  }

  async function handlePairingUrl(url: string): Promise<void> {
    const nextPairing = parsePairingConfig(url);
    if (!nextPairing && isEncryptedPairingConfig(url)) {
      setPendingEncryptedPairingLink(url);
      setEncryptedPairingPassword("");
      setEncryptedPairingError(undefined);
      setConnectionMessage("Encrypted pairing link detected.");
      return;
    }
    if (!nextPairing) {
      Alert.alert(
        "Invalid pairing link",
        "Open or paste the pairing link generated by your computer.",
      );
      return;
    }

    setPairingError(undefined);
    setConnectionMessage("Pairing imported from link. Connecting...");
    await saveAndActivatePairing(nextPairing, pairingsRef.current, {
      autoOpenSessions: true,
    });
  }

  async function handleEncryptedPairingSubmit(): Promise<void> {
    if (!pendingEncryptedPairingLink) {
      return;
    }
    if (encryptedPairingPassword.length !== 4) {
      setEncryptedPairingError(t("pairing.encrypted.passwordRequired"));
      return;
    }
    const nextPairing = decryptPairingConfig(
      pendingEncryptedPairingLink,
      encryptedPairingPassword,
    );
    if (!nextPairing) {
      setEncryptedPairingError(t("pairing.encrypted.invalidPassword"));
      return;
    }
    setPairingError(undefined);
    setEncryptedPairingError(undefined);
    setPendingEncryptedPairingLink(undefined);
    setEncryptedPairingPassword("");
    setConnectionMessage("Pairing imported from link. Connecting...");
    await saveAndActivatePairing(nextPairing, pairingsRef.current, {
      autoOpenSessions: true,
    });
  }

  function handleEncryptedPairingCancel(): void {
    setPendingEncryptedPairingLink(undefined);
    setEncryptedPairingPassword("");
    setEncryptedPairingError(undefined);
  }

  async function saveAndActivatePairing(
    nextPairing: PairingConfig,
    basePairings: PairingConfig[],
    options: { autoOpenSessions?: boolean } = {},
  ): Promise<void> {
    const nextPairings = upsertPairing(basePairings, nextPairing);
    await savePairings(nextPairings);
    setPendingAutoOpenSessions(Boolean(options.autoOpenSessions));
    pairingsRef.current = nextPairings;
    setPairings(nextPairings);
    setPairing(nextPairing);
    setEditingPairing(undefined);
    setView("devices");
  }

  function handleAddDevice(): void {
    setPairingError(undefined);
    setEditingPairing(undefined);
    setView("pairing");
  }

  function handleEditDevice(nextPairing: PairingConfig): void {
    setPairingError(undefined);
    setEditingPairing(nextPairing);
    setView("pairing");
  }

  function handleCancelPairing(): void {
    setEditingPairing(undefined);
    setView(pairings.length > 0 ? "devices" : "pairing");
  }

  async function handleDeleteDevice(
    targetPairing: PairingConfig,
  ): Promise<void> {
    const deviceName = getPairingDisplayName(targetPairing);
    const confirmed = await confirm({
      title: "Delete device",
      message: `Delete ${deviceName} from linked devices?`,
      confirmText: "Delete",
    });
    if (!confirmed) {
      return;
    }

    removeDevice(targetPairing).catch((error: unknown) => {
      setPairingError(`Could not delete device: ${String(error)}`);
    });
  }

  async function removeDevice(targetPairing: PairingConfig): Promise<void> {
    const nextPairings = await removeSavedPairing(targetPairing);
    onClearActiveDeviceData();
    setEditingPairing(undefined);

    if (pairing && isSamePairing(pairing, targetPairing)) {
      onCloseActiveTransport();
      setPairing(nextPairings[0] ?? null);
    }

    setView(nextPairings.length > 0 ? "devices" : "pairing");
  }

  async function handleAuthFailureCleanup(
    targetPairing: PairingConfig,
    reason: string,
    currentView: AppView,
  ): Promise<void> {
    onClearActiveDeviceData();

    const errorText = `Authentication failed for "${getPairingDisplayName(
      targetPairing,
    )}": ${reason}. Edit the device to enter a new key, or delete it.`;
    setConnectionStatus("failed");
    setConnectionMessage(errorText);
    setPairingError(errorText);

    if (currentView === "pairing" && editingPairing) {
      return;
    }
    setEditingPairing(undefined);
    setView("devices");
  }

  async function removeSavedPairing(
    targetPairing: PairingConfig,
  ): Promise<PairingConfig[]> {
    const nextPairings = pairingsRef.current.filter(
      (item) => !isSamePairing(item, targetPairing),
    );
    if (nextPairings.length > 0) {
      await savePairings(nextPairings);
    } else {
      await clearPairing();
    }

    pairingsRef.current = nextPairings;
    setPairings(nextPairings);
    return nextPairings;
  }

  function handleOpenDevice(nextPairing: PairingConfig): void {
    const connectionStatus = getConnectionStatus();
    if (!pairing || !isSamePairing(pairing, nextPairing)) {
      setPendingAutoOpenSessions(true);
      setPairing(nextPairing);
      onClearActiveDeviceData();
      setView("workbench");
      return;
    }

    if (connectionStatus === "authenticated") {
      setView("workbench");
      onRequestActiveDeviceRefresh();
      return;
    }

    setPendingAutoOpenSessions(true);
    setView("workbench");
    if (connectionStatus === "failed" || connectionStatus === "idle") {
      onReconnectActivePairing();
    }
  }

  function resetPairingState(): void {
    pairingsRef.current = [];
    pairingRef.current = null;
    setPairings([]);
    setPairing(null);
    setEditingPairing(undefined);
    setPairingError(undefined);
    setPendingEncryptedPairingLink(undefined);
    setEncryptedPairingPassword("");
    setEncryptedPairingError(undefined);
  }

  return {
    pairings,
    pairing,
    pairingRef,
    pairingsRef,
    editingPairing,
    pairingError,
    pendingEncryptedPairingLink,
    encryptedPairingPassword,
    encryptedPairingError,
    setPairing,
    setPairingError,
    setEncryptedPairingPassword,
    setEncryptedPairingError,
    handlePair,
    handleEncryptedPairingSubmit,
    handleEncryptedPairingCancel,
    handleAddDevice,
    handleEditDevice,
    handleCancelPairing,
    handleDeleteDevice,
    handleOpenDevice,
    handleAuthFailureCleanup,
    resetPairingState,
  };
}
