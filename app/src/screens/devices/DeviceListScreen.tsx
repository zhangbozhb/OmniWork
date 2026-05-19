import type { JSX } from "react";
import { useState, useCallback } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

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
  const activeStatus = getDeviceStatusPresentation(
    connectionStatus,
    connectionMessage,
  );

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onRefreshSessions();
    setTimeout(() => setRefreshing(false), 1000);
  }, [onRefreshSessions]);

  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={
        Platform.OS !== "web"
          ? (
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.success}
                onRefresh={handleRefresh}
              />
            )
          : undefined
      }
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.headerEyebrow}>Device Center</Text>
          <Text style={styles.headerTitle}>
            {pairings.length} linked{" "}
            {pairings.length === 1 ? "device" : "devices"}
          </Text>
        </View>
        <Button
          accessibilityLabel="Refresh"
          icon="refresh"
          iconOnly
          style={styles.headerRefresh}
          onPress={handleRefresh}
        >
          Refresh
        </Button>
      </View>

      {pairings.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No linked devices</Text>
          <Text style={styles.emptyText}>
            Add a Mac Agent link to start using OmniWork.
          </Text>
        </Card>
      ) : (
        pairings.map((pairing) => {
          const pairingKey = `${pairing.relayUrl}:${pairing.deviceId}`;
          const active = Boolean(
            activePairing &&
              pairing.deviceId === activePairing.deviceId &&
              pairing.relayUrl === activePairing.relayUrl,
          );
          const canOpen = !active || ready;
          const status = active
            ? activeStatus
            : getSavedDeviceStatusPresentation();
          const primaryAction =
            active && !ready
              ? onRefreshSessions
              : () => onOpenDevice(pairing);
          const expanded = expandedDevice === pairingKey;

          return (
            <Pressable
              key={pairingKey}
              disabled={!canOpen}
              style={[styles.deviceCard, !canOpen && styles.disabled]}
              onPress={primaryAction}
            >
              <View style={styles.deviceRow1}>
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

              <Text numberOfLines={1} style={styles.deviceUrl}>
                {formatRelayUrl(pairing.relayUrl)}
              </Text>

              <View style={styles.deviceRow3}>
                <Text style={styles.deviceTransport}>
                  {formatTransportLabel(pairing.transport)}
                </Text>
                <Button
                  accessibilityLabel="More actions"
                  icon="more"
                  iconOnly
                  style={styles.moreButton}
                  onPress={() =>
                    setExpandedDevice(expanded ? null : pairingKey)
                  }
                >
                  More
                </Button>
              </View>

              {expanded ? (
                <View style={styles.expandedActions}>
                  <Button
                    icon="edit"
                    style={styles.actionButton}
                    onPress={() => {
                      setExpandedDevice(null);
                      onEditDevice(pairing);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    icon="trash"
                    style={styles.actionButton}
                    tone="danger"
                    onPress={() => {
                      setExpandedDevice(null);
                      onDeleteDevice(pairing);
                    }}
                  >
                    Delete
                  </Button>
                </View>
              ) : null}
            </Pressable>
          );
        })
      )}

      <Button
        accessibilityLabel="Add Link"
        icon="add"
        iconOnly
        style={styles.fab}
        tone="primary"
        onPress={onAddDevice}
      >
        Add Link
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerEyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  headerTitle: {
    color: colors.textPrimary,
    ...typography.title,
    marginTop: spacing.xs,
  },
  headerRefresh: {
    minHeight: 36,
    width: 36,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
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
    padding: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    gap: 6,
  },
  deviceRow1: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  deviceName: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
  },
  deviceUrl: {
    color: colors.textMuted,
    fontSize: 13,
  },
  deviceRow3: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceTransport: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "700",
  },
  moreButton: {
    minHeight: 28,
    width: 28,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
  },
  expandedActions: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionButton: {
    minHeight: 36,
    borderRadius: radii.sm,
    flex: 1,
  },
  disabled: {
    opacity: 0.55,
  },
  fab: {
    position: "absolute",
    bottom: spacing.xxl,
    right: spacing.xxl,
    width: 52,
    height: 52,
    borderRadius: 26,
    paddingHorizontal: 0,
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

function getDeviceStatusPresentation(
  status: string,
  message?: string,
): DeviceStatusPresentation {
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
