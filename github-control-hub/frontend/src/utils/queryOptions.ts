/**
 * `entity` says what a query counts, because nothing else reliably does.
 *
 * It used to be inferred from whether the id began with "repos-", which is why
 * "repos-with-outside-admins" showed a share of the organization and
 * "unowned-repos" did not, though both return repositories. Reading it off the
 * returned rows fails too, an empty result has nothing to read. So it is
 * declared.
 */
/**
 * `paramIcon` is the icon on the *tags somebody types*, which is not the same
 * thing as the icon on the query.
 *
 * "Repos exposed through vulnerable package(s)" is a vulnerability question, so
 * it carries a package icon in the picker, and the things you type into it are
 * package names. But "Repos matching specific branch rules" carries a shield,
 * and the things you type into it are branch names. Using the query's own icon
 * for both puts a shield on a branch name.
 *
 * Only meaningful where `useTagInput` is set. Falls back to `icon`.
 */
export interface QueryOption {
  id: string;
  /** What the query counts. See the note above. */
  entity: "repository" | "user" | "team";
  label: string;
  icon: string;
  requiresParam: boolean;
  /** Excluded from the "problems found" totals: it answers rather than warns. */
  informational?: boolean;
  /** The form label. `paramNoun()` turns it into prose. */
  paramLabel?: string;
  paramDefault?: string;
  paramIcon?: string;
  useTagInput?: boolean;
  hasAdvancedRules?: boolean;
}

export const QUERY_OPTIONS: QueryOption[] = [
  { id: "repos-dependent-on", entity: "repository", informational: true, label: "Repos exposed through vulnerable package(s)...", requiresParam: true, paramLabel: "Package name(s)", icon: "ph-package", paramIcon: "ph-package", useTagInput: true },
  { id: "repos-with-outside-admins", entity: "repository", label: "Repos with admin users outside owning team", requiresParam: false, icon: "ph-user-focus" },
  { id: "highly-privileged-users", entity: "user", label: "Highly privileged users...", requiresParam: true, paramLabel: "Min. repos with write/admin access to flag a user", paramDefault: "5", icon: "ph-shield-star" },
  { id: "unowned-repos", entity: "repository", label: "Repos without an owning team", requiresParam: false, icon: "ph-ghost" },
  { id: "public-repos", entity: "repository", label: "Repos not private (public or internal)", requiresParam: false, icon: "ph-globe-hemisphere-west" },
  { id: "archived-repos-with-access", entity: "repository", label: "Archived repos people still have access to", requiresParam: false, icon: "ph-archive-box" },
  { id: "stale-repos", entity: "repository", label: "Repos with no push in N months...", requiresParam: true, paramLabel: "Months since the last push", paramDefault: "6", icon: "ph-clock-counter-clockwise" },
  { id: "repos-without-protection", entity: "repository", label: "Repos with no protected branch at all", requiresParam: false, icon: "ph-lock-open" },
  { id: "empty-teams", entity: "team", label: "Empty teams (no members)", requiresParam: false, icon: "ph-users-three" },
  { id: "repos-missing-branch", entity: "repository", label: "Repos missing specific branch(es)...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-git-branch", paramIcon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-unprotected-branch", entity: "repository", label: "Repos with an unprotected specific branch...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-shield-warning", paramIcon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-branch", entity: "repository", informational: true, label: "Repos that have specific branch(es)...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-git-branch", paramIcon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-branch-rules", entity: "repository", label: "Repos matching specific branch rules...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-shield-check", hasAdvancedRules: true, paramIcon: "ph-git-branch", useTagInput: true },
  { id: "stale-branch-protections", entity: "repository", label: "Stale Branch Protection Detector", requiresParam: false, icon: "ph-shield-warning" },
  { id: "protection-bypasses-ranking", entity: "repository", label: "Protection Rule Bypasses", requiresParam: false, icon: "ph-shield-slash" },
  { id: "dormant-privileged-users", entity: "user", label: "Dormant privileged access...", requiresParam: true, paramLabel: "Months without a commit to count as dormant", paramDefault: "6", icon: "ph-clock-countdown" }
];

/**
 * `paramLabel` read as a noun inside a sentence.
 *
 * The labels are written for a form field, where "Branch Name(s)" is right.
 * Dropped into a placeholder or an error it needs to be "branch name". Every
 * such string used to be hand-written per field, which is how the package
 * widget ended up asking for a branch name.
 */
export function paramNoun(label?: string): string {
  return (label ?? "value").replace(/\(s\)|\(es\)/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
}
