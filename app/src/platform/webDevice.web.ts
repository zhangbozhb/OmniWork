import { isPcWebDevice } from "./webDeviceDetection";

export function isPcWebEnvironment(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const matches = (query: string): boolean =>
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia(query).matches;

  return isPcWebDevice({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    finePointer: matches("(pointer: fine)"),
    hover: matches("(hover: hover)"),
    coarsePointer: matches("(pointer: coarse)"),
  });
}
