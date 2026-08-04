import type { GithubSyncConflict, GithubSyncResolutionChoice } from "@fastwrite/shared";

export type PendingGithubSyncResolution = {
  choice: GithubSyncResolutionChoice | "";
  content: string;
};

export function createPendingResolutions(conflicts: GithubSyncConflict[]): Record<string, PendingGithubSyncResolution> {
  return Object.fromEntries(conflicts.map((conflict) => [
    conflict.path,
    { choice: "", content: conflict.fastwriteContent ?? "" }
  ]));
}

export function keepConflictSide(
  conflict: GithubSyncConflict,
  current: PendingGithubSyncResolution,
  choice: "fastwrite" | "github"
): PendingGithubSyncResolution {
  if (conflict.kind !== "text") return { ...current, choice };
  return {
    choice,
    content: choice === "fastwrite" ? conflict.fastwriteContent ?? "" : conflict.githubContent ?? ""
  };
}

export function editTextResolution(
  current: PendingGithubSyncResolution,
  content: string
): PendingGithubSyncResolution {
  return { ...current, choice: "edited", content };
}
