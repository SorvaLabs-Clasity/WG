/**
 * The important events, named.
 *
 * These are the rows the Activity feed shows with an "important" badge: the
 * ones that also raised an alert and may have been emailed. A repository going
 * public, access being granted, branch protection disappearing.
 *
 * They all share one action, `security.alert`, which is how they are found and
 * filtered. What they do not share is what happened, and the feed used to show
 * every one of them as "Security Alert", the name of the drawer rather than
 * the name of the thing in it.
 *
 * Kept in step with TYPE_LABELS in components/ImportantEvents.tsx, which labels
 * the same events on the dashboard. Two lists that name the same things must
 * agree; repro-securitydashboard.ts checks that they do.
 */
export const IMPORTANT_KINDS: { id: string; label: string }[] = [
  { id: "repo_made_public", label: "Repository made public" },
  { id: "protection_removed", label: "Protection removed" },
  { id: "ruleset_disabled", label: "Ruleset disabled" },
  { id: "protection_drift", label: "Protection drift" },
  { id: "admin_added", label: "Admin access granted" },
  { id: "user_promoted", label: "User promoted to admin" },
  { id: "team_elevated", label: "Team permissions elevated" },
  { id: "team_added", label: "Team added to repo" },
  { id: "team_removed", label: "Team removed from repo" },
  { id: "team_permission_changed", label: "Team permission changed" },
  { id: "suspicious_activity", label: "Suspicious activity" },
];

const BY_ID = new Map(IMPORTANT_KINDS.map(k => [k.id, k.label]));

/**
 * What to call one of these rows.
 *
 * Rows written before the kind was recorded have none, and fall back to the
 * old generic label. That is the honest answer for them: the row genuinely
 * does not say which event it was, and guessing from its prose would be a
 * guess presented as a fact.
 */
export function importantLabel(kind?: string): string {
  return (kind && BY_ID.get(kind)) || "Security event";
}
