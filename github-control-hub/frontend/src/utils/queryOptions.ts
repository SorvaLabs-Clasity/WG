export const QUERY_OPTIONS = [
  { id: "repos-dependent-on", label: "Repos dependent on library...", requiresParam: true, paramLabel: "Library Name", icon: "ph-package" },
  { id: "repos-deploying-to-prod", label: "Repos deploying to production", requiresParam: false, icon: "ph-rocket-launch" },
  { id: "repos-with-outside-admins", label: "Repos with admin users outside owning team", requiresParam: false, icon: "ph-user-focus" },
  { id: "highly-privileged-users", label: "Highly privileged users...", requiresParam: true, paramLabel: "Threshold (e.g. 5)", paramDefault: "5", icon: "ph-shield-star" },
  { id: "unowned-repos", label: "Repos without an owning team", requiresParam: false, icon: "ph-ghost" },
  { id: "repos-with-critical-vulns", label: "Repos with critical vulnerabilities", requiresParam: false, icon: "ph-warning-octagon" },
  { id: "empty-teams", label: "Empty teams (no members)", requiresParam: false, icon: "ph-users-three" },
  { id: "repos-missing-branch", label: "Repos missing a specific branch...", requiresParam: true, paramLabel: "Branch Name (e.g. main)", icon: "ph-git-branch" },
  { id: "repos-with-unprotected-branch", label: "Repos with an unprotected specific branch...", requiresParam: true, paramLabel: "Branch Name", icon: "ph-shield-warning" },
  { id: "repos-with-branch", label: "Repos that have a specific branch...", requiresParam: true, paramLabel: "Branch Name", icon: "ph-git-branch" },
  { id: "repos-with-branch-rules", label: "Repos matching specific branch rules...", requiresParam: true, paramLabel: "Branch Name", icon: "ph-shield-check", hasAdvancedRules: true },
  { id: "stale-branch-protections", label: "Stale Branch Protection Detector", requiresParam: false, icon: "ph-shield-warning" },
  { id: "users-without-mfa", label: "Non-MFA User Exposure Scanner", requiresParam: false, icon: "ph-key" },
  { id: "dormant-privileged-users", label: "Dormant Privileged Access Detector", requiresParam: false, icon: "ph-clock-countdown" }
];
