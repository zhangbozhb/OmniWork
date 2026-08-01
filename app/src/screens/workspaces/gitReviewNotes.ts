import type { GitDiffScope } from "@omni-work/protocol-ts";

export type GitReviewNote = {
  headSha?: string;
  path: string;
  scope: GitDiffScope;
  lineIndex: number;
  line: string;
  body: string;
};

export function formatGitReviewNotes(notes: readonly GitReviewNote[]): string {
  const headSha = notes[0]?.headSha;
  const lines = [
    "Please address the following review notes as one revision pass.",
    headSha ? `Reviewed HEAD: ${headSha}` : undefined,
    "",
    ...notes.flatMap((note, index) => [
      `${index + 1}. ${note.path} (diff line ${note.lineIndex + 1}, ${note.scope})`,
      `   Code: ${note.line}`,
      `   Review: ${note.body}`,
      "",
    ]),
    "Re-check the final diff after applying all notes.",
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
