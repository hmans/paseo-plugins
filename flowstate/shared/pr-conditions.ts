export const prConditions = [
  "github.pr.exists", "github.pr.open", "github.pr.closed", "github.pr.merged", "github.pr.draft",
  "github.pr.mergeable", "github.pr.conflicting",
  "github.pr.checks.success", "github.pr.checks.pending", "github.pr.checks.failure", "github.pr.checks.none",
  "github.pr.review.approved", "github.pr.review.pending", "github.pr.review.changes_requested",
] as const;
