import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type {
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "../../../../packages/protocol-ts/src/index.ts";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";

type FileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

const STATUS_COLOR: Record<FileStatus, string> = {
  modified: colors.warning,
  added: colors.success,
  deleted: colors.danger,
  renamed: "#7eb8f7",
  untracked: colors.textMuted,
};

const STATUS_ORDER: FileStatus[] = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
];

export interface GitStatusScreenProps {
  workspace: WorkspaceDefinition;
  status?: WorkspaceGitStatus;
  diff?: string;
  selectedPath?: string;
  loading?: boolean;
  embedded?: boolean;
  onBack?(): void;
  onRefresh(): void;
  onOpenDiff(relativePath?: string): void;
}

export function GitStatusScreen({
  workspace,
  status,
  diff,
  selectedPath,
  loading,
  embedded = false,
  onBack,
  onRefresh,
  onOpenDiff,
}: GitStatusScreenProps): JSX.Element {
  return (
    <View style={[styles.screen, embedded && styles.embeddedScreen]}>
      {!embedded ? (
      <View style={styles.toolbar}>
        <Button
          accessibilityLabel="Back to sessions"
          icon="arrowLeft"
          iconOnly
          style={styles.backButton}
          onPress={onBack ?? noop}
        >
          Back
        </Button>
        <View style={styles.titleArea}>
          <Text numberOfLines={1} style={styles.title}>
            {getWorkspaceDisplayName(workspace)} Git
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {workspace.gitRoot ?? workspace.path}
          </Text>
        </View>
        <Button
          accessibilityLabel="Refresh Git status"
          icon="refresh"
          iconOnly
          style={styles.iconButton}
          onPress={onRefresh}
        >
          Refresh
        </Button>
      </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.content}>
        {!workspace.isGitRepository ? (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>No Git repository</Text>
            <Text style={styles.meta}>
              Git tools only appear for workspaces inside a Git repository.
            </Text>
          </Card>
        ) : (
          <>
            <Card style={styles.card}>
              <View style={styles.summaryHeader}>
                <Text style={styles.cardTitle}>
                  {status?.branch ?? "Unknown branch"}
                </Text>
                <Badge
                  backgroundColor={
                    status?.hasChanges ? colors.warningSoft : colors.successSoft
                  }
                  color={status?.hasChanges ? colors.warning : colors.success}
                >
                  {status?.hasChanges ? "Changes" : "Clean"}
                </Badge>
              </View>
              <Text style={styles.meta}>
                {status?.headSha ? `HEAD ${status.headSha}` : "HEAD unknown"}
                {typeof status?.ahead === "number" ? ` · ahead ${status.ahead}` : ""}
                {typeof status?.behind === "number"
                  ? ` · behind ${status.behind}`
                  : ""}
              </Text>
              <Button
                icon="git"
                style={styles.fullDiffButton}
                onPress={() => onOpenDiff()}
              >
                View workspace diff
              </Button>
            </Card>

            <View style={styles.fileStack}>
              {status && status.files.length > 0
                ? STATUS_ORDER.filter((s) =>
                    status.files.some((f) => f.status === s),
                  ).map((groupStatus) => {
                    const groupFiles = status.files.filter(
                      (f) => f.status === groupStatus,
                    );
                    const groupColor = STATUS_COLOR[groupStatus];
                    return (
                      <View key={groupStatus} style={styles.fileGroup}>
                        <View style={styles.groupHeader}>
                          <View
                            style={[
                              styles.groupDot,
                              { backgroundColor: groupColor },
                            ]}
                          />
                          <Text
                            style={[styles.groupLabel, { color: groupColor }]}
                          >
                            {groupStatus}
                          </Text>
                          <Text style={styles.groupCount}>
                            {groupFiles.length}
                          </Text>
                        </View>
                        {groupFiles.map((file) => (
                          <Pressable
                            key={file.path}
                            style={styles.fileRow}
                            onPress={() => onOpenDiff(file.path)}
                          >
                            <View
                              style={[
                                styles.fileIndicator,
                                { backgroundColor: groupColor },
                              ]}
                            />
                            <Text
                              numberOfLines={1}
                              style={[styles.filePath, { color: groupColor }]}
                            >
                              {file.path}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    );
                  })
                : null}
              {status && status.files.length === 0 ? (
                <Text style={styles.empty}>No changed files.</Text>
              ) : null}
              {!status && loading ? (
                <Text style={styles.empty}>Loading Git status...</Text>
              ) : null}
            </View>

            {typeof diff === "string" ? (
              <Card style={styles.diffCard}>
                <Text numberOfLines={1} style={styles.cardTitle}>
                  {selectedPath ?? "Workspace diff"}
                </Text>
                <Text selectable style={styles.diffText}>
                  {diff || "No diff."}
                </Text>
              </Card>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function noop(): void {}

function getWorkspaceDisplayName(workspace: WorkspaceDefinition): string {
  const normalized = workspace.path.replace(/\/+$/g, "");
  const fallback = normalized.split("/").filter(Boolean).at(-1) ?? "Workspace";
  return workspace.name?.trim() || fallback;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: spacing.xl,
  },
  embeddedScreen: {
    padding: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  backButton: {
    width: 40,
    minHeight: 40,
    paddingHorizontal: 0,
    borderRadius: 20,
  },
  iconButton: {
    width: 42,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  titleArea: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  card: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  cardTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 16,
    fontWeight: "800",
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  fullDiffButton: {
    minHeight: 40,
  },
  fileStack: {
    gap: spacing.lg,
  },
  fileGroup: {
    gap: 0,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceRaised,
  },
  groupDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  groupLabel: {
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  groupCount: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 40,
    paddingRight: spacing.lg,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fileIndicator: {
    width: 3,
    alignSelf: "stretch",
  },
  filePath: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: "Menlo",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  empty: {
    color: colors.textMuted,
    padding: spacing.lg,
  },
  diffCard: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  diffText: {
    color: colors.textSecondary,
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 17,
  },
});
