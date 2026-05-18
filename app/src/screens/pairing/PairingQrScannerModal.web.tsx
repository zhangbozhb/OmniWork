import type { JSX } from "react";

import type { PairingConfig } from "../../features/auth/types";

export const PAIRING_SCANNER_SUPPORTED = false;

export function PairingQrScannerModal({
  visible: _visible,
  onClose: _onClose,
  onScanned: _onScanned,
}: {
  visible: boolean;
  onClose(): void;
  onScanned(pairing: PairingConfig): void | Promise<void>;
}): JSX.Element | null {
  return null;
}
