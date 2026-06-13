import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import {
  AUTO_LOCK_OPTIONS,
} from "../../features/app-lock/appLockRules";
import type { AppLockConfig, AutoLockOption } from "../../features/app-lock/types";
import { Button } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface SecuritySettingsScreenProps {
  config: AppLockConfig;
  pickerVisible: boolean;
  selectedAutoLockOption: AutoLockOption;
  onBack(): void;
  onEnable(): void;
  onChangeGesture(): void;
  onDisable(): void;
  onOpenAutoLockPicker(): void;
  onCloseAutoLockPicker(): void;
  onSelectAutoLockOption(option: AutoLockOption): void;
  onConfirmAutoLockOption(): void;
}

export function SecuritySettingsScreen({
  config,
  pickerVisible,
  selectedAutoLockOption,
  onBack,
  onEnable,
  onChangeGesture,
  onDisable,
  onOpenAutoLockPicker,
  onCloseAutoLockPicker,
  onSelectAutoLockOption,
  onConfirmAutoLockOption,
}: SecuritySettingsScreenProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.header}>
          <Button
            accessibilityLabel={t("common.back")}
            icon="arrowLeft"
            iconOnly
            style={styles.backButton}
            onPress={onBack}
          >
            {t("common.back")}
          </Button>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>{t("settings.eyebrow")}</Text>
            <Text style={styles.title}>{t("appLock.settings.title")}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              {t("appLock.settings.switchTitle")}
            </Text>
            <Text style={styles.sectionMeta}>
              {config.enabled
                ? t("appLock.settings.enabled")
                : t("appLock.settings.disabled")}
            </Text>
          </View>
          <Text style={styles.sectionHint}>
            {t("appLock.settings.switchHint")}
          </Text>
          {config.enabled ? (
            <Button tone="danger" onPress={onDisable}>
              {t("appLock.settings.disable")}
            </Button>
          ) : (
            <Button tone="primary" variant="solid" onPress={onEnable}>
              {t("appLock.settings.enable")}
            </Button>
          )}
        </View>

        {config.enabled ? (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {t("appLock.settings.autoLockTitle")}
              </Text>
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.navigationRow,
                  pressed && styles.pressed,
                ]}
                onPress={onOpenAutoLockPicker}
              >
                <View style={styles.navigationText}>
                  <Text style={styles.navigationTitle}>
                    {t("appLock.settings.autoLock")}
                  </Text>
                  <Text style={styles.navigationHint}>
                    {t("appLock.autoLock.options", {
                      context: String(config.autoLockOption),
                    })}
                  </Text>
                </View>
                <Text style={styles.navigationChevron}>{">"}</Text>
              </Pressable>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {t("appLock.settings.gestureTitle")}
              </Text>
              <Button onPress={onChangeGesture}>
                {t("appLock.settings.changeGesture")}
              </Button>
            </View>
          </>
        ) : null}
      </ScrollView>

      <Modal
        animationType="slide"
        transparent
        visible={pickerVisible}
        onRequestClose={onCloseAutoLockPicker}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {t("appLock.settings.autoLockTitle")}
            </Text>
            <ScrollView
              style={styles.wheel}
              contentContainerStyle={styles.wheelContent}
              showsVerticalScrollIndicator={false}
              snapToInterval={52}
              decelerationRate="fast"
            >
              {AUTO_LOCK_OPTIONS.map((option) => {
                const selected = option === selectedAutoLockOption;
                return (
                  <Pressable
                    key={String(option)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[
                      styles.wheelItem,
                      selected && styles.wheelItemSelected,
                    ]}
                    onPress={() => onSelectAutoLockOption(option)}
                  >
                    <Text
                      style={[
                        styles.wheelItemText,
                        selected && styles.wheelItemTextSelected,
                      ]}
                    >
                      {t("appLock.autoLock.options", {
                        context: String(option),
                      })}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <Button style={styles.modalButton} onPress={onCloseAutoLockPicker}>
                {t("common.cancel")}
              </Button>
              <Button
                style={styles.modalButton}
                tone="primary"
                variant="solid"
                onPress={onConfirmAutoLockOption}
              >
                {t("common.done")}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </>
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
    gap: spacing.md,
  },
  backButton: {
    minHeight: 36,
    width: 36,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
    marginTop: spacing.xs,
  },
  section: {
    gap: spacing.md,
    padding: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  sectionMeta: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "800",
  },
  sectionHint: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  navigationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  navigationText: {
    flex: 1,
    gap: 3,
  },
  navigationTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: "800",
  },
  navigationHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  navigationChevron: {
    color: colors.textDim,
    fontSize: 18,
    fontWeight: "900",
  },
  pressed: {
    opacity: 0.85,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  modalCard: {
    padding: spacing.xxl,
    gap: spacing.lg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.surface,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
  },
  wheel: {
    maxHeight: 170,
    borderTopColor: colors.borderSubtle,
    borderBottomColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  wheelContent: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  wheelItem: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  wheelItemSelected: {
    backgroundColor: colors.successSoft,
  },
  wheelItemText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: "800",
  },
  wheelItemTextSelected: {
    color: colors.success,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.md,
  },
  modalButton: {
    flex: 1,
  },
});
