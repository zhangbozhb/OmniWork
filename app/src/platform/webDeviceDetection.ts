export interface WebDeviceSignals {
  userAgent: string;
  maxTouchPoints: number;
  finePointer: boolean;
  hover: boolean;
  coarsePointer: boolean;
}

const MOBILE_USER_AGENT =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i;

export function isPcWebDevice(signals: WebDeviceSignals): boolean {
  if (
    MOBILE_USER_AGENT.test(signals.userAgent) ||
    (/Macintosh/i.test(signals.userAgent) && signals.maxTouchPoints > 1)
  ) {
    return false;
  }
  if (signals.finePointer && signals.hover) {
    return true;
  }
  if (signals.coarsePointer && !signals.finePointer) {
    return false;
  }
  return true;
}
