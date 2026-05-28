import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal, StyleSheet, Text, View } from "react-native";

import { Button, Card } from "../components";
import type { IconName } from "../icons";
import { colors, radii, spacing } from "../theme";

export type ConfirmTone = "primary" | "danger";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  tone?: ConfirmTone;
  /**
   * 可选：自定义确认按钮图标。缺省时按 `tone` 推断（primary→check / danger→trash）。
   * 不同业务场景（如切换 Strict P2P 用 `plug`、回滚配置用 `refresh`）可在此覆盖。
   */
  confirmIcon?: IconName;
  /**
   * 可选：自定义取消按钮图标。缺省 `close`。
   */
  cancelIcon?: IconName;
}

type PendingConfirm = Required<
  Omit<ConfirmOptions, "confirmIcon" | "cancelIcon">
> &
  Pick<ConfirmOptions, "confirmIcon" | "cancelIcon">;

type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    resolverRef.current?.(false);
    setPendingConfirm({
      ...options,
      cancelText: options.cancelText ?? "Cancel",
      tone: options.tone ?? "danger",
    });

    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const contextValue = useMemo(() => confirm, [confirm]);

  function resolve(confirmed: boolean): void {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setPendingConfirm(null);
  }

  return (
    <ConfirmContext.Provider value={contextValue}>
      {children}
      <Modal
        transparent
        animationType="fade"
        visible={Boolean(pendingConfirm)}
        onRequestClose={() => resolve(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.dialog}>
            <Card elevated style={styles.card}>
              <View style={styles.header}>
                <Text style={styles.title}>{pendingConfirm?.title}</Text>
                <Text style={styles.message}>{pendingConfirm?.message}</Text>
              </View>
              <View style={styles.actions}>
                <Button
                  icon={pendingConfirm?.cancelIcon ?? "close"}
                  style={styles.actionButton}
                  onPress={() => resolve(false)}
                >
                  {pendingConfirm?.cancelText ?? "Cancel"}
                </Button>
                <Button
                  icon={
                    pendingConfirm?.confirmIcon ??
                    (pendingConfirm?.tone === "primary" ? "check" : "trash")
                  }
                  style={styles.actionButton}
                  tone={
                    pendingConfirm?.tone === "primary" ? "primary" : "danger"
                  }
                  onPress={() => resolve(true)}
                >
                  {pendingConfirm?.confirmText ?? "Confirm"}
                </Button>
              </View>
            </Card>
          </View>
        </View>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used within ConfirmProvider");
  }
  return confirm;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: "rgba(0, 0, 0, 0.64)",
  },
  dialog: {
    width: "100%",
    maxWidth: 420,
  },
  card: {
    padding: spacing.xl,
    gap: spacing.xl,
    borderColor: colors.borderSubtle,
    borderRadius: radii.lg,
  },
  header: {
    gap: spacing.sm,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  message: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
  },
  actionButton: {
    flex: 1,
    minHeight: 44,
  },
});
