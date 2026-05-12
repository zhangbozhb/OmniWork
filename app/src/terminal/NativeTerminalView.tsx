import type { JSX } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { normalizeTerminalFrame } from "./terminalText";

export interface NativeTerminalViewProps {
  frame: string;
}

export function NativeTerminalView({ frame }: NativeTerminalViewProps): JSX.Element {
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        horizontal
        nestedScrollEnabled
      >
        <ScrollView>
          <Text selectable style={styles.text}>
            {normalizeTerminalFrame(frame)}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 260,
    borderColor: "#263037",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#050708",
  },
  scroll: {
    flex: 1,
  },
  content: {
    minWidth: "100%",
  },
  text: {
    color: "#d7ffe9",
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 18,
    padding: 12,
    minWidth: 900,
  },
});
