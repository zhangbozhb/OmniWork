import type { JSX } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import type { TerminalSession } from "@omni-work/protocol-ts";

import { Button, Card } from "../../ui/components";
import { styles } from "./styles";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function RenameSessionModal({
  session,
  renameTitle,
  t,
  onClose,
  onChangeTitle,
  onConfirm,
}: {
  session: TerminalSession | null;
  renameTitle: string;
  t: Translate;
  onClose(): void;
  onChangeTitle(title: string): void;
  onConfirm(): void;
}): JSX.Element {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={Boolean(session)}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalAvoidingView}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            Keyboard.dismiss();
            onClose();
          }}
        >
          <Pressable onPress={() => {}}>
            <Card style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {t("workspaces.modal.renameSession")}
              </Text>
              <TextInput
                value={renameTitle}
                onChangeText={onChangeTitle}
                autoCapitalize="sentences"
                autoCorrect
                maxLength={80}
                placeholder={t("workspaces.modal.sessionTitle")}
                placeholderTextColor="#66727c"
                style={styles.cwdInput}
              />
              <View style={styles.modalActions}>
                <Button
                  icon="close"
                  style={styles.modalSecondaryButton}
                  onPress={onClose}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={!renameTitle.trim()}
                  icon="save"
                  style={styles.modalPrimaryButton}
                  tone="primary"
                  onPress={onConfirm}
                >
                  {t("common.save")}
                </Button>
              </View>
            </Card>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
