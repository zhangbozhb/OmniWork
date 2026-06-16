import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import {
  GESTURE_POINT_COUNT,
  isValidGesture,
} from "../../features/app-lock/appLockRules";
import { Button } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";
import { GesturePad } from "./GesturePad";
import { PasscodeDots } from "./PasscodeDots";

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
  const [inputCount, setInputCount] = useState(0);
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
        t("appLock.setup.exactPoints", { count: GESTURE_POINT_COUNT }),
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
    <View style={styles.screen}>
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
      </View>

      <View style={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{title}</Text>
          <PasscodeDots count={inputCount} totalCount={GESTURE_POINT_COUNT} />
          <Text style={styles.message}>{message}</Text>
        </View>
        <GesturePad
          appearance="floating"
          maxPoints={GESTURE_POINT_COUNT}
          showKeyLabels
          status={status}
          onComplete={handleGesture}
          onProgress={setInputCount}
        />
        {mode === "firstRun" && onSkip ? (
          <Button style={styles.skipButton} variant="ghost" onPress={onSkip}>
            {t("appLock.setup.skip")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function sameGesture(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: spacing.xxl,
    backgroundColor: "#05090c",
  },
  header: {
    minHeight: 44,
    justifyContent: "center",
  },
  backButton: {
    minHeight: 42,
    width: 42,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
    backgroundColor: "rgba(245, 247, 248, 0.08)",
  },
  title: {
    color: colors.textPrimary,
    fontSize: 27,
    fontWeight: "700",
    letterSpacing: 0.2,
    lineHeight: 34,
    textAlign: "center",
  },
  content: {
    flex: 1,
    justifyContent: "flex-start",
    paddingTop: 28,
    gap: 54,
  },
  titleBlock: {
    alignItems: "center",
    gap: spacing.md,
  },
  message: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 21,
    textAlign: "center",
  },
  skipButton: {
    alignSelf: "center",
  },
});
