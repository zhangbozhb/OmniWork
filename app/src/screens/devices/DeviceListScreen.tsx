import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { PairingConfig } from "../../features/auth/types";

export interface DeviceListScreenProps {
  pairing: PairingConfig;
  connectionStatus: string;
  connectionMessage?: string;
  onOpenSessions(): void;
  onForgetPairing(): void | Promise<void>;
  onRefreshSessions(): void;
}

export function DeviceListScreen({
  pairing,
  connectionStatus,
  connectionMessage,
  onOpenSessions,
  onForgetPairing,
  onRefreshSessions,
}: DeviceListScreenProps): JSX.Element {
  const ready = connectionStatus === "authenticated";

  return (
    <View style={styles.screen}>
      <Pressable disabled={!ready} style={[styles.deviceCard, !ready && styles.disabled]} onPress={onOpenSessions}>
        <View>
          <Text style={styles.deviceName}>{pairing.deviceId}</Text>
          <Text style={styles.deviceMeta}>{pairing.relayUrl}</Text>
          <Text style={styles.deviceStatus}>{connectionMessage ?? connectionStatus}</Text>
        </View>
        <Text style={styles.openLabel}>Open</Text>
        </Pressable>

      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={onRefreshSessions}>
          <Text style={styles.secondaryText}>{ready ? "Refresh" : "Retry"}</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onForgetPairing}>
          <Text style={styles.secondaryText}>Forget Key</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 18,
    gap: 12,
  },
  deviceCard: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    backgroundColor: "#151c21",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceName: {
    color: "#f5f7f8",
    fontSize: 17,
    fontWeight: "700",
  },
  deviceMeta: {
    color: "#94a3ad",
    marginTop: 4,
  },
  deviceStatus: {
    color: "#d7dde2",
    marginTop: 8,
    fontWeight: "700",
  },
  openLabel: {
    color: "#30c48d",
    fontWeight: "800",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryButton: {
    minHeight: 42,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#34424c",
    borderWidth: 1,
  },
  secondaryText: {
    color: "#d7dde2",
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.55,
  },
});
