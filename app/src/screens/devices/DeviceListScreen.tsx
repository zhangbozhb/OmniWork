import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { PairingConfig } from "../../features/auth/types";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

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
  const failed = connectionStatus === "failed";
  const activeStatus = getDeviceStatusPresentation(connectionStatus, connectionMessage);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Card elevated style={styles.summaryCard}>
        <View>
          <Text style={styles.summaryEyebrow}>Device Center</Text>
          <Text style={styles.summaryTitle}>
            {pairings.length} linked {pairings.length === 1 ? "device" : "devices"}
          </Text>
        </View>
        <Badge
          backgroundColor={activeStatus.backgroundColor}
          color={activeStatus.color}
        >
          {activeStatus.label}
        </Badge>
      </Card>

      {pairings.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No linked devices</Text>
          <Text style={styles.emptyText}>Add a Mac Agent link to start using OmniWork.</Text>
        </Card>
      ) : (
        pairings.map((pairing) => {
          const active = Boolean(
            activePairing &&
              pairing.deviceId === activePairing.deviceId &&
              pairing.relayUrl === activePairing.relayUrl,
          );
          const canOpen = !active || ready;
          const status = active ? activeStatus : getSavedDeviceStatusPresentation();
          const primaryActionLabel = active
            ? ready
              ? "Open Sessions"
              : failed
                ? "Retry Connection"
                : "Connecting..."
            : "Connect Device";
          const primaryActionDisabled = active && !ready && !failed;
          const primaryAction = active && !ready ? onRefreshSessions : () => onOpenDevice(pairing);
          return (
            <Card
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
                    <Badge
                      backgroundColor={status.backgroundColor}
                      color={status.color}
                    >
                      {status.label}
                    </Badge>
                  </View>
                  <Text numberOfLines={1} style={styles.deviceMeta}>
                    {formatRelayUrl(pairing.relayUrl)}
                  </Text>
                  <Text style={styles.deviceTransport}>
                    {formatTransportLabel(pairing.transport)}
                  </Text>
                  <Text numberOfLines={2} style={styles.deviceStatus}>
                    {active ? status.detail : "Ready to connect when selected."}
                  </Text>
                </View>
              </Pressable>
              <View style={styles.deviceActions}>
                <Button
                  disabled={primaryActionDisabled}
                  style={styles.devicePrimaryAction}
                  tone="primary"
                  onPress={primaryAction}
                >
                  {primaryActionLabel}
                </Button>
                <Button
                  style={styles.smallButton}
                  onPress={() => onEditDevice(pairing)}
                >
                  Edit
                </Button>
                <Button
                  style={styles.smallButton}
                  tone="danger"
                  onPress={() => onDeleteDevice(pairing)}
                >
                  Delete
                </Button>
              </View>
            </Card>
          );
        })
      )}

      <Button tone="primary" onPress={onAddDevice}>
        Add Link
      </Button>

      {pairings.length > 0 ? (
        <Button onPress={onRefreshSessions}>
          {ready ? "Refresh Sessions" : "Retry Active Device"}
        </Button>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  summaryCard: {
    padding: spacing.xl,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.lg,
  },
  summaryEyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  summaryTitle: {
    color: colors.textPrimary,
    ...typography.title,
    marginTop: spacing.xs,
  },
  emptyCard: {
    padding: spacing.xxl,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "700",
  },
  emptyText: {
    color: colors.textMuted,
    marginTop: 6,
  },
  deviceCard: {
    overflow: "hidden",
  },
  deviceMain: {
    padding: spacing.xl,
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
    gap: spacing.md,
  },
  deviceName: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "700",
    flex: 1,
  },
  deviceMeta: {
    color: colors.textMuted,
    marginTop: 6,
  },
  deviceTransport: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
  },
  deviceStatus: {
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 19,
  },
  deviceActions: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  devicePrimaryAction: {
    flex: 1,
    minHeight: 36,
  },
  smallButton: {
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
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

function formatTransportLabel(transport: string): string {
  return transport === "webrtc" ? "WebRTC tunnel" : "WebSocket relay";
}

function getSavedDeviceStatusPresentation(): DeviceStatusPresentation {
  return {
    backgroundColor: "rgba(148, 163, 173, 0.16)",
    color: colors.textMuted,
    detail: "Ready to connect when selected.",
    label: "Saved",
  };
}

function getDeviceStatusPresentation(status: string, message?: string): DeviceStatusPresentation {
  switch (status) {
    case "authenticated":
      return {
        backgroundColor: colors.successSoft,
        color: colors.success,
        detail: "Connected to Mac Agent.",
        label: "Online",
      };
    case "connecting":
    case "authenticating":
      return {
        backgroundColor: colors.warningSoft,
        color: colors.warning,
        detail: message ?? "Connecting to Relay...",
        label: "Connecting",
      };
    case "failed":
      return {
        backgroundColor: colors.dangerSoft,
        color: colors.danger,
        detail: message ?? "Connection failed.",
        label: "Offline",
      };
    default:
      return {
        backgroundColor: colors.neutralSoft,
        color: colors.textMuted,
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
