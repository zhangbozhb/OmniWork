import { type JSX, useEffect, useState } from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

import { type PairingConfig } from "../../features/auth/types";
import { isValidSessionKey } from "../../features/auth/keyProof";
import { createAppInstanceId } from "../../features/auth/pairingConfig";
import { appConfig } from "../../app/appConfig";
import { Button, Card } from "../../ui/components";
import { KeyboardAwareScrollView } from "../../ui/KeyboardAwareScrollView";
import { colors, radii, spacing, typography } from "../../ui/theme";
import {
  PAIRING_SCANNER_SUPPORTED,
  PairingQrScannerModal,
} from "./PairingQrScannerModal";

export interface PairingScreenProps {
  errorMessage?: string;
  initialPairing?: PairingConfig;
  submitLabel?: string;
  onCancel?(): void;
  onPair(pairing: PairingConfig): void | Promise<void>;
}

export function PairingScreen({
  errorMessage,
  initialPairing,
  submitLabel,
  onCancel,
  onPair,
}: PairingScreenProps): JSX.Element {
  const { t } = useTranslation();
  const [relayUrl, setRelayUrl] = useState(
    initialPairing?.relayUrl ?? appConfig.defaultRelayUrl,
  );
  const [deviceId, setDeviceId] = useState(initialPairing?.deviceId ?? "");
  const [key, setKey] = useState(initialPairing?.key ?? "");
  const [keyId, setKeyId] = useState(initialPairing?.keyId ?? "");
  const [scannerVisible, setScannerVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // RN `Alert.alert` 在 web 上是 no-op，用本地 inline 错误兜底，避免用户在
  // 浏览器里点 Save 没有任何反馈。
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setRelayUrl(initialPairing?.relayUrl ?? appConfig.defaultRelayUrl);
    setDeviceId(initialPairing?.deviceId ?? "");
    setKey(initialPairing?.key ?? "");
    setKeyId(initialPairing?.keyId ?? "");
    setLocalError(undefined);
  }, [initialPairing]);

  function notifyValidationError(title: string, message: string): void {
    setLocalError(message);
    if (Platform.OS !== "web") {
      Alert.alert(title, message);
    }
  }

  async function submit(): Promise<void> {
    const trimmedKey = key.trim();
    if (!isValidSessionKey(trimmedKey)) {
      notifyValidationError(
        t("pairing.validation.invalidKeyTitle"),
        t("pairing.validation.invalidKeyMessage"),
      );
      return;
    }
    if (!relayUrl.trim() || !deviceId.trim()) {
      notifyValidationError(
        t("pairing.validation.missingDetailsTitle"),
        t("pairing.validation.missingDetailsMessage"),
      );
      return;
    }

    setLocalError(undefined);
    setSubmitting(true);
    try {
      await onPair({
        relayUrl: relayUrl.trim(),
        deviceId: deviceId.trim(),
        key: trimmedKey,
        keyId: keyId.trim() || undefined,
        appInstanceId: initialPairing?.appInstanceId ?? createAppInstanceId(),
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleScannedPairing(pairing: PairingConfig): Promise<void> {
    if (!isValidSessionKey(pairing.key)) {
      notifyValidationError(
        t("pairing.validation.invalidQrTitle"),
        t("pairing.validation.invalidQrMessage"),
      );
      return;
    }

    setRelayUrl(pairing.relayUrl);
    setDeviceId(pairing.deviceId);
    setKey(pairing.key);
    setKeyId(pairing.keyId ?? "");
    setScannerVisible(false);
    setLocalError(undefined);
    setSubmitting(true);
    try {
      await onPair(pairing);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.screen}>
      {PAIRING_SCANNER_SUPPORTED ? (
        <Card success style={styles.scanCard}>
          <Text style={styles.scanEyebrow}>{t("pairing.scan.recommended")}</Text>
          <Text style={styles.scanTitle}>{t("pairing.scan.title")}</Text>
          <Text style={styles.scanText}>
            {t("pairing.scan.text")}
          </Text>
          <Button
            accessibilityLabel={t("pairing.scan.accessibility")}
            disabled={submitting}
            icon="qr"
            style={styles.scanButton}
            tone="primary"
            onPress={() => setScannerVisible(true)}
          >
            {t("pairing.scan.button")}
          </Button>
        </Card>
      ) : (
        <Card success style={styles.scanCard}>
          <Text style={styles.scanEyebrow}>{t("pairing.web.eyebrow")}</Text>
          <Text style={styles.scanTitle}>{t("pairing.web.title")}</Text>
          <Text style={styles.scanText}>
            {t("pairing.web.text")}
          </Text>
        </Card>
      )}

      <View style={styles.dividerRow}>
        <View style={styles.divider} />
        <Text style={styles.dividerText}>
          {PAIRING_SCANNER_SUPPORTED
            ? t("pairing.manualFallback")
            : t("pairing.manualPairing")}
        </Text>
        <View style={styles.divider} />
      </View>

      <Text style={styles.label}>{t("pairing.fields.relayUrl")}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        value={relayUrl}
        onChangeText={setRelayUrl}
        placeholder="wss://your-domain.example/relay/ws/mobile"
        placeholderTextColor="#66727c"
        style={styles.input}
      />

      <Text style={styles.label}>{t("pairing.fields.deviceId")}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        value={deviceId}
        onChangeText={setDeviceId}
        placeholder="your-mac.local"
        placeholderTextColor="#66727c"
        style={styles.input}
      />

      <Text style={styles.label}>{t("pairing.fields.temporaryKey")}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        value={key}
        onChangeText={setKey}
        placeholder={t("pairing.fields.keyPlaceholder")}
        placeholderTextColor="#66727c"
        secureTextEntry
        style={styles.input}
      />

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      {localError && localError !== errorMessage ? (
        <Text style={styles.error}>{localError}</Text>
      ) : null}

      <Button
        disabled={submitting}
        icon={submitting ? "refresh" : "save"}
        style={styles.primaryButton}
        tone="primary"
        onPress={submit}
      >
        {submitting
          ? t("pairing.submit.saving")
          : (submitLabel ?? t("pairing.submit.pairMac"))}
      </Button>
      {onCancel ? (
        <Button icon="close" onPress={onCancel}>
          {t("common.cancel")}
        </Button>
      ) : null}

      {scannerVisible ? (
        <PairingQrScannerModal
          visible={scannerVisible}
          onClose={() => setScannerVisible(false)}
          onScanned={handleScannedPairing}
        />
      ) : null}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    paddingBottom: spacing.xxl * 3,
    gap: spacing.md,
  },
  scanCard: {
    padding: spacing.xl,
  },
  scanEyebrow: {
    color: colors.success,
    ...typography.eyebrow,
    letterSpacing: 0.7,
  },
  scanTitle: {
    color: colors.textPrimary,
    fontSize: 21,
    fontWeight: "800",
    marginTop: 6,
  },
  scanText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  scanButton: {
    minHeight: 46,
    marginTop: spacing.lg,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginVertical: 6,
  },
  divider: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  dividerText: {
    color: colors.textDim,
    ...typography.eyebrow,
    letterSpacing: 0.5,
  },
  label: {
    color: colors.textSecondary,
    ...typography.label,
  },
  input: {
    minHeight: 48,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
  },
  primaryButton: {
    minHeight: 48,
    marginTop: spacing.lg,
  },
  primaryButtonText: {
    color: colors.successText,
    ...typography.action,
    fontSize: 16,
  },
  disabled: {
    opacity: 0.55,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    borderColor: colors.border,
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  error: {
    color: colors.danger,
    marginTop: spacing.xs,
  },
});
