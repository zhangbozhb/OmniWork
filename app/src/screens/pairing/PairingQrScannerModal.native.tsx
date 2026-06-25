import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { parseEncryptedPairingLink } from "@omniwork/protocol-ts";
import { Camera as CameraKitCamera, CameraType } from "react-native-camera-kit";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { type PairingConfig } from "../../features/auth/types";
import { decryptPairingConfig } from "../../features/auth/pairingConfig";
import { Button } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";
import { openSystemSettings } from "../../platform/linking/appLinking";

export const PAIRING_SCANNER_SUPPORTED = true;

type CameraKitReadCodeEvent = {
  nativeEvent: {
    codeStringValue?: string;
  };
};

export function PairingQrScannerModal({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose(): void;
  onScanned(pairing: PairingConfig): void | Promise<void>;
}): JSX.Element {
  const scanLockedRef = useRef(false);
  const passwordInputRef = useRef<TextInput | null>(null);
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState(false);
  const [cameraPermissionDenied, setCameraPermissionDenied] = useState(false);
  const [scanMessage, setScanMessage] = useState(
    "Point the camera at the Desktop QR code.",
  );
  const [pendingEncryptedLink, setPendingEncryptedLink] = useState<
    string | null
  >(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);

  useEffect(() => {
    if (!visible) {
      scanLockedRef.current = false;
      setPendingEncryptedLink(null);
      setPassword("");
      setPasswordError(null);
      setDecrypting(false);
      setScanMessage("Point the camera at the Desktop QR code.");
      return;
    }

    requestCameraPermission().then(({ granted, blocked }) => {
      setCameraPermissionGranted(granted);
      setCameraPermissionDenied(blocked || !granted);
      if (!granted) {
        setScanMessage(
          blocked
            ? "Camera permission is blocked. Open settings to enable scanning."
            : "Camera permission is required to scan the QR code.",
        );
      }
    });
  }, [visible]);

  useEffect(() => {
    if (!pendingEncryptedLink) {
      Keyboard.dismiss();
      return;
    }

    const focusTimer = setTimeout(() => {
      passwordInputRef.current?.focus();
    }, 150);
    return () => clearTimeout(focusTimer);
  }, [pendingEncryptedLink]);

  const handleCodeRead = useCallback((event: CameraKitReadCodeEvent) => {
    if (scanLockedRef.current) {
      return;
    }

    const scannedValue = event.nativeEvent.codeStringValue?.trim();
    if (!scannedValue) {
      return;
    }

    const encrypted = parseEncryptedPairingLink(scannedValue);
    if (!encrypted) {
      setScanMessage("This is not an encrypted OmniWork pairing QR code.");
      return;
    }

    scanLockedRef.current = true;
    setPendingEncryptedLink(scannedValue);
    setPassword("");
    setPasswordError(null);
    setDecrypting(false);
    setScanMessage("Encrypted QR code detected. Enter its 4-digit password.");
  }, []);

  const handleDecrypt = useCallback(() => {
    if (decrypting) {
      return;
    }
    if (!pendingEncryptedLink || password.length !== 4) {
      setPasswordError("Enter the 4-digit QR password.");
      return;
    }

    Keyboard.dismiss();
    setDecrypting(true);
    setPasswordError(null);
    setScanMessage("Decrypting QR code...");

    setTimeout(() => {
      const pairing = decryptPairingConfig(pendingEncryptedLink, password);
      if (!pairing) {
        setDecrypting(false);
        setPasswordError("Password is incorrect, expired, or invalid.");
        setScanMessage(
          "Password is incorrect, QR code is expired, or data is invalid.",
        );
        setPassword("");
        return;
      }

      setScanMessage("Pairing QR code decrypted. Connecting...");
      Promise.resolve(onScanned(pairing))
        .catch((error: unknown) => {
          scanLockedRef.current = false;
          setPendingEncryptedLink(null);
          setPassword("");
          setPasswordError(null);
          setScanMessage(
            `Could not import QR code: ${formatErrorMessage(error)}`,
          );
        })
        .finally(() => {
          setDecrypting(false);
        });
    }, 50);
  }, [decrypting, onScanned, password, pendingEncryptedLink]);

  useEffect(() => {
    if (pendingEncryptedLink && password.length === 4 && !decrypting) {
      handleDecrypt();
    }
  }, [decrypting, handleDecrypt, password, pendingEncryptedLink]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <SafeAreaProvider>
        <SafeAreaView
          edges={["top", "right", "bottom", "left"]}
          style={styles.scannerSafeArea}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.scannerScreen}
          >
            <View style={styles.scannerHeader}>
              <View style={styles.scannerHeaderText}>
                <Text style={styles.scannerTitle}>
                  {pendingEncryptedLink
                    ? "Enter QR Password"
                    : "Scan Desktop QR"}
                </Text>
                <Text style={styles.scannerSubtitle}>
                  {pendingEncryptedLink
                    ? "Use the 4-digit password shown with the QR code."
                    : "Use the QR code shown on your computer."}
                </Text>
              </View>
              <Button
                accessibilityLabel="Close QR scanner"
                icon="close"
                iconOnly
                style={styles.scannerCloseButton}
                onPress={onClose}
              >
                Close
              </Button>
            </View>

            {pendingEncryptedLink ? (
              <View style={styles.passwordStage}>
                <Pressable
                  accessibilityLabel="Dismiss keyboard"
                  style={styles.passwordDismissArea}
                  onPress={Keyboard.dismiss}
                />
                <View style={styles.passwordPanel}>
                  <Text style={styles.passwordTitle}>Enter QR password</Text>
                  <TextInput
                    ref={passwordInputRef}
                    keyboardType="number-pad"
                    maxLength={4}
                    placeholder="0000"
                    placeholderTextColor="#66727c"
                    secureTextEntry
                    style={styles.passwordInput}
                    value={password}
                    onChangeText={(value) => {
                      setPassword(value.replace(/\D/gu, "").slice(0, 4));
                      setPasswordError(null);
                    }}
                  />
                  {passwordError ? (
                    <Text style={styles.passwordError}>{passwordError}</Text>
                  ) : null}
                  <View style={styles.passwordActions}>
                    <Button
                      style={styles.passwordActionButton}
                      onPress={() => {
                        scanLockedRef.current = false;
                        Keyboard.dismiss();
                        setPendingEncryptedLink(null);
                        setPassword("");
                        setPasswordError(null);
                        setDecrypting(false);
                        setScanMessage(
                          "Point the camera at the Desktop QR code.",
                        );
                      }}
                    >
                      Scan Again
                    </Button>
                    <Button
                      disabled={decrypting || password.length !== 4}
                      style={styles.passwordActionButton}
                      tone="primary"
                      onPress={handleDecrypt}
                    >
                      {decrypting ? "Decrypting..." : "Decrypt"}
                    </Button>
                  </View>
                </View>
                <Pressable
                  accessibilityLabel="Dismiss keyboard"
                  style={styles.passwordDismissArea}
                  onPress={Keyboard.dismiss}
                />
              </View>
            ) : (
              <View style={styles.cameraPanel}>
                {cameraPermissionGranted ? (
                  <>
                    <CameraKitCamera
                      allowedBarcodeTypes={["qr"]}
                      cameraType={CameraType.Back}
                      onReadCode={handleCodeRead}
                      resizeMode="cover"
                      scanBarcode
                      scanThrottleDelay={1500}
                      showFrame={false}
                      style={StyleSheet.absoluteFill}
                      torchMode="off"
                    />
                    <View pointerEvents="none" style={styles.scanFrame} />
                  </>
                ) : (
                  <View style={styles.cameraFallback}>
                    <Text style={styles.cameraFallbackTitle}>
                      {cameraPermissionDenied
                        ? "Camera permission needed"
                        : "Preparing camera"}
                    </Text>
                    <Text style={styles.cameraFallbackText}>
                      {cameraPermissionDenied
                        ? "Allow camera access so OmniWork can scan the pairing QR code."
                        : "Initializing the camera scanner..."}
                    </Text>
                    <Button
                      icon={cameraPermissionDenied ? "qr" : "refresh"}
                      tone="primary"
                      onPress={() => {
                        void requestCameraPermission().then(
                          ({ granted, blocked }) => {
                            setCameraPermissionGranted(granted);
                            setCameraPermissionDenied(blocked || !granted);
                            if (!granted && blocked) {
                              void openSystemSettings();
                            }
                          },
                        );
                      }}
                    >
                      {cameraPermissionDenied ? "Allow Camera" : "Retry"}
                    </Button>
                  </View>
                )}
              </View>
            )}

            <Text style={styles.scannerHint}>{scanMessage}</Text>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

async function requestCameraPermission(): Promise<{
  granted: boolean;
  blocked: boolean;
}> {
  if (Platform.OS !== "android") {
    return { granted: true, blocked: false };
  }

  const permission = PermissionsAndroid.PERMISSIONS.CAMERA;
  const hasPermission = await PermissionsAndroid.check(permission);
  if (hasPermission) {
    return { granted: true, blocked: false };
  }

  const status = await PermissionsAndroid.request(permission);
  return {
    granted: status === PermissionsAndroid.RESULTS.GRANTED,
    blocked: status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
  };
}

const styles = StyleSheet.create({
  scannerSafeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scannerScreen: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.lg,
    gap: spacing.lg,
  },
  scannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  scannerHeaderText: {
    flex: 1,
  },
  scannerTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "800",
  },
  scannerSubtitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  scannerCloseButton: {
    minHeight: 38,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  scannerCloseText: {
    color: colors.textSecondary,
    fontWeight: "800",
  },
  cameraPanel: {
    flex: 1,
    minHeight: 360,
    overflow: "hidden",
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    backgroundColor: "#050708",
  },
  cameraFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xxl,
  },
  cameraFallbackTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
  },
  cameraFallbackText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  scanFrame: {
    position: "absolute",
    alignSelf: "center",
    top: "24%",
    width: "72%",
    aspectRatio: 1,
    borderColor: colors.success,
    borderRadius: radii.lg,
    borderWidth: 3,
  },
  scannerHint: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  passwordStage: {
    flex: 1,
    justifyContent: "center",
  },
  passwordDismissArea: {
    flex: 1,
    minHeight: spacing.lg,
  },
  passwordPanel: {
    width: "100%",
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.md,
  },
  passwordTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    textAlign: "center",
  },
  passwordInput: {
    minHeight: 48,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 8,
    paddingHorizontal: spacing.lg,
    textAlign: "center",
  },
  passwordError: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  passwordActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  passwordActionButton: {
    flex: 1,
    minHeight: 46,
  },
});
