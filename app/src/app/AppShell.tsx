import type { JSX, ReactNode } from "react";
import {
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

import type { AppView, PrimaryTabView } from "./appTypes";
import type { LocalAgentMessageRecord } from "../features/agent/agentMessageStore";
import { Button } from "../ui/components";
import { Icon, type IconName } from "../ui/icons";

type EncryptedPairingModalProps = {
  visible: boolean;
  password: string;
  error?: string;
  onPasswordChange(password: string): void;
  onSubmit(): void;
  onCancel(): void;
};

type AppShellProps = {
  children: ReactNode;
  title: string;
  subtitle?: string;
  showHeader: boolean;
  showPrimaryTabs: boolean;
  activeTab: AppView;
  unreadMessages: number;
  agentMessageBanner?: LocalAgentMessageRecord;
  encryptedPairingModal: EncryptedPairingModalProps;
  onContentTouchStart(): void;
  onChangeTab(view: PrimaryTabView): void;
  onDismissAgentMessageBanner(): void;
  onOpenAgentMessageBanner(record: LocalAgentMessageRecord): void;
};

export function AppShell({
  children,
  title,
  subtitle,
  showHeader,
  showPrimaryTabs,
  activeTab,
  unreadMessages,
  agentMessageBanner,
  encryptedPairingModal,
  onContentTouchStart,
  onChangeTab,
  onDismissAgentMessageBanner,
  onOpenAgentMessageBanner,
}: AppShellProps): JSX.Element {
  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={styles.root}
        edges={["top", "right", "bottom", "left"]}
      >
        <StatusBar barStyle="light-content" />
        {showHeader ? (
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        ) : null}

        <View style={styles.content} onTouchStart={onContentTouchStart}>
          {children}
        </View>
        {showPrimaryTabs ? (
          <PrimaryTabBar
            activeView={activeTab as PrimaryTabView}
            unreadMessages={unreadMessages}
            onChange={onChangeTab}
          />
        ) : null}
        {agentMessageBanner ? (
          <AgentMessageBanner
            record={agentMessageBanner}
            onDismiss={onDismissAgentMessageBanner}
            onOpen={() => onOpenAgentMessageBanner(agentMessageBanner)}
          />
        ) : null}
        <EncryptedPairingModal {...encryptedPairingModal} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const PRIMARY_TABS: ReadonlyArray<{
  icon: IconName;
  value: PrimaryTabView;
}> = [
  { icon: "device", value: "devices" },
  { icon: "message", value: "messages" },
  { icon: "settings", value: "settings" },
];

function PrimaryTabBar({
  activeView,
  unreadMessages,
  onChange,
}: {
  activeView: PrimaryTabView;
  unreadMessages: number;
  onChange(view: PrimaryTabView): void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <View style={styles.tabBar} accessibilityRole="tablist">
      {PRIMARY_TABS.map((tab) => {
        const selected = tab.value === activeView;
        const tintColor = selected ? "#30c48d" : "#94a3ad";
        const label = t(`app.tabs.${tab.value}`);
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            style={({ pressed }) => [
              styles.tabButton,
              selected && styles.tabButtonActive,
              pressed && styles.tabButtonPressed,
            ]}
            onPress={() => onChange(tab.value)}
          >
            <View style={styles.tabIconWrap}>
              <Icon name={tab.icon} color={tintColor} size={20} />
              {tab.value === "messages" && unreadMessages > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {unreadMessages > 99 ? "99+" : unreadMessages}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function AgentMessageBanner({
  record,
  onDismiss,
  onOpen,
}: {
  record: LocalAgentMessageRecord;
  onDismiss(): void;
  onOpen(): void;
}): JSX.Element {
  const { t } = useTranslation();
  const message = record.message;
  return (
    <View style={styles.messageBanner} accessibilityRole="alert">
      <View style={styles.messageBannerHeader}>
        <Text style={styles.messageBannerProvider}>
          {message.provider.toUpperCase()}
        </Text>
        <Pressable accessibilityRole="button" onPress={onDismiss}>
          <Icon name="close" color="#94a3ad" size={18} />
        </Pressable>
      </View>
      <Text style={styles.messageBannerTitle}>{message.title}</Text>
      {message.summary ? (
        <Text numberOfLines={2} style={styles.messageBannerSummary}>
          {message.summary}
        </Text>
      ) : null}
      <View style={styles.messageBannerActions}>
        <Pressable
          accessibilityRole="button"
          style={styles.messageBannerAction}
          onPress={onOpen}
        >
          <Text style={styles.messageBannerActionText}>
            {t("messages.open")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={[styles.messageBannerAction, styles.messageBannerGhost]}
          onPress={onDismiss}
        >
          <Text
            style={[
              styles.messageBannerActionText,
              styles.messageBannerGhostText,
            ]}
          >
            {t("messages.later")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function EncryptedPairingModal({
  visible,
  password,
  error,
  onPasswordChange,
  onSubmit,
  onCancel,
}: EncryptedPairingModalProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onCancel}
    >
      <View style={styles.encryptedPairingBackdrop}>
        <View style={styles.encryptedPairingDialog}>
          <Text style={styles.encryptedPairingTitle}>
            {t("pairing.encrypted.title")}
          </Text>
          <Text style={styles.encryptedPairingText}>
            {t("pairing.encrypted.description")}
          </Text>
          <TextInput
            autoFocus
            keyboardType="number-pad"
            maxLength={4}
            placeholder={t("pairing.encrypted.placeholder")}
            placeholderTextColor="#64727c"
            secureTextEntry
            style={styles.encryptedPairingInput}
            value={password}
            onChangeText={(value) =>
              onPasswordChange(value.replace(/\D/g, "").slice(0, 4))
            }
            onSubmitEditing={onSubmit}
          />
          {error ? (
            <Text style={styles.encryptedPairingError}>{error}</Text>
          ) : null}
          <View style={styles.encryptedPairingActions}>
            <Button
              style={styles.encryptedPairingAction}
              variant="ghost"
              onPress={onCancel}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={password.length !== 4}
              style={styles.encryptedPairingAction}
              tone="primary"
              variant="solid"
              onPress={onSubmit}
            >
              {t("pairing.encrypted.import")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101417",
  },
  content: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    alignItems: "center",
    borderBottomColor: "#263037",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    color: "#94a3ad",
    fontSize: 12,
    marginTop: 3,
    textAlign: "center",
  },
  tabBar: {
    flexDirection: "row",
    borderTopColor: "#263037",
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: "#11181d",
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    minHeight: 46,
    borderRadius: 12,
  },
  tabButtonActive: {
    backgroundColor: "rgba(48, 196, 141, 0.12)",
  },
  tabButtonPressed: {
    opacity: 0.85,
  },
  tabIconWrap: {
    position: "relative",
  },
  tabBadge: {
    position: "absolute",
    top: -7,
    right: -11,
    minWidth: 17,
    height: 17,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: "#f4c95d",
  },
  tabBadgeText: {
    color: "#1b1300",
    fontSize: 10,
    fontWeight: "900",
  },
  tabLabel: {
    color: "#94a3ad",
    fontSize: 11,
    fontWeight: "800",
  },
  tabLabelActive: {
    color: "#30c48d",
  },
  messageBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 76,
    gap: 8,
    padding: 14,
    borderRadius: 18,
    borderColor: "#34424c",
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: "#11181d",
    shadowColor: "#000",
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  messageBannerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  messageBannerProvider: {
    color: "#30c48d",
    fontSize: 12,
    fontWeight: "900",
  },
  messageBannerTitle: {
    color: "#f5f7f8",
    fontSize: 15,
    fontWeight: "900",
  },
  messageBannerSummary: {
    color: "#94a3ad",
    fontSize: 13,
    lineHeight: 18,
  },
  messageBannerActions: {
    flexDirection: "row",
    gap: 10,
  },
  messageBannerAction: {
    flex: 1,
    alignItems: "center",
    borderRadius: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(48, 196, 141, 0.16)",
  },
  messageBannerActionText: {
    color: "#30c48d",
    fontSize: 13,
    fontWeight: "900",
  },
  messageBannerGhost: {
    backgroundColor: "rgba(148, 163, 173, 0.16)",
  },
  messageBannerGhostText: {
    color: "#d7dde2",
  },
  encryptedPairingBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "rgba(0, 0, 0, 0.52)",
  },
  encryptedPairingDialog: {
    width: "100%",
    maxWidth: 420,
    gap: 14,
    borderRadius: 22,
    borderColor: "#263037",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    backgroundColor: "#11181d",
  },
  encryptedPairingTitle: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "800",
  },
  encryptedPairingText: {
    color: "#94a3ad",
    fontSize: 14,
    lineHeight: 20,
  },
  encryptedPairingInput: {
    borderRadius: 14,
    borderColor: "#263037",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 8,
    textAlign: "center",
    backgroundColor: "#0d1317",
  },
  encryptedPairingError: {
    color: "#ff8b8b",
    fontSize: 13,
    fontWeight: "700",
  },
  encryptedPairingActions: {
    flexDirection: "row",
    gap: 10,
  },
  encryptedPairingAction: {
    flex: 1,
  },
});
