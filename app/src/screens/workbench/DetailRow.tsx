import type { JSX } from "react";
import { Text, View } from "react-native";

import { styles } from "./styles";

export function DetailRow({
  label,
  value,
}: {
  label: string;
  value?: string;
}): JSX.Element | null {
  if (!value) {
    return null;
  }

  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text ellipsizeMode="middle" numberOfLines={1} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}
