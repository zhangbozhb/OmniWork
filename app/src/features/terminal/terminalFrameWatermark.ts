export function terminalFrameWatermarkAfterSnapshot(
  current: number | undefined,
  snapshotSeq: number | undefined,
): number | undefined {
  if (typeof snapshotSeq !== "number") {
    return undefined;
  }
  return Math.max(current ?? 0, snapshotSeq);
}
