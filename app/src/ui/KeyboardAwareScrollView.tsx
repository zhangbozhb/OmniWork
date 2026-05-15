import type { JSX, ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type ScrollViewProps,
} from "react-native";

export interface KeyboardAwareScrollViewProps
  extends Omit<ScrollViewProps, "contentContainerStyle"> {
  children: ReactNode;
  contentContainerStyle?: ScrollViewProps["contentContainerStyle"];
  keyboardVerticalOffset?: number;
}

export function KeyboardAwareScrollView({
  children,
  contentContainerStyle,
  keyboardVerticalOffset = 0,
  keyboardDismissMode = Platform.OS === "ios" ? "interactive" : "on-drag",
  keyboardShouldPersistTaps = "handled",
  onStartShouldSetResponderCapture,
  ...scrollViewProps
}: KeyboardAwareScrollViewProps): JSX.Element {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={keyboardVerticalOffset}
      style={styles.container}
    >
      <ScrollView
        {...scrollViewProps}
        contentContainerStyle={contentContainerStyle}
        keyboardDismissMode={keyboardDismissMode}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        onStartShouldSetResponderCapture={(event) => {
          Keyboard.dismiss();
          return onStartShouldSetResponderCapture?.(event) ?? false;
        }}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
