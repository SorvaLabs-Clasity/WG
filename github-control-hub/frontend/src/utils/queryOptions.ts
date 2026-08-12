/**
 * `entity` says what a query counts, because nothing else reliably does.
 *
 * It used to be inferred from whether the id began with "repos-", which is why
 * "repos-with-outside-admins" showed a share of the organisation and
 * "unowned-repos" did not, though both return repositories. Reading it off the
 * returned rows fails too — an empty result has nothing to read. So it is
 * declared.
 */
export const QUERY_OPTIONS = [
  { id: "repos-dependent-on", entity: "repository", informational: true, label: "Repos exposed through vulnerable package(s)...", requiresParam: true, paramLabel: "Package name(s)", icon: "ph-package", useTagInput: true },
  { id: "repos-with-outside-admins", entity: "repository", label: "Repos with admin users outside owning team", requiresParam: false, icon: "ph-user-focus" },
  { id: "highly-privileged-users", entity: "user", label: "Highly privileged users...", requiresParam: true, paramLabel: "Min. repos with write/admin access to flag a user", paramDefault: "5", icon: "ph-shield-star" },
  { id: "unowned-repos", entity: "repository", label: "Repos without an owning team", requiresParam: false, icon: "ph-ghost" },
  { id: "repos-with-critical-vulns", entity: "repository", label: "Repos with critical vulnerabilities", requiresParam: false, icon: "ph-warning-octagon" },
  { id: "empty-teams", entity: "team", label: "Empty teams (no members)", requiresParam: false, icon: "ph-users-three" },
  { id: "repos-missing-branch", entity: "repository", label: "Repos missing specific branch(es)...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-unprotected-branch", entity: "repository", label: "Repos with an unprotected specific branch...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-shield-warning", useTagInput: true },
  { id: "repos-with-branch", entity: "repository", informational: true, label: "Repos that have specific branch(es)...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-branch-rules", entity: "repository", label: "Repos matching specific branch rules...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-shield-check", hasAdvancedRules: true, useTagInput: true },
  { id: "stale-branch-protections", entity: "repository", label: "Stale Branch Protection Detector", requiresParam: false, icon: "ph-shield-warning" },
  { id: "dormant-privileged-users", entity: "user", label: "Dormant Privileged Access Detector", requiresParam: false, icon: "ph-clock-countdown" }
];
