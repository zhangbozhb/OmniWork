import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { GESTURE_MAX_POINT_COUNT } from "../../features/app-lock/appLockRules";
import { Button } from "../../ui/components";
import { colors, spacing } from "../../ui/theme";
import { GesturePad } from "./GesturePad";

export interface GestureUnlockScreenProps {
  canCancel?: boolean;
  onCancel?: () => void;
  onForgotGesture?: () => void;
  onUnlock(gesture: number[]): boolean;
}

export function GestureUnlockScreen({
  canCancel,
  onCancel,
  onForgotGesture,
  onUnlock,
}: GestureUnlockScreenProps): JSX.Element {
  const { t } = useTranslation();
  const title = t(getUnlockGreetingKey());
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
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
        </View>
        <GesturePad
          appearance="floating"
          maxPoints={GESTURE_MAX_POINT_COUNT}
          status={status}
          onComplete={handleGesture}
        />
        {canCancel && onCancel ? (
          <Button
            style={styles.cancelButton}
            variant="ghost"
            onPress={onCancel}
          >
            {t("common.cancel")}
          </Button>
        ) : null}
        {onForgotGesture ? (
          <Button
            style={styles.forgotButton}
            variant="ghost"
            onPress={onForgotGesture}
          >
            {t("appLock.reset.forgot")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function getUnlockGreetingKey(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) {
    return "appLock.unlock.greetingMorning";
  }
  if (hour >= 12 && hour < 18) {
    return "appLock.unlock.greetingAfternoon";
  }
  return "appLock.unlock.greetingEvening";
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: spacing.xxl,
    backgroundColor: "#05090c",
  },
  content: {
    flex: 1,
    justifyContent: "flex-start",
    paddingTop: 72,
    gap: 54,
  },
  titleBlock: {
    alignItems: "center",
    gap: spacing.md,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 27,
    fontWeight: "700",
    letterSpacing: 0.2,
    lineHeight: 34,
    textAlign: "center",
  },
  message: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 21,
    textAlign: "center",
  },
  cancelButton: {
    alignSelf: "center",
  },
  forgotButton: {
    alignSelf: "center",
  },
});
