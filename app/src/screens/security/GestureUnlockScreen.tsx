import type { JSX } from "react";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/components";
import { colors, spacing, typography } from "../../ui/theme";
import { GesturePad } from "./GesturePad";

export interface GestureUnlockScreenProps {
  canCancel?: boolean;
  onCancel?: () => void;
  onUnlock(gesture: number[]): boolean;
}

export function GestureUnlockScreen({
  canCancel,
  onCancel,
  onUnlock,
}: GestureUnlockScreenProps): JSX.Element {
  const { t } = useTranslation();
  const [message, setMessage] = useState(t("appLock.unlock.hint"));
  const [status, setStatus] = useState<"idle" | "error" | "success">("idle");

  function handleGesture(gesture: number[]): void {
    if (onUnlock(gesture)) {
      setStatus("success");
      setMessage(t("appLock.unlock.success"));
      return;
    }
    setStatus("error");
    setMessage(t("appLock.unlock.error"));
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.headerText}>
        <Text style={styles.eyebrow}>{t("appLock.eyebrow")}</Text>
        <Text style={styles.title}>{t("appLock.unlock.title")}</Text>
        <Text style={styles.subtitle}>{t("appLock.unlock.subtitle")}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.message}>{message}</Text>
        <GesturePad status={status} onComplete={handleGesture} />
      </View>
      {canCancel && onCancel ? (
        <Button variant="ghost" onPress={onCancel}>
          {t("common.cancel")}
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
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  headerText: {
    gap: spacing.xs,
    alignItems: "center",
  },
  eyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
    textAlign: "center",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  card: {
    padding: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  message: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    textAlign: "center",
  },
});
