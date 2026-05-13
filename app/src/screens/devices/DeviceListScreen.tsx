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
  const activeStatus = getDeviceStatusPresentation(connectionStatus, connectionMessage);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.summaryCard}>
        <View>
          <Text style={styles.summaryEyebrow}>Device Center</Text>
          <Text style={styles.summaryTitle}>
            {pairings.length} linked {pairings.length === 1 ? "device" : "devices"}
          </Text>
        </View>
        <View style={[styles.summaryBadge, { backgroundColor: activeStatus.backgroundColor }]}>
          <Text style={[styles.summaryBadgeText, { color: activeStatus.color }]}>
            {activeStatus.label}
          </Text>
        </View>
      </View>

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
          const status = active ? activeStatus : getSavedDeviceStatusPresentation();
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
                  <View style={styles.deviceTitleRow}>
                    <Text numberOfLines={1} style={styles.deviceName}>
                      {pairing.deviceId}
                    </Text>
                    <View style={[styles.statusBadge, { backgroundColor: status.backgroundColor }]}>
                      <Text style={[styles.statusBadgeText, { color: status.color }]}>
                        {status.label}
                      </Text>
                    </View>
                  </View>
                  <Text numberOfLines={1} style={styles.deviceMeta}>
                    {formatRelayUrl(pairing.relayUrl)}
                  </Text>
                  <Text numberOfLines={2} style={styles.deviceStatus}>
                    {active ? status.detail : "Ready to connect when selected."}
                  </Text>
                </View>
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

      <Pressable style={styles.secondaryButton} onPress={onRefreshSessions}>
        <Text style={styles.secondaryText}>{ready ? "Refresh Sessions" : "Retry Connection"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: 18,
    gap: 12,
  },
  summaryCard: {
    borderColor: "#263037",
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    backgroundColor: "#11181d",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryEyebrow: {
    color: "#66727c",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  summaryTitle: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 4,
  },
  summaryBadge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  summaryBadgeText: {
    fontSize: 12,
    fontWeight: "800",
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
    borderRadius: 12,
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
  },
  deviceTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  deviceName: {
    color: "#f5f7f8",
    fontSize: 17,
    fontWeight: "700",
    flex: 1,
  },
  deviceMeta: {
    color: "#94a3ad",
    marginTop: 6,
  },
  deviceStatus: {
    color: "#d7dde2",
    marginTop: 8,
    lineHeight: 19,
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
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: "800",
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

function formatRelayUrl(relayUrl: string): string {
  try {
    const url = new URL(relayUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return relayUrl;
  }
}

function getSavedDeviceStatusPresentation(): DeviceStatusPresentation {
  return {
    backgroundColor: "rgba(148, 163, 173, 0.16)",
    color: "#94a3ad",
    detail: "Ready to connect when selected.",
    label: "Saved",
  };
}

function getDeviceStatusPresentation(status: string, message?: string): DeviceStatusPresentation {
  switch (status) {
    case "authenticated":
      return {
        backgroundColor: "rgba(48, 196, 141, 0.16)",
        color: "#30c48d",
        detail: "Connected to Mac Agent.",
        label: "Online",
      };
    case "connecting":
    case "authenticating":
      return {
        backgroundColor: "rgba(244, 201, 93, 0.18)",
        color: "#f4c95d",
        detail: message ?? "Connecting to Relay...",
        label: "Connecting",
      };
    case "failed":
      return {
        backgroundColor: "rgba(255, 141, 141, 0.16)",
        color: "#ff8d8d",
        detail: message ?? "Connection failed.",
        label: "Offline",
      };
    default:
      return {
        backgroundColor: "rgba(148, 163, 173, 0.16)",
        color: "#94a3ad",
        detail: message ?? "Not connected.",
        label: "Idle",
      };
  }
}

interface DeviceStatusPresentation {
  backgroundColor: string;
  color: string;
  detail: string;
  label: string;
}
