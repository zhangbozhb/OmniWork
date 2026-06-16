import type { JSX } from "react";
import { StyleSheet, View } from "react-native";

import { colors, spacing } from "../../ui/theme";

interface PasscodeDotsProps {
  count: number;
  totalCount: number;
}

export function PasscodeDots({
  count,
  totalCount,
}: PasscodeDotsProps): JSX.Element {
  const filledCount = Math.min(count, totalCount);

  return (
    <View
      style={styles.container}
      accessibilityLabel={`${filledCount}/${totalCount}`}
    >
      {Array.from({ length: totalCount }, (_, index) => (
        <View
          key={index}
          style={[styles.dot, index < filledCount ? styles.dotFilled : null]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    gap: spacing.lg,
    justifyContent: "center",
    paddingVertical: spacing.xs,
  },
  dot: {
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 1.7,
    borderColor: "rgba(245, 247, 248, 0.86)",
  },
  dotFilled: {
    backgroundColor: colors.textPrimary,
  },
});
