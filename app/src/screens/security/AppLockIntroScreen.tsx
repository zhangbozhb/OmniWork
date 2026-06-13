import type { JSX } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface AppLockIntroScreenProps {
  onSetup(): void;
  onSkip(): void;
}

export function AppLockIntroScreen({
  onSetup,
  onSkip,
}: AppLockIntroScreenProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>{t("appLock.eyebrow")}</Text>
        <Text style={styles.title}>{t("appLock.intro.title")}</Text>
        <Text style={styles.description}>{t("appLock.intro.description")}</Text>
        <View style={styles.actions}>
          <Button tone="primary" variant="solid" onPress={onSetup}>
            {t("appLock.intro.setup")}
          </Button>
          <Button variant="ghost" onPress={onSkip}>
            {t("appLock.intro.skip")}
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    justifyContent: "center",
    padding: spacing.xxl,
    backgroundColor: colors.background,
  },
  card: {
    gap: spacing.lg,
    padding: spacing.xxl,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  eyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  description: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    gap: spacing.sm,
  },
});
