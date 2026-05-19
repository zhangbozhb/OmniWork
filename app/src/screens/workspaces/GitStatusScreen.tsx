import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type {
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "../../../../packages/protocol-ts/src/index.ts";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";

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
              {(status?.files ?? []).map((file) => (
                <Pressable
                  key={file.path}
                  style={styles.fileRow}
                  onPress={() => onOpenDiff(file.path)}
                >
                  <Badge style={styles.statusBadge}>{file.status}</Badge>
                  <Text numberOfLines={1} style={styles.filePath}>
                    {file.path}
                  </Text>
                </Pressable>
              ))}
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
    gap: spacing.sm,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    backgroundColor: colors.surface,
  },
  statusBadge: {
    minWidth: 78,
  },
  filePath: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
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
