import type { JSX } from "react";
import { useMemo, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  useWindowDimensions,
} from "react-native";
import Svg, { Line } from "react-native-svg";

import { colors, radii, spacing } from "../../ui/theme";

interface Point {
  index: number;
  x: number;
  y: number;
}

export interface GesturePadProps {
  disabled?: boolean;
  appearance?: "panel" | "floating";
  maxPoints?: number;
  showKeyLabels?: boolean;
  status?: "idle" | "error" | "success";
  onComplete(gesture: number[]): void;
  onProgress?(count: number): void;
}

const GRID_SIZE = 3;
const PAD_WIDTH_RATIO = 0.86;
const PAD_MIN_SIZE = 336;
const PAD_MAX_SIZE = 520;
const DOT_MIN_SIZE = 66;
const DOT_MAX_SIZE = 86;
const GRID_EDGE_RATIO = 0.2;
const KEY_LABELS = [
  { number: "1", letters: "" },
  { number: "2", letters: "A B C" },
  { number: "3", letters: "D E F" },
  { number: "4", letters: "G H I" },
  { number: "5", letters: "J K L" },
  { number: "6", letters: "M N O" },
  { number: "7", letters: "P Q R S" },
  { number: "8", letters: "T U V" },
  { number: "9", letters: "W X Y Z" },
];

