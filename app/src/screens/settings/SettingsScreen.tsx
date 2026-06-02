import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import {
  TERMINAL_TEXT_SIZE_OPTIONS,
  type TerminalTextSize,
} from "../../features/terminal/terminalLayout";
import {
  APP_LANGUAGE_OPTIONS,
  getAppLanguageLabel,
  type AppLanguage,
} from "../../i18n/language";
import { Icon } from "../../ui/icons";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface SettingsScreenProps {
  terminalTextSize: TerminalTextSize;
  language: AppLanguage;
  onChangeTerminalTextSize(textSize: TerminalTextSize): void;
  onChangeLanguage(language: AppLanguage): void;
  onOpenConnectionPreference(): void;
}

export function SettingsScreen({
  terminalTextSize,
  language,
  onChangeTerminalTextSize,
  onChangeLanguage,
  onOpenConnectionPreference,
}: SettingsScreenProps): JSX.Element {
  const { t } = useTranslation();
  const selectedTextSize = TERMINAL_TEXT_SIZE_OPTIONS.find(
    (option) => option.key === terminalTextSize,
  );
  const selectedTextSizeLabel = selectedTextSize
    ? t(`settings.terminalFontSize.options.${selectedTextSize.key}`)
    : t("settings.terminalFontSize.fallback");

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.headerText}>
        <Text style={styles.headerEyebrow}>{t("settings.eyebrow")}</Text>
        <Text style={styles.headerTitle}>{t("settings.title")}</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            {t("settings.language.title")}
          </Text>
          <Text style={styles.sectionMeta}>
            {getAppLanguageLabel(language)}
          </Text>
        </View>
        <Text style={styles.sectionHint}>{t("settings.language.hint")}</Text>
        <View style={styles.optionRow}>
          {APP_LANGUAGE_OPTIONS.map((option) => {
            const selected = option.value === language;
            return (
              <Pressable
                accessibilityLabel={t("settings.language.accessibility", {
                  label: option.label,
                })}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={option.value}
                style={({ pressed }) => [
                  styles.textSizeOption,
                  selected && styles.textSizeOptionSelected,
                  pressed && styles.pressed,
                ]}
                onPress={() => {
                  if (!selected) onChangeLanguage(option.value);
                }}
              >
                <Text
                  style={[
                    styles.textSizeOptionText,
                    selected && styles.textSizeOptionTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            {t("settings.terminalFontSize.title")}
          </Text>
          <Text style={styles.sectionMeta}>{selectedTextSizeLabel}</Text>
        </View>
        <Text style={styles.sectionHint}>
          {t("settings.terminalFontSize.hint")}
        </Text>
        <View style={styles.optionRow}>
          {TERMINAL_TEXT_SIZE_OPTIONS.map((option) => {
            const selected = option.key === terminalTextSize;
            const label = t(`settings.terminalFontSize.options.${option.key}`);
            return (
              <Pressable
                accessibilityLabel={t(
                  "settings.terminalFontSize.accessibility",
                  { label },
                )}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={option.key}
                style={({ pressed }) => [
                  styles.textSizeOption,
                  selected && styles.textSizeOptionSelected,
                  pressed && styles.pressed,
                ]}
                onPress={() => {
                  if (!selected) onChangeTerminalTextSize(option.key);
                }}
              >
                <Text
                  style={[
                    styles.textSizeOptionText,
                    selected && styles.textSizeOptionTextSelected,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          {t("settings.connection.title")}
        </Text>
        <Pressable
          accessibilityLabel={t("settings.connection.accessibility")}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.navigationRow,
            pressed && styles.pressed,
          ]}
          onPress={onOpenConnectionPreference}
        >
          <View style={styles.navigationIcon}>
            <Icon name="plug" color={colors.success} size={18} />
          </View>
          <View style={styles.navigationText}>
            <Text style={styles.navigationTitle}>
              {t("settings.connection.mode")}
            </Text>
            <Text style={styles.navigationHint}>
              {t("settings.connection.hint")}
            </Text>
          </View>
          <Text style={styles.navigationChevron}>{">"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  headerText: {
    gap: spacing.xs,
  },
  headerEyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  headerTitle: {
    color: colors.textPrimary,
    ...typography.title,
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
  optionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  textSizeOption: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
  },
  textSizeOptionSelected: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  textSizeOptionText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "800",
  },
  textSizeOptionTextSelected: {
    color: colors.success,
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
  navigationIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: colors.successSoft,
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
});
