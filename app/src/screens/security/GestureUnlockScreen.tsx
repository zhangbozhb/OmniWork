import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import {
  GESTURE_POINT_COUNT,
} from "../../features/app-lock/appLockRules";
import { Button } from "../../ui/components";
import { colors, spacing } from "../../ui/theme";
import { GesturePad } from "./GesturePad";
import { PasscodeDots } from "./PasscodeDots";

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
  const [inputCount, setInputCount] = useState(0);
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
          <Text style={styles.title}>{t("appLock.unlock.title")}</Text>
          <PasscodeDots
            count={inputCount}
            totalCount={GESTURE_POINT_COUNT}
          />
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
        {canCancel && onCancel ? (
          <Button style={styles.cancelButton} variant="ghost" onPress={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </View>
    </View>
  );
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
});
