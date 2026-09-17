import { type JSX, useEffect, useState } from "react";
import { Alert, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";

import type { PairingConfig } from "../../features/auth/types";
import {
  createPairingConfig,
  isSameRelayOrigin,
  parsePairingConfig,
} from "../../features/auth/pairingConfig";
import { appConfig } from "../../app/appConfig";
import { Button, Card } from "../../ui/components";
import { KeyboardAwareScrollView } from "../../ui/KeyboardAwareScrollView";
import { colors, radii, spacing, typography } from "../../ui/theme";
import {
  PAIRING_SCANNER_SUPPORTED,
  PairingQrScannerModal,
} from "./PairingQrScannerModal";

type AddDeviceMode = "details" | "link";

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
  const [addMode, setAddMode] = useState<AddDeviceMode>("details");
  const [pairingLink, setPairingLink] = useState("");
  const [relayUrl, setRelayUrl] = useState(
    initialPairing?.relayUrl ?? appConfig.defaultRelayUrl,
  );
  const [deviceId, setDeviceId] = useState(initialPairing?.deviceId ?? "");
  const [displayName, setDisplayName] = useState(
    initialPairing?.displayName ?? "",
  );
  const [relaySessionToken, setRelaySessionToken] = useState(
    initialPairing?.relaySessionToken ?? "",
  );
  const [scannerVisible, setScannerVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();

  useEffect(() => {
    setAddMode("details");
    setPairingLink("");
    setRelayUrl(initialPairing?.relayUrl ?? appConfig.defaultRelayUrl);
    setDeviceId(initialPairing?.deviceId ?? "");
    setDisplayName(initialPairing?.displayName ?? "");
    setRelaySessionToken(initialPairing?.relaySessionToken ?? "");
    setLocalError(undefined);
  }, [initialPairing]);

  function notifyValidationError(title: string, message: string): void {
    setLocalError(message);
    if (Platform.OS !== "web") {
      Alert.alert(title, message);
    }
  }

  const targetRelayUrl = !initialPairing && addMode === "link"
    ? parsePairingConfig(pairingLink)?.relayUrl ?? ""
    : relayUrl;

  function tokenForTarget(nextRelayUrl: string): string | undefined {
    return isSameRelayOrigin(targetRelayUrl, nextRelayUrl)
      ? relaySessionToken.trim() || undefined
      : undefined;
  }

  function changeRelayUrl(value: string): void {
    setRelaySessionToken(tokenForTarget(value) ?? "");
    setRelayUrl(value);
  }

  function changePairingLink(value: string): void {
    setRelaySessionToken(
      tokenForTarget(parsePairingConfig(value)?.relayUrl ?? "") ?? "",
    );
    setPairingLink(value);
  }

  function changeMode(mode: AddDeviceMode): void {
    const nextRelayUrl = mode === "link"
      ? parsePairingConfig(pairingLink)?.relayUrl ?? ""
      : relayUrl;
    setRelaySessionToken(tokenForTarget(nextRelayUrl) ?? "");
    setAddMode(mode);
    setLocalError(undefined);
  }

  async function submit(): Promise<void> {
    const target =
      !initialPairing && addMode === "link"
        ? parsePairingConfig(pairingLink)
        : createPairingConfig({
            ...initialPairing,
            relayUrl,
            deviceId,
            displayName,
          });
    if (!target) {
      const linkMode = !initialPairing && addMode === "link";
      notifyValidationError(
        t(
          linkMode
            ? "pairing.validation.invalidQrTitle"
            : "pairing.validation.invalidTargetTitle",
        ),
        t(
          linkMode
            ? "pairing.validation.invalidQrMessage"
            : "pairing.validation.invalidTargetMessage",
        ),
      );
      return;
    }
    setLocalError(undefined);
    setSubmitting(true);
    try {
      await onPair({
        ...target,
        relaySessionToken: tokenForTarget(target.relayUrl),
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleScannedPairing(pairing: PairingConfig): void {
    setScannerVisible(false);
    setLocalError(undefined);
    setRelaySessionToken(tokenForTarget(pairing.relayUrl) ?? "");
    setRelayUrl(pairing.relayUrl);
    setDeviceId(pairing.deviceId);
    setDisplayName(pairing.displayName ?? "");
    setAddMode("details");
  }

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.screen}>
      {PAIRING_SCANNER_SUPPORTED && !initialPairing ? (
        <Card success style={styles.scanCard}>
          <Text style={styles.scanEyebrow}>{t("pairing.scan.recommended")}</Text>
          <Text style={styles.scanTitle}>{t("pairing.scan.title")}</Text>
          <Text style={styles.scanText}>{t("pairing.scan.text")}</Text>
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
      ) : null}

      {!initialPairing ? (
        <View style={styles.modeSwitch}>
          <Button
            style={styles.modeButton}
            tone={addMode === "details" ? "primary" : "secondary"}
            variant={addMode === "details" ? "solid" : "outline"}
            onPress={() => changeMode("details")}
          >
            {t("pairing.modes.details")}
          </Button>
          <Button
            style={styles.modeButton}
            tone={addMode === "link" ? "primary" : "secondary"}
            variant={addMode === "link" ? "solid" : "outline"}
            onPress={() => changeMode("link")}
          >
            {t("pairing.modes.link")}
          </Button>
        </View>
      ) : null}

      {initialPairing || addMode === "details" ? (
        <>
          <Text style={styles.label}>{t("pairing.fields.relayUrl")}</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            value={relayUrl}
            onChangeText={changeRelayUrl}
            placeholder="wss://your-domain.example/relay/ws/mobile"
            placeholderTextColor={colors.textDim}
            style={styles.input}
          />
          <Text style={styles.label}>{t("pairing.fields.deviceId")}</Text>
          {initialPairing ? (
            <Text selectable style={styles.identity}>
              {deviceId}
            </Text>
          ) : (
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              value={deviceId}
              onChangeText={setDeviceId}
              placeholder="DEV1-..."
              placeholderTextColor={colors.textDim}
              style={styles.input}
            />
          )}
          <Text style={styles.label}>{t("pairing.fields.displayName")}</Text>
          <TextInput
            autoCapitalize="words"
            autoCorrect={false}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder={t("pairing.fields.displayNamePlaceholder")}
            placeholderTextColor={colors.textDim}
            style={styles.input}
          />
        </>
      ) : (
        <>
          <Text style={styles.label}>{t("pairing.fields.pairingLink")}</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            value={pairingLink}
            onChangeText={changePairingLink}
            placeholder="omniwork://pair?..."
            placeholderTextColor={colors.textDim}
            style={[styles.input, styles.linkInput]}
          />
        </>
      )}

      <Text style={styles.label}>{t("pairing.fields.relaySessionToken")}</Text>
      <TextInput
        accessibilityLabel={t("pairing.fields.relaySessionToken")}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        secureTextEntry
        value={relaySessionToken}
        onChangeText={setRelaySessionToken}
        placeholder={t("pairing.fields.relaySessionTokenPlaceholder")}
        placeholderTextColor={colors.textDim}
        style={styles.input}
      />
      <Text style={styles.hint}>{t("pairing.relaySignInHint")}</Text>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      {localError && localError !== errorMessage ? (
        <Text style={styles.error}>{localError}</Text>
      ) : null}

      <View style={styles.actions}>
        {onCancel ? (
          <Button disabled={submitting} style={styles.action} onPress={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button
          disabled={submitting}
          icon={submitting ? "refresh" : "save"}
          style={styles.action}
          tone="primary"
          onPress={submit}
        >
          {submitLabel ?? t("pairing.actions.save")}
        </Button>
      </View>

      <PairingQrScannerModal
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={handleScannedPairing}
      />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    gap: spacing.md,
  },
  scanCard: {
    padding: spacing.xl,
  },
  scanEyebrow: {
    color: colors.success,
    ...typography.eyebrow,
  },
  scanTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
    marginTop: spacing.sm,
  },
  scanText: {
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  scanButton: {
    marginTop: spacing.lg,
  },
  modeSwitch: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  modeButton: {
    flex: 1,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    minHeight: 48,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
  },
  linkInput: {
    minHeight: 120,
    paddingVertical: spacing.md,
    textAlignVertical: "top",
  },
  identity: {
    color: colors.textPrimary,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 13,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  action: {
    flex: 1,
  },
});
