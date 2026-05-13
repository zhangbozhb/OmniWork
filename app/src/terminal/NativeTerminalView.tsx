import type { JSX } from "react";
import { useCallback, useRef, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { TerminalSize } from "../../../packages/protocol-ts/src/index.ts";
import type { TerminalLayout } from "../features/terminal/terminalLayout";
import { normalizeTerminalFrame } from "./terminalText";

export interface NativeTerminalViewProps {
  frame: string;
  layout: TerminalLayout;
  terminalSize: TerminalSize;
}

export function NativeTerminalView({
  frame,
  layout,
  terminalSize,
}: NativeTerminalViewProps): JSX.Element {
  const verticalScrollRef = useRef<ScrollView>(null);
  const followOutputRef = useRef(true);
  const [followOutput, setFollowOutput] = useState(true);
  const terminalContentWidth =
    terminalSize.cols * layout.cellWidth + TERMINAL_TEXT_PADDING * 2;

  const scrollToBottom = useCallback((animated: boolean) => {
    requestAnimationFrame(() => {
      verticalScrollRef.current?.scrollToEnd({ animated });
    });
  }, []);

  const followLatestOutput = useCallback(() => {
    followOutputRef.current = true;
    setFollowOutput(true);
    scrollToBottom(true);
  }, [scrollToBottom]);

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const nextFollowOutput = distanceFromBottom < 72;
    followOutputRef.current = nextFollowOutput;
    setFollowOutput(nextFollowOutput);
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        horizontal
        keyboardDismissMode="none"
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled
      >
        <ScrollView
          ref={verticalScrollRef}
          keyboardDismissMode="none"
          keyboardShouldPersistTaps="always"
          onContentSizeChange={() => {
            if (followOutputRef.current) {
              scrollToBottom(false);
            }
          }}
          onLayout={() => {
            if (followOutputRef.current) {
              scrollToBottom(false);
            }
          }}
          onScroll={handleScroll}
          scrollEventThrottle={80}
        >
          <Text
            selectable
            style={[
              styles.text,
              {
                fontSize: layout.fontSize,
                lineHeight: layout.lineHeight,
                minWidth: terminalContentWidth,
              },
            ]}
          >
            {normalizeTerminalFrame(frame)}
          </Text>
        </ScrollView>
      </ScrollView>
      {!followOutput ? (
        <Pressable style={styles.jumpButton} onPress={followLatestOutput}>
          <Text style={styles.jumpButtonText}>Jump to latest</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const TERMINAL_TEXT_PADDING = 12;

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
    padding: TERMINAL_TEXT_PADDING,
  },
  jumpButton: {
    position: "absolute",
    right: 10,
    bottom: 10,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 34,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#30c48d",
  },
  jumpButtonText: {
    color: "#08110d",
    fontSize: 12,
    fontWeight: "800",
  },
});
