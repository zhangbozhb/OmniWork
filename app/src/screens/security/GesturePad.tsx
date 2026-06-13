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
  status?: "idle" | "error" | "success";
  onComplete(gesture: number[]): void;
}

const GRID_SIZE = 3;
const PAD_SIZE = 258;

export function GesturePad({
  disabled,
  status = "idle",
  onComplete,
}: GesturePadProps): JSX.Element {
  const [layout, setLayout] = useState({ width: PAD_SIZE, height: PAD_SIZE });
  const [selected, setSelected] = useState<number[]>([]);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);

  const points = useMemo(() => createPoints(layout.width, layout.height), [layout]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => {
          if (disabled) return;
          const point = findPoint(event.nativeEvent.locationX, event.nativeEvent.locationY, points);
          setSelected(point ? [point.index] : []);
          setCurrentPoint(point);
        },
        onPanResponderMove: (
          event: GestureResponderEvent,
          _state: PanResponderGestureState,
        ) => {
          if (disabled) return;
          const nextPoint = findPoint(event.nativeEvent.locationX, event.nativeEvent.locationY, points);
          setCurrentPoint({
            index: -1,
            x: event.nativeEvent.locationX,
            y: event.nativeEvent.locationY,
          });
          if (!nextPoint) {
            return;
          }
          setSelected((current) =>
            current.includes(nextPoint.index)
              ? current
              : [...current, nextPoint.index],
          );
        },
        onPanResponderRelease: () => {
          setCurrentPoint(null);
          setSelected((current) => {
            if (current.length > 0) {
              onComplete(current);
            }
            return [];
          });
        },
        onPanResponderTerminate: () => {
          setCurrentPoint(null);
          setSelected([]);
        },
      }),
    [disabled, onComplete, points],
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
      style={styles.pad}
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
              {
                left: point.x - 18,
                top: point.y - 18,
              },
              active && styles.dotActive,
              active && status === "error" && styles.dotError,
            ]}
          >
            <Text style={styles.dotText}> </Text>
          </View>
        );
      })}
    </View>
  );
}

function createPoints(width: number, height: number): Point[] {
  const horizontalGap = width / (GRID_SIZE + 1);
  const verticalGap = height / (GRID_SIZE + 1);
  return Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => ({
    index,
    x: horizontalGap * ((index % GRID_SIZE) + 1),
    y: verticalGap * (Math.floor(index / GRID_SIZE) + 1),
  }));
}

function findPoint(x: number, y: number, points: Point[]): Point | null {
  return (
    points.find((point) => {
      const dx = point.x - x;
      const dy = point.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= 28;
    }) ?? null
  );
}

const styles = StyleSheet.create({
  pad: {
    alignSelf: "center",
    width: PAD_SIZE,
    height: PAD_SIZE,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceRaised,
    marginVertical: spacing.lg,
  },
  dot: {
    position: "absolute",
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
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
});
