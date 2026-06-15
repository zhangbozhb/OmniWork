import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import QRCode from "react-native-qrcode-svg";

import type { TransportPath } from "@omniwork/protocol-ts";
import { getPairingDisplayName } from "../../app/appModel";
import { createPairingShareLink } from "../../features/auth/pairingShare";
import type { PairingConfig } from "../../features/auth/types";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

const WEB_PULL_THRESHOLD = 60;
const WEB_PULL_MAX = 120;

export interface DeviceListScreenProps {
  pairings: PairingConfig[];
  activePairing?: PairingConfig;
  connectionStatus: string;
  connectionPath: TransportPath;
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
  connectionPath,
  connectionMessage,
  onAddDevice,
  onEditDevice,
  onDeleteDevice,
  onOpenDevice,
  onRefreshSessions,
}: DeviceListScreenProps): JSX.Element {
  const { t } = useTranslation();
  const ready = connectionStatus === "authenticated";
  const activeStatus = getDeviceStatusPresentation(
    connectionStatus,
    t,
    connectionMessage,
  );
  const activePathStatus = getConnectionPathPresentation(
    connectionStatus,
    connectionPath,
    t,
  );

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onRefreshSessions();
    setTimeout(() => setRefreshing(false), 1000);
  }, [onRefreshSessions]);

  const scrollRef = useRef<ScrollView | null>(null);
  const webPullOffset = useWebPullToRefresh(
    scrollRef,
    refreshing,
    handleRefresh,
  );

  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const [sharePairing, setSharePairing] = useState<PairingConfig | null>(null);
  const shareLink = sharePairing
    ? createPairingShareLink(sharePairing)
    : undefined;
  const sharePairingName = sharePairing
    ? getPairingDisplayName(sharePairing)
    : "";
  const handleSystemShare = useCallback(() => {
    if (!sharePairing || !shareLink) {
      return;
    }
    Share.share({
      message: shareLink,
      title: t("devices.share.title", { deviceName: sharePairingName }),
      url: shareLink,
    }).catch(() => undefined);
  }, [shareLink, sharePairing, sharePairingName, t]);

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[
        styles.screen,
        Platform.OS === "web" && webPullOffset > 0
          ? { transform: [{ translateY: webPullOffset }] }
          : null,
      ]}
      refreshControl={
        Platform.OS !== "web" ? (
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.success}
            onRefresh={handleRefresh}
          />
        ) : undefined
      }
    >
      {Platform.OS === "web" && (refreshing || webPullOffset > 0) ? (
        <View
          style={[
            styles.webRefreshIndicator,
            {
              opacity: refreshing
                ? 1
                : Math.min(1, webPullOffset / WEB_PULL_THRESHOLD),
              top: -28 + (refreshing ? WEB_PULL_THRESHOLD : webPullOffset),
            },
          ]}
          pointerEvents="none"
        >
          <Text style={styles.webRefreshIndicatorText}>
            {refreshing
              ? t("devices.refreshing")
              : webPullOffset >= WEB_PULL_THRESHOLD
                ? t("devices.releaseToRefresh")
                : t("devices.pullToRefresh")}
          </Text>
        </View>
      ) : null}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.headerEyebrow}>{t("devices.eyebrow")}</Text>
          <Text style={styles.headerTitle}>
            {t("devices.linkedDevices", { count: pairings.length })}
          </Text>
        </View>
        <Button
          accessibilityLabel={t("common.refresh")}
          icon="refresh"
          iconOnly
          style={styles.headerIconButton}
          onPress={handleRefresh}
        >
          {t("common.refresh")}
        </Button>
      </View>

      {pairings.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{t("devices.emptyTitle")}</Text>
          <Text style={styles.emptyText}>
            {t("devices.emptyText")}
          </Text>
        </Card>
      ) : (
        pairings.map((pairing) => {
          const pairingKey = `${pairing.relayUrl}:${pairing.deviceId}`;
          const pairingName = getPairingDisplayName(pairing);
          const deviceDetail =
            pairingName === pairing.deviceId
              ? formatRelayUrl(pairing.relayUrl)
              : `${pairing.deviceId} · ${formatRelayUrl(pairing.relayUrl)}`;
          const active = Boolean(
            activePairing &&
              pairing.deviceId === activePairing.deviceId &&
              pairing.relayUrl === activePairing.relayUrl,
          );
          const canOpen = !active || ready;
          const status = active
            ? activeStatus
            : getSavedDeviceStatusPresentation(t);
          const pathStatus = active ? activePathStatus : undefined;
          const primaryAction =
            active && !ready ? onRefreshSessions : () => onOpenDevice(pairing);
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
                  {pairingName}
                </Text>
                <Badge
                  backgroundColor={status.backgroundColor}
                  color={status.color}
                >
                  {status.label}
                </Badge>
              </View>

              <Text numberOfLines={1} style={styles.deviceUrl}>
                {deviceDetail}
              </Text>

              <View style={styles.deviceRow3}>
                {pathStatus ? (
                  <Badge
                    backgroundColor={pathStatus.backgroundColor}
                    color={pathStatus.color}
                  >
                    {pathStatus.label}
                  </Badge>
                ) : (
                  <View />
                )}
                <View style={styles.flexFiller} />
                <Button
                  accessibilityLabel={t("devices.moreActions")}
                  icon="more"
                  iconOnly
                  style={styles.moreButton}
                  onPress={() =>
                    setExpandedDevice(expanded ? null : pairingKey)
                  }
                >
                  {t("common.more")}
                </Button>
              </View>

              {expanded ? (
                <View style={styles.expandedActions}>
                  <Button
                    icon="qr"
                    style={styles.actionButton}
                    onPress={() => {
                      setExpandedDevice(null);
                      setSharePairing(pairing);
                    }}
                  >
                    {t("devices.share.action")}
                  </Button>
                  <Button
                    icon="edit"
                    style={styles.actionButton}
                    onPress={() => {
                      setExpandedDevice(null);
                      onEditDevice(pairing);
                    }}
                  >
                    {t("common.edit")}
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
                    {t("common.delete")}
                  </Button>
                </View>
              ) : null}
            </Pressable>
          );
        })
      )}

      <Button
        accessibilityLabel={t("devices.addLink")}
        icon="add"
        iconOnly
        style={styles.fab}
        tone="primary"
        onPress={onAddDevice}
      >
        {t("devices.addLink")}
      </Button>

      <Modal
        animationType="fade"
        transparent
        visible={Boolean(sharePairing && shareLink)}
        onRequestClose={() => setSharePairing(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.shareSheet}>
            <Text style={styles.shareTitle}>
              {t("devices.share.title", {
                deviceName: sharePairingName,
              })}
            </Text>
            <Text style={styles.shareDescription}>
              {t("devices.share.description")}
            </Text>
            {shareLink ? (
              <View style={styles.qrFrame}>
                <QRCode
                  value={shareLink}
                  size={220}
                  backgroundColor="#ffffff"
                  color="#111827"
                />
              </View>
            ) : null}
            <Text selectable numberOfLines={3} style={styles.shareLink}>
              {shareLink}
            </Text>
            <Text style={styles.shareWarning}>
              {t("devices.share.warning")}
            </Text>
            <View style={styles.shareActions}>
              <Button
                style={styles.shareActionButton}
                variant="ghost"
                onPress={() => setSharePairing(null)}
              >
                {t("common.close")}
              </Button>
              <Button
                icon="qr"
                style={styles.shareActionButton}
                tone="primary"
                variant="solid"
                onPress={handleSystemShare}
              >
                {t("devices.share.systemShare")}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
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
    alignItems: "center",
    gap: spacing.sm,
  },
  headerText: {
    flex: 1,
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
  headerIconButton: {
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
  flexFiller: {
    flex: 1,
  },
  moreButton: {
    minHeight: 28,
    width: 28,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
  },
  expandedActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionButton: {
    minHeight: 36,
    borderRadius: radii.sm,
    flexGrow: 1,
    flexBasis: "30%",
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
  webRefreshIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  webRefreshIndicatorText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  modalBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: "rgba(0, 0, 0, 0.68)",
  },
  shareSheet: {
    width: "100%",
    maxWidth: 360,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceRaised,
    padding: spacing.xl,
    gap: spacing.md,
  },
  shareTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  shareDescription: {
    color: colors.textSecondary,
    lineHeight: 20,
  },
  qrFrame: {
    alignSelf: "center",
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: "#ffffff",
  },
  shareLink: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  shareWarning: {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 18,
  },
  shareActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  shareActionButton: {
    flex: 1,
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

function getSavedDeviceStatusPresentation(
  t: (key: string) => string,
): DeviceStatusPresentation {
  return {
    backgroundColor: "rgba(148, 163, 173, 0.16)",
    color: colors.textMuted,
    detail: "",
    label: t("devices.status.idle"),
  };
}

function getDeviceStatusPresentation(
  status: string,
  t: (key: string) => string,
  message?: string,
): DeviceStatusPresentation {
  switch (status) {
    case "authenticated":
      return {
        backgroundColor: colors.successSoft,
        color: colors.success,
        detail: "",
        label: t("devices.status.online"),
      };
    case "connecting":
    case "authenticating":
      return {
        backgroundColor: colors.warningSoft,
        color: colors.warning,
        detail: message ?? "",
        label: t("devices.status.connecting"),
      };
    case "failed":
      return {
        backgroundColor: colors.dangerSoft,
        color: colors.danger,
        detail: message ?? "",
        label: t("devices.status.offline"),
      };
    default:
      return {
        backgroundColor: colors.neutralSoft,
        color: colors.textMuted,
        detail: message ?? "",
        label: t("devices.status.idle"),
      };
  }
}

function getConnectionPathPresentation(
  status: string,
  path: TransportPath,
  t: (key: string) => string,
): ConnectionPathPresentation | undefined {
  if (status !== "authenticated") {
    return undefined;
  }
  if (path === "p2p") {
    return {
      backgroundColor: colors.successSoft,
      color: colors.success,
      label: t("devices.status.direct"),
    };
  }
  return {
    backgroundColor: colors.neutralSoft,
    color: colors.textSecondary,
    label: t("devices.status.relayAssisted"),
  };
}

interface DeviceStatusPresentation {
  backgroundColor: string;
  color: string;
  detail: string;
  label: string;
}

interface ConnectionPathPresentation {
  backgroundColor: string;
  color: string;
  label: string;
}

function useWebPullToRefresh(
  scrollRef: RefObject<ScrollView | null>,
  refreshing: boolean,
  onRefresh: () => void,
): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    const scrollNode = (
      scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement }
    )?.getScrollableNode?.();
    if (!scrollNode) {
      return;
    }

    let startY: number | null = null;
    let currentOffset = 0;
    let pulling = false;

    const handleTouchStart = (event: TouchEvent): void => {
      if (
        refreshing ||
        scrollNode.scrollTop > 0 ||
        event.touches.length !== 1
      ) {
        startY = null;
        return;
      }
      startY = event.touches[0].clientY;
      pulling = false;
    };

    const handleTouchMove = (event: TouchEvent): void => {
      if (startY === null || refreshing) {
        return;
      }
      const delta = event.touches[0].clientY - startY;
      if (delta <= 0) {
        if (pulling) {
          pulling = false;
          currentOffset = 0;
          setOffset(0);
        }
        return;
      }
      if (scrollNode.scrollTop > 0) {
        startY = null;
        return;
      }
      pulling = true;
      // Resistance curve so the indicator slows as it grows.
      currentOffset = Math.min(WEB_PULL_MAX, delta * 0.5);
      setOffset(currentOffset);
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    const handleTouchEnd = (): void => {
      if (startY === null) {
        return;
      }
      const triggered = pulling && currentOffset >= WEB_PULL_THRESHOLD;
      startY = null;
      pulling = false;
      currentOffset = 0;
      setOffset(0);
      if (triggered) {
        onRefresh();
      }
    };

    scrollNode.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    scrollNode.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    scrollNode.addEventListener("touchend", handleTouchEnd);
    scrollNode.addEventListener("touchcancel", handleTouchEnd);

    return () => {
      scrollNode.removeEventListener("touchstart", handleTouchStart);
      scrollNode.removeEventListener("touchmove", handleTouchMove);
      scrollNode.removeEventListener("touchend", handleTouchEnd);
      scrollNode.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [onRefresh, refreshing, scrollRef]);

  return offset;
}