export function GesturePad({
  disabled,
  appearance = "panel",
  maxPoints = GRID_SIZE * GRID_SIZE,
  showKeyLabels = false,
  status = "idle",
  onComplete,
  onProgress,
}: GesturePadProps): JSX.Element {
  const { width: windowWidth } = useWindowDimensions();
  const horizontalInset =
    appearance === "floating" ? spacing.md * 2 : spacing.xl * 2;
  const availablePadSize = Math.max(windowWidth - horizontalInset, 260);
  const padSize = Math.round(
    Math.min(
      Math.max(windowWidth * PAD_WIDTH_RATIO, PAD_MIN_SIZE),
      PAD_MAX_SIZE,
      availablePadSize,
    ),
  );
  const dotSize = getDotSize(padSize);
  const dotHitRadius = dotSize / 2 + 10;
  const [layout, setLayout] = useState({
    width: padSize,
    height: padSize,
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);

  const points = useMemo(
    () => createPoints(layout.width, layout.height),
    [layout],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => {
          if (disabled) return;
          const point = findPoint(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
            points,
            dotHitRadius,
          );
          const nextSelection = point ? [point.index] : [];
          setSelected(nextSelection);
          onProgress?.(nextSelection.length);
          setCurrentPoint(point);
        },
        onPanResponderMove: (
          event: GestureResponderEvent,
          _state: PanResponderGestureState,
        ) => {
          if (disabled) return;
          const nextPoint = findPoint(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
            points,
            dotHitRadius,
          );
          setCurrentPoint({
            index: -1,
            x: event.nativeEvent.locationX,
            y: event.nativeEvent.locationY,
          });
          if (!nextPoint) {
            return;
          }
          setSelected((current) => {
            if (
              current.includes(nextPoint.index) ||
              current.length >= maxPoints
            ) {
              return current;
            }
            const nextSelection = [...current, nextPoint.index];
            onProgress?.(nextSelection.length);
            if (nextSelection.length >= maxPoints) {
              requestAnimationFrame(() => {
                setCurrentPoint(null);
                setSelected([]);
                onProgress?.(0);
                onComplete(nextSelection);
              });
            }
            return nextSelection;
          });
        },
        onPanResponderRelease: () => {
          setCurrentPoint(null);
          setSelected((current) => {
            if (current.length > 0 && current.length < maxPoints) {
              onComplete(current);
            }
            onProgress?.(0);
            return [];
          });
        },
        onPanResponderTerminate: () => {
          setCurrentPoint(null);
          setSelected([]);
          onProgress?.(0);
        },
      }),
    [disabled, dotHitRadius, maxPoints, onComplete, onProgress, points],
  );

  const selectedPoints = selected
    .map((index) => points[index])
    .filter((point): point is Point => Boolean(point));
  const activeLineEnd =
    currentPoint && selectedPoints.length > 0 ? currentPoint : undefined;
  const activeColor =
    status === "error"
      ? colors.danger
      : status === "success"
        ? colors.success
        : colors.success;

  return (
    <View
      style={[
        styles.pad,
        appearance === "panel" && styles.padPanel,
        { width: padSize },
      ]}
      onLayout={(event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setLayout({ width, height });
      }}
      {...responder.panHandlers}
    >
      <Svg style={StyleSheet.absoluteFill}>
        {selectedPoints.slice(1).map((point, index) => {
          const previous = selectedPoints[index];
          return (
            <Line
              key={`${previous.index}-${point.index}`}
              x1={previous.x}
              y1={previous.y}
              x2={point.x}
              y2={point.y}
              stroke={activeColor}
              strokeWidth={4}
              strokeLinecap="round"
            />
          );
        })}
        {activeLineEnd ? (
          <Line
            x1={selectedPoints[selectedPoints.length - 1].x}
            y1={selectedPoints[selectedPoints.length - 1].y}
            x2={activeLineEnd.x}
            y2={activeLineEnd.y}
            stroke={activeColor}
            strokeWidth={4}
            strokeLinecap="round"
            opacity={0.5}
          />
        ) : null}
      </Svg>
      {points.map((point) => {
        const active = selected.includes(point.index);
        return (
          <View
            key={point.index}
            pointerEvents="none"
            style={[
              styles.dot,
              appearance === "floating" && styles.dotFloating,
              showKeyLabels && styles.dotKeypad,
              {
                left: point.x - dotSize / 2,
                top: point.y - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: dotSize / 2,
              },
              active && styles.dotActive,
              active && status === "error" && styles.dotError,
            ]}
          >
            {showKeyLabels ? (
              <>
                <Text style={styles.dotNumber}>
                  {KEY_LABELS[point.index].number}
                </Text>
                {KEY_LABELS[point.index].letters ? (
                  <Text style={styles.dotLetters}>
                    {KEY_LABELS[point.index].letters}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text style={styles.dotText}> </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

function createPoints(width: number, height: number): Point[] {
  const horizontalGap = (width * (1 - GRID_EDGE_RATIO * 2)) / (GRID_SIZE - 1);
  const verticalGap = (height * (1 - GRID_EDGE_RATIO * 2)) / (GRID_SIZE - 1);
  return Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => ({
    index,
    x: width * GRID_EDGE_RATIO + horizontalGap * (index % GRID_SIZE),
    y: height * GRID_EDGE_RATIO + verticalGap * Math.floor(index / GRID_SIZE),
  }));
}

function getDotSize(padSize: number): number {
  return Math.min(
    Math.max(Math.round(padSize * 0.23), DOT_MIN_SIZE),
    DOT_MAX_SIZE,
  );
}

function findPoint(
  x: number,
  y: number,
  points: Point[],
  hitRadius: number,
): Point | null {
  return (
    points.find((point) => {
      const dx = point.x - x;
      const dy = point.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= hitRadius;
    }) ?? null
  );
}

const styles = StyleSheet.create({
  pad: {
    alignSelf: "center",
    aspectRatio: 1,
    borderRadius: radii.lg,
    marginVertical: spacing.md,
  },
  padPanel: {
    backgroundColor: colors.surfaceRaised,
  },
  dot: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dotFloating: {
    borderColor: "rgba(245, 247, 248, 0.72)",
    backgroundColor: "rgba(245, 247, 248, 0.08)",
  },
  dotKeypad: {
    borderWidth: 0,
    backgroundColor: "rgba(96, 112, 124, 0.42)",
  },
  dotActive: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  dotError: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
  },
  dotText: {
    color: "transparent",
  },
  dotNumber: {
    color: colors.textPrimary,
    fontSize: 33,
    fontWeight: "300",
    includeFontPadding: false,
    lineHeight: 37,
  },
  dotLetters: {
    color: colors.textPrimary,
    fontSize: 10,
    fontWeight: "800",
    includeFontPadding: false,
    letterSpacing: 0.8,
    lineHeight: 12,
    marginTop: -2,
  },
});
