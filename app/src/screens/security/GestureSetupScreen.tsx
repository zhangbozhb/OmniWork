import type { JSX } from "react";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { MIN_GESTURE_POINTS, isValidGesture } from "../../features/app-lock/appLockRules";
import { Button } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";
import { GesturePad } from "./GesturePad";

export interface GestureSetupScreenProps {
  mode: "firstRun" | "enable" | "change";
  onBack?: () => void;
  onSkip?: () => void;
  onComplete(gesture: number[]): void;
}

export function GestureSetupScreen({
  mode,
  onBack,
  onSkip,
  onComplete,
}: GestureSetupScreenProps): JSX.Element {
  const { t } = useTranslation();
  const [firstGesture, setFirstGesture] = useState<number[] | null>(null);
  const [message, setMessage] = useState(t("appLock.setup.hint"));
  const [status, setStatus] = useState<"idle" | "error" | "success">("idle");

  const title =
    mode === "change"
      ? t("appLock.setup.changeTitle")
      : t("appLock.setup.title");

  function handleGesture(gesture: number[]): void {
    if (!isValidGesture(gesture)) {
      setStatus("error");
      setMessage(
        t("appLock.setup.minPoints", { count: MIN_GESTURE_POINTS }),
      );
      return;
    }
    if (!firstGesture) {
      setFirstGesture(gesture);
      setStatus("idle");
      setMessage(t("appLock.setup.confirmHint"));
      return;
    }
    if (!sameGesture(firstGesture, gesture)) {
      setFirstGesture(null);
      setStatus("error");
      setMessage(t("appLock.setup.mismatch"));
      return;
    }
    setStatus("success");
    setMessage(t("appLock.setup.success"));
    onComplete(gesture);
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        {onBack ? (
          <Button
            accessibilityLabel={t("common.back")}
            icon="arrowLeft"
            iconOnly
            style={styles.backButton}
            onPress={onBack}
          >
            {t("common.back")}
          </Button>
        ) : null}
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>{t("appLock.eyebrow")}</Text>
          <Text style={styles.title}>{title}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.message}>{message}</Text>
        <GesturePad status={status} onComplete={handleGesture} />
        <Text style={styles.help}>{t("appLock.setup.displayHint")}</Text>
      </View>

      {mode === "firstRun" && onSkip ? (
        <Button variant="ghost" onPress={onSkip}>
          {t("appLock.setup.skip")}
        </Button>
      ) : null}
    </ScrollView>
  );
}

function sameGesture(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    gap: spacing.lg,
    justifyContent: "center",
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
    gap: spacing.xs,
  },
  eyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  card: {
    padding: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  message: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    textAlign: "center",
  },
  help: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
  },
});
