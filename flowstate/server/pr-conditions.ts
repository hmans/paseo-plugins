import type { ConditionResult } from "../shared/workflow";

// Structural subset of Paseo's workspace.githubRuntime; optional SDK fields
// must remain unknown rather than accidentally enabling an action.
export type PullRequestRuntime = {
  featuresEnabled?: boolean;
  error?: { message: string } | null;
  pullRequest?: {
    state: string;
    isMerged: boolean;
    isDraft?: boolean;
    mergeable?: "UNKNOWN" | "MERGEABLE" | "CONFLICTING";
    checksStatus?: "success" | "pending" | "failure" | "none";
    reviewDecision?: "approved" | "pending" | "changes_requested" | null;
  } | null;
} | null | undefined;

export function evaluatePullRequest(name: string, runtime: PullRequestRuntime): ConditionResult {
  const unknown = (message: string): ConditionResult => ({ value: "unknown", message });
  const value = (v: boolean): ConditionResult => ({ value: v ? "true" : "false" });
  if (!runtime || runtime.featuresEnabled === false || runtime.error) return unknown("Workspace GitHub data is unavailable or failed to refresh.");
  const pr = runtime.pullRequest;
  if (pr === undefined) return unknown("The workspace's attached pull request has not been loaded.");
  if (pr === null) return value(false);
  if (name === "github.pr.exists") return value(true);
  if (name === "github.pr.merged") return value(pr.isMerged);
  if (name === "github.pr.open") return value(pr.state.toUpperCase() === "OPEN" && !pr.isMerged);
  if (name === "github.pr.closed") return value(pr.state.toUpperCase() === "CLOSED" && !pr.isMerged);
  if (name === "github.pr.draft") return pr.isDraft === undefined ? unknown("PR draft status is unavailable.") : value(pr.isDraft);
  if (name === "github.pr.mergeable" || name === "github.pr.conflicting") {
    if (!pr.mergeable || pr.mergeable === "UNKNOWN") return unknown("GitHub has not determined whether the PR has merge conflicts.");
    return value(pr.mergeable === (name === "github.pr.mergeable" ? "MERGEABLE" : "CONFLICTING"));
  }
  if (name.startsWith("github.pr.checks.")) {
    return pr.checksStatus === undefined ? unknown("PR check status is unavailable.") : value(pr.checksStatus === name.slice("github.pr.checks.".length));
  }
  if (name.startsWith("github.pr.review.")) {
    return pr.reviewDecision == null ? unknown("PR review decision is unavailable.") : value(pr.reviewDecision === name.slice("github.pr.review.".length));
  }
  return unknown(`Unknown condition: ${name}.`);
}
