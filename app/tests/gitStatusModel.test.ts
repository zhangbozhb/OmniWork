import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceGitStatus } from "@omni-work/protocol-ts";

import {
  getCachedDiff,
  getScopedStats,
  isFileInScope,
  parseDiffLines,
  shouldUseUntrackedFileContentFallback,
} from "../src/screens/workspaces/gitStatusModel.ts";
import { toGitDiffCacheKey } from "../src/features/workspaces/workspaceKeys.ts";
import { formatGitReviewNotes } from "../src/screens/workspaces/gitReviewNotes.ts";

type ChangedFile = WorkspaceGitStatus["files"][number];

const modifiedFile: ChangedFile = {
  path: "src/index.ts",
  status: "modified",
  staged: true,
  unstaged: true,
  indexStatus: "M",
  worktreeStatus: "M",
  additions: 7,
  deletions: 3,
  stagedAdditions: 2,
  stagedDeletions: 1,
  unstagedAdditions: 5,
  unstagedDeletions: 2,
};

test("git status model filters files and computes scope-specific stats", () => {
  assert.equal(isFileInScope(modifiedFile, "all"), true);
  assert.equal(isFileInScope(modifiedFile, "staged"), true);
  assert.equal(isFileInScope(modifiedFile, "unstaged"), true);
  assert.deepEqual(getScopedStats(modifiedFile, "staged"), {
    additions: 2,
    deletions: 1,
  });
  assert.deepEqual(getScopedStats(modifiedFile, "unstaged"), {
    additions: 5,
    deletions: 2,
  });
});

test("git status model selects a cache entry before the current fallback", () => {
  const cached = {
    workspacePath: "/workspace",
    relativePath: modifiedFile.path,
    scope: "staged" as const,
    diff: "cached",
  };
  const fallback = { ...cached, diff: "fallback" };

  assert.equal(
    getCachedDiff(
      { [toGitDiffCacheKey(modifiedFile.path, "staged")]: cached },
      fallback,
      modifiedFile,
      "staged",
    ),
    cached,
  );
  assert.equal(
    getCachedDiff({}, fallback, modifiedFile, "unstaged"),
    undefined,
  );
});

test("git status model parses diff lines and detects empty untracked diffs", () => {
  assert.deepEqual(
    parseDiffLines("@@ -1 +1 @@\n-old\n+new\n context").map(
      (line) => line.type,
    ),
    ["hunk", "delete", "add", "context"],
  );

  const untrackedFile: ChangedFile = {
    path: "new.txt",
    status: "untracked",
    staged: false,
    unstaged: true,
    indexStatus: "?",
    worktreeStatus: "?",
  };
  assert.equal(
    shouldUseUntrackedFileContentFallback(
      untrackedFile,
      {
        workspacePath: "/workspace",
        relativePath: "new.txt",
        scope: "untracked",
        diff: "",
      },
      "untracked",
    ),
    true,
  );
});

test("review notes are batched with their immutable diff anchors", () => {
  assert.equal(
    formatGitReviewNotes([
      {
        headSha: "abc123",
        path: "src/index.ts",
        scope: "unstaged",
        lineIndex: 4,
        line: "+unsafeCall();",
        body: "Handle the failure explicitly.",
      },
    ]),
    [
      "Please address the following review notes as one revision pass.",
      "Reviewed HEAD: abc123",
      "",
      "1. src/index.ts (diff line 5, unstaged)",
      "   Code: +unsafeCall();",
      "   Review: Handle the failure explicitly.",
      "",
      "Re-check the final diff after applying all notes.",
    ].join("\n"),
  );
});
