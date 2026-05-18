import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Camera as CameraKitCamera, CameraType } from "react-native-camera-kit";

import { parsePairingLink } from "../../../../packages/protocol-ts/src/index.ts";
import { DEFAULT_PAIRING_TRANSPORT, type PairingConfig } from "../../features/auth/types";
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
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState(false);
  const [cameraPermissionDenied, setCameraPermissionDenied] = useState(false);
  const [scanMessage, setScanMessage] = useState(
    "Point the camera at the Mac Agent QR code.",
  );

  useEffect(() => {
    if (!visible) {
      scanLockedRef.current = false;
      setScanMessage("Point the camera at the Mac Agent QR code.");
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

  const handleCodeRead = useCallback(
    (event: CameraKitReadCodeEvent) => {
      if (scanLockedRef.current) {
        return;
      }

      const scannedValue = event.nativeEvent.codeStringValue?.trim();
      if (!scannedValue) {
        return;
      }

      const pairing = parsePairingConfig(scannedValue);
      if (!pairing) {
        setScanMessage("This is not an OmniWork pairing QR code.");
        return;
      }

      scanLockedRef.current = true;
      setScanMessage("Pairing QR code detected. Connecting...");
      Promise.resolve(onScanned(pairing)).catch((error: unknown) => {
        scanLockedRef.current = false;
        setScanMessage(
          `Could not import QR code: ${formatErrorMessage(error)}`,
        );
      });
    },
    [onScanned],
  );

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <View style={styles.scannerScreen}>
        <View style={styles.scannerHeader}>
          <View style={styles.scannerHeaderText}>
            <Text style={styles.scannerTitle}>Scan Mac Agent QR</Text>
            <Text style={styles.scannerSubtitle}>
              Use the QR code printed in the Agent terminal.
            </Text>
          </View>
          <Pressable style={styles.scannerCloseButton} onPress={onClose}>
            <Text style={styles.scannerCloseText}>Close</Text>
          </Pressable>
        </View>

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

        <Text style={styles.scannerHint}>{scanMessage}</Text>
      </View>
    </Modal>
  );
}

function parsePairingConfig(input: string): PairingConfig | null {
  const payload = parsePairingLink(input);
  if (!payload) {
    return null;
  }

  return {
    relayUrl: payload.relay_url,
    deviceId: payload.device_id,
    key: payload.key,
    keyId: payload.key_id,
    transport: payload.transport ?? DEFAULT_PAIRING_TRANSPORT,
  };
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
  scannerScreen: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.xxl,
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
});
