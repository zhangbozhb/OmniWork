import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Camera as CameraKitCamera, CameraType } from "react-native-camera-kit";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import type { PairingConfig } from "../../features/auth/types";
import { parsePairingConfig } from "../../features/auth/pairingConfig";
import { openSystemSettings } from "../../platform/linking/appLinking";
import { Button } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";

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
    "Point the camera at the Desktop Agent pairing QR code.",
  );

  useEffect(() => {
    if (!visible) {
      scanLockedRef.current = false;
      setScanMessage("Point the camera at the Desktop Agent pairing QR code.");
      return;
    }
    void requestCameraPermission().then(({ granted, blocked }) => {
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
      const value = event.nativeEvent.codeStringValue?.trim();
      const pairing = value ? parsePairingConfig(value) : null;
      if (!pairing) {
        setScanMessage("This pairing QR code is invalid.");
        return;
      }
      scanLockedRef.current = true;
      setScanMessage("Pairing request sent. Approve it on the Desktop Agent.");
      void Promise.resolve(onScanned(pairing)).catch((error: unknown) => {
        scanLockedRef.current = false;
        setScanMessage(
          error instanceof Error
            ? error.message
            : "Could not import the pairing QR code.",
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
      <SafeAreaProvider>
        <SafeAreaView
          edges={["top", "right", "bottom", "left"]}
          style={styles.safeArea}
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Scan Desktop QR</Text>
              <Text style={styles.subtitle}>
                The Agent will ask for local approval before trusting this App.
              </Text>
            </View>
            <Button
              accessibilityLabel="Close QR scanner"
              icon="close"
              iconOnly
              style={styles.closeButton}
              onPress={onClose}
            >
              Close
            </Button>
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
                <Text style={styles.fallbackTitle}>
                  {cameraPermissionDenied
                    ? "Camera permission needed"
                    : "Preparing camera"}
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
          <Text style={styles.hint}>{scanMessage}</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

async function requestCameraPermission(): Promise<{
  granted: boolean;
  blocked: boolean;
}> {
  if (Platform.OS !== "android") {
    return { granted: true, blocked: false };
  }
  const permission = PermissionsAndroid.PERMISSIONS.CAMERA;
  if (await PermissionsAndroid.check(permission)) {
    return { granted: true, blocked: false };
  }
  const status = await PermissionsAndroid.request(permission);
  return {
    granted: status === PermissionsAndroid.RESULTS.GRANTED,
    blocked: status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
  };
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.lg,
    gap: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  headerText: { flex: 1 },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: "800" },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  closeButton: {
    minHeight: 38,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
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
  fallbackTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
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
  hint: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
