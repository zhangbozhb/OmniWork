import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { PairingConfig } from "../../features/auth/types";

export interface DeviceListScreenProps {
  pairings: PairingConfig[];
  activePairing?: PairingConfig;
  connectionStatus: string;
  connectionMessage?: string;
  onAddDevice(): void;
  onEditDevice(pairing: PairingConfig): void;
  onDeleteDevice(pairing: PairingConfig): void | Promise<void>;
  onOpenDevice(pairing: PairingConfig): void;
  onRefreshSessions(): void;
}

export function DeviceListScreen({
  pairings,
  activePairing,
  connectionStatus,
  connectionMessage,
  onAddDevice,
  onEditDevice,
  onDeleteDevice,
  onOpenDevice,
  onRefreshSessions,
}: DeviceListScreenProps): JSX.Element {
  const ready = connectionStatus === "authenticated";

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {pairings.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No linked devices</Text>
          <Text style={styles.emptyText}>Add a Mac Agent link to start using OmniWork.</Text>
        </View>
      ) : (
        pairings.map((pairing) => {
          const active = Boolean(
            activePairing &&
              pairing.deviceId === activePairing.deviceId &&
              pairing.relayUrl === activePairing.relayUrl,
          );
          const canOpen = !active || ready;
          return (
            <View
              key={`${pairing.relayUrl}:${pairing.deviceId}`}
              style={styles.deviceCard}
            >
              <Pressable
                disabled={!canOpen}
                style={[styles.deviceMain, !canOpen && styles.disabled]}
                onPress={() => onOpenDevice(pairing)}
              >
                <View style={styles.deviceText}>
                  <Text style={styles.deviceName}>{pairing.deviceId}</Text>
                  <Text style={styles.deviceMeta}>{pairing.relayUrl}</Text>
                  <Text style={styles.deviceStatus}>
                    {active ? connectionMessage ?? connectionStatus : "Saved"}
                  </Text>
                </View>
                <Text style={styles.openLabel}>
                  {active && !ready ? "Connecting" : "Open"}
                </Text>
              </Pressable>
              <View style={styles.deviceActions}>
                <Pressable
                  style={styles.smallButton}
                  onPress={() => onEditDevice(pairing)}
                >
                  <Text style={styles.secondaryText}>Edit</Text>
                </Pressable>
                <Pressable
                  style={styles.smallButton}
                  onPress={() => onDeleteDevice(pairing)}
                >
                  <Text style={styles.dangerText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}

      <Pressable style={styles.primaryButton} onPress={onAddDevice}>
        <Text style={styles.primaryText}>Add Link</Text>
      </Pressable>

      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={onRefreshSessions}>
          <Text style={styles.secondaryText}>{ready ? "Refresh" : "Retry"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: 18,
    gap: 12,
  },
  emptyCard: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    padding: 18,
    backgroundColor: "#151c21",
  },
  emptyTitle: {
    color: "#f5f7f8",
    fontSize: 17,
    fontWeight: "700",
  },
  emptyText: {
    color: "#94a3ad",
    marginTop: 6,
  },
  deviceCard: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: "#151c21",
    overflow: "hidden",
  },
  deviceMain: {
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceText: {
    flex: 1,
    paddingRight: 10,
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
  deviceActions: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    borderTopColor: "#263037",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#30c48d",
  },
  primaryText: {
    color: "#08110d",
    fontWeight: "800",
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
  smallButton: {
    minHeight: 36,
    paddingHorizontal: 12,
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
  dangerText: {
    color: "#ff8d8d",
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.55,
  },
});
