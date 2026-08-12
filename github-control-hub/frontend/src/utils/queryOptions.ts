export const QUERY_OPTIONS = [
  { id: "repos-dependent-on", informational: true, label: "Repos exposed through a vulnerable package...", requiresParam: true, paramLabel: "Package name (e.g. lodash)", icon: "ph-package" },
  { id: "repos-with-outside-admins", label: "Repos with admin users outside owning team", requiresParam: false, icon: "ph-user-focus" },
  { id: "highly-privileged-users", label: "Highly privileged users...", requiresParam: true, paramLabel: "Min. repos with write/admin access to flag a user", paramDefault: "5", icon: "ph-shield-star" },
  { id: "unowned-repos", label: "Repos without an owning team", requiresParam: false, icon: "ph-ghost" },
  { id: "repos-with-critical-vulns", label: "Repos with critical vulnerabilities", requiresParam: false, icon: "ph-warning-octagon" },
  { id: "empty-teams", label: "Empty teams (no members)", requiresParam: false, icon: "ph-users-three" },
  { id: "repos-missing-branch", label: "Repos missing specific branch(es)...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-unprotected-branch", label: "Repos with an unprotected specific branch...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-shield-warning", useTagInput: true },
  { id: "repos-with-branch", informational: true, label: "Repos that have specific branch(es)...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-git-branch", useTagInput: true },
  { id: "repos-with-branch-rules", label: "Repos matching specific branch rules...", requiresParam: true, paramLabel: "Branch Name(s)", icon: "ph-shield-check", hasAdvancedRules: true, useTagInput: true },
  { id: "stale-branch-protections", label: "Stale Branch Protection Detector", requiresParam: false, icon: "ph-shield-warning" },
  { id: "dormant-privileged-users", label: "Dormant Privileged Access Detector", requiresParam: false, icon: "ph-clock-countdown" }
];
