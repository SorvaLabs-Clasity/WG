import type { Repo } from "../types/Repo";
import type { Branch } from "../types/Branch";
import type { Activity } from "../types/Activity";
import type { RepoTemplate, BranchRule } from "../types/Template";
import type { Scanner, ScanResult } from "../types/Scanner";
import type { SecurityAlert } from "../types/Alert";
import type { RepoComplianceScore } from "../types/Compliance";
import type { DependencyAlert, DependencySummary } from "../types/Dependabot";

export const DEMO_USER = {
  login: "demo-user",
  avatarUrl: "https://i.pravatar.cc/150?u=demo",
};

const MOCK_REPOS: Repo[] = [
  {
    name: "web-platform",
    full_name: "acme-org/web-platform",
    private: false,
    default_branch: "main",
    description: "Core web application platform powering the customer dashboard",
    language: "TypeScript",
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "api-gateway",
    full_name: "acme-org/api-gateway",
    private: true,
    default_branch: "main",
    description: "Central API gateway handling routing, auth, and rate limiting",
    language: "Go",
    updated_at: "2026-03-07T14:20:00Z",
  },
  {
    name: "design-system",
    full_name: "acme-org/design-system",
    private: false,
    default_branch: "main",
    description: "Shared component library and design tokens",
    language: "TypeScript",
    updated_at: "2026-03-06T09:15:00Z",
  },
  {
    name: "ml-pipeline",
    full_name: "acme-org/ml-pipeline",
    private: true,
    default_branch: "develop",
    description: "Machine learning data pipeline and model training infrastructure",
    language: "Python",
    updated_at: "2026-03-05T22:45:00Z",
  },
  {
    name: "mobile-app",
    full_name: "acme-org/mobile-app",
    private: true,
    default_branch: "main",
    description: "Cross-platform mobile application built with React Native",
    language: "TypeScript",
    updated_at: "2026-03-04T11:00:00Z",
  },
  {
    name: "infrastructure",
    full_name: "acme-org/infrastructure",
    private: true,
    default_branch: "main",
    description: "Terraform modules, Kubernetes manifests, and CI/CD pipelines",
    language: "HCL",
    updated_at: "2026-03-03T16:30:00Z",
  },
  {
    name: "docs",
    full_name: "acme-org/docs",
    private: false,
    default_branch: "main",
    description: "Public-facing developer documentation and API reference",
    language: "MDX",
    updated_at: "2026-03-02T08:00:00Z",
  },
  {
    name: "analytics-service",
    full_name: "acme-org/analytics-service",
    private: true,
    default_branch: "main",
    description: "Event ingestion and analytics processing microservice",
    language: "Java",
    updated_at: "2026-03-01T13:20:00Z",
  },
  {
    name: "auth-service",
    full_name: "acme-org/auth-service",
    private: true,
    default_branch: "main",
    description: "OAuth2 / OIDC authentication and authorization service",
    language: "Rust",
    updated_at: "2026-02-28T19:45:00Z",
  },
];

const MOCK_BRANCHES: Record<string, Branch[]> = {
  "web-platform": [
    { name: "main", protected: true, sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
    { name: "develop", protected: true, sha: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1" },
    { name: "feature/dark-mode", protected: false, sha: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2" },
    { name: "feature/dashboard-v2", protected: false, sha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3" },
    { name: "bugfix/auth-redirect", protected: false, sha: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4" },
  ],
  "api-gateway": [
    { name: "main", protected: true, sha: "f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5" },
    { name: "feature/rate-limiter", protected: false, sha: "a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6" },
    { name: "feature/grpc-support", protected: false, sha: "b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7" },
  ],
  "design-system": [
    { name: "main", protected: true, sha: "c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8" },
    { name: "feature/new-tokens", protected: false, sha: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9" },
  ],
  "ml-pipeline": [
    { name: "develop", protected: true, sha: "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0" },
    { name: "main", protected: true, sha: "f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1" },
    { name: "experiment/transformer-v3", protected: false, sha: "a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
  ],
};

function delay(ms = 400): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function mockFetchRepos(): Promise<Repo[]> {
  await delay();
  return MOCK_REPOS;
}

export async function mockFetchBranches(repo: string): Promise<Branch[]> {
  await delay(300);
  return MOCK_BRANCHES[repo] ?? [
    { name: "main", protected: true, sha: "abcdef1234567890abcdef1234567890abcdef12" },
    { name: "develop", protected: false, sha: "1234567890abcdef1234567890abcdef12345678" },
  ];
}

export async function mockCreateBranch(
  _repo: string,
  branchName: string,
  _baseBranch: string
): Promise<{ message: string }> {
  await delay(500);
  mockActivityLog.unshift({
    id: crypto.randomUUID(),
    source: "app",
    action: "branch.create",
    actor: DEMO_USER.login,
    repo: _repo,
    target: branchName,
    details: `Created from ${_baseBranch}`,
    timestamp: new Date().toISOString(),
  });
  return { message: `Branch "${branchName}" created (demo)` };
}

export async function mockDeleteBranch(
  _repo: string,
  branch: string
): Promise<{ message: string }> {
  await delay(500);
  mockActivityLog.unshift({
    id: crypto.randomUUID(),
    source: "app",
    action: "branch.delete",
    actor: DEMO_USER.login,
    repo: _repo,
    target: branch,
    timestamp: new Date().toISOString(),
  });
  return { message: `Branch "${branch}" deleted (demo)` };
}

export async function mockProtectBranch(
  _repo: string,
  branch: string,
  protection: NonNullable<import("../types/Template").BranchRule["protection"]>
): Promise<{ message: string }> {
  await delay(500);
  mockActivityLog.unshift({
    id: crypto.randomUUID(),
    source: "app",
    action: "branch.protect",
    actor: DEMO_USER.login,
    repo: _repo,
    target: branch,
    details: "Applied protection rules",
    diff: { protection: { old: null, new: protection } },
    timestamp: new Date().toISOString(),
  });
  return { message: `Protection applied to "${branch}" (demo)` };
}

// ── Scanner mock data ────────────────────────────────────────────

let mockScanners: Scanner[] = [
  {
    id: "s1",
    name: "Standard Org Compliance",
    description: "Ensures main and uat branches exist and are protected via Rulesets with PRs required.",
    targetRepos: "all",
    includeFutureRepos: true,
    createdAt: "2026-03-08T10:00:00Z",
    updatedAt: "2026-03-08T10:00:00Z",
    lastRunAt: "2026-03-09T08:00:00Z",
    conditions: [
      {
        branchPatterns: ["main"],
        requiresProtection: true,
        protectionType: "ruleset",
        rules: { requirePr: true, minApprovals: 2, requireStatusChecks: true }
      },
      {
        branchPatterns: ["uat"],
        requiresProtection: true,
        protectionType: "ruleset",
        rules: { requirePr: true, minApprovals: 1 }
      }
    ]
  }
];

let mockScanResults: Map<string, ScanResult> = new Map([
  ["s1", {
    scannerId: "s1",
    runAt: "2026-03-09T08:00:00Z",
    totalScanned: MOCK_REPOS.length,
    compliantCount: 2,
    nonCompliantCount: MOCK_REPOS.length - 2,
    violations: [
      { repo: "web-platform", branch: "uat", reason: "Required branch does not exist" },
      { repo: "api-gateway", branch: "main", reason: "Branch lacks Repository Ruleset (has Classic instead)" },
      { repo: "design-system", branch: "main", reason: "Ruleset requires 1 approvals, expected >= 2" }
    ]
  }]
]);

export async function mockFetchScanners(): Promise<Scanner[]> {
  await delay(300);
  return [...mockScanners];
}

export async function mockCreateScanner(data: Omit<Scanner, "id" | "createdAt" | "updatedAt">): Promise<Scanner> {
  await delay(500);
  const scanner: Scanner = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockScanners = [scanner, ...mockScanners];
  return scanner;
}

export async function mockUpdateScanner(id: string, data: Partial<Omit<Scanner, "id" | "createdAt" | "updatedAt">>): Promise<Scanner> {
  await delay(400);
  const idx = mockScanners.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error("Scanner not found");
  mockScanners[idx] = { ...mockScanners[idx], ...data, updatedAt: new Date().toISOString() };
  return mockScanners[idx];
}

export async function mockDeleteScanner(id: string): Promise<{ message: string }> {
  await delay(400);
  mockScanners = mockScanners.filter((s) => s.id !== id);
  mockScanResults.delete(id);
  return { message: "Scanner deleted" };
}

export async function mockGetScanResult(id: string): Promise<ScanResult> {
  await delay(300);
  const result = mockScanResults.get(id);
  if (!result) throw new Error("Result not found");
  return result;
}

export async function mockRunScan(id: string): Promise<ScanResult> {
  await delay(1000);
  const scanner = mockScanners.find(s => s.id === id);
  if (!scanner) throw new Error("Scanner not found");

  const runAt = new Date().toISOString();
  scanner.lastRunAt = runAt;

  // Generate fake result
  const totalScanned = scanner.targetRepos === "all" ? MOCK_REPOS.length : scanner.targetRepos.length;
  const compliantCount = Math.floor(Math.random() * totalScanned);
  
  const result: ScanResult = {
    scannerId: id,
    runAt,
    totalScanned,
    compliantCount,
    nonCompliantCount: totalScanned - compliantCount,
    violations: [
      { repo: "random-repo", branch: "main", reason: "Simulated violation" }
    ]
  };

  mockScanResults.set(id, result);
  return result;
}


const mockActivityLog: Activity[] = [
  {
    id: "a1",
    source: "app",
    action: "branch.create",
    actor: "alice",
    repo: "web-platform",
    target: "feature/dark-mode",
    details: "Created from main",
    timestamp: "2026-03-09T09:12:00Z",
  },
  {
    id: "a2",
    source: "app",
    action: "branch.protect",
    actor: "bob",
    repo: "web-platform",
    target: "main",
    details: "Applied default protection rules",
    timestamp: "2026-03-09T08:45:00Z",
  },
  {
    id: "a3",
    source: "app",
    action: "branch.delete",
    actor: "alice",
    repo: "api-gateway",
    target: "hotfix/old-fix",
    timestamp: "2026-03-08T17:30:00Z",
  },
  {
    id: "a4",
    source: "app",
    action: "template.apply",
    actor: "carol",
    repo: "design-system",
    target: "Standard Branch Setup",
    details: 'Applied template "Standard Branch Setup" — created: [dev, uat], protected: [main, uat]',
    timestamp: "2026-03-08T14:20:00Z",
  },
  {
    id: "a5",
    source: "app",
    action: "branch.create",
    actor: "dave",
    repo: "ml-pipeline",
    target: "experiment/transformer-v3",
    details: "Created from develop",
    timestamp: "2026-03-08T11:05:00Z",
  },
  {
    id: "a6",
    source: "app",
    action: "template.create",
    actor: "alice",
    repo: "*",
    target: "Standard Branch Setup",
    details: 'Created template "Standard Branch Setup"',
    timestamp: "2026-03-07T16:00:00Z",
  },
  {
    id: "a7",
    source: "app",
    action: "branch.protect",
    actor: "bob",
    repo: "api-gateway",
    target: "main",
    details: "Applied default protection rules",
    timestamp: "2026-03-07T10:30:00Z",
  },
  {
    id: "a8",
    source: "app",
    action: "branch.create",
    actor: "carol",
    repo: "api-gateway",
    target: "feature/rate-limiter",
    details: "Created from main",
    timestamp: "2026-03-06T15:45:00Z",
  },
  {
    id: "a9",
    source: "app",
    action: "branch.create",
    actor: "dave",
    repo: "mobile-app",
    target: "feature/push-notifications",
    details: "Created from main",
    timestamp: "2026-03-06T09:20:00Z",
  },
  {
    id: "a10",
    source: "app",
    action: "branch.protect",
    actor: "alice",
    repo: "ml-pipeline",
    target: "develop",
    details: "Applied default protection rules",
    timestamp: "2026-03-05T18:10:00Z",
  },
  {
    id: "g1",
    source: "github",
    action: "github.pr_opened",
    actor: "bob",
    repo: "web-platform",
    target: "feature/dark-mode",
    details: "Opened PR #42: Add dark mode toggle",
    prNumber: 42,
    timestamp: "2026-03-09T10:05:00Z",
  },
  {
    id: "g2",
    source: "github",
    action: "github.push",
    actor: "alice",
    repo: "web-platform",
    target: "main",
    details: "Pushed 3 commits to main",
    commitSha: "a1b2c3d",
    timestamp: "2026-03-09T09:50:00Z",
  },
  {
    id: "g3",
    source: "github",
    action: "github.pr_merged",
    actor: "carol",
    repo: "api-gateway",
    target: "main",
    details: "Merged PR #18: Fix rate limiting bug",
    prNumber: 18,
    timestamp: "2026-03-08T16:10:00Z",
  },
  {
    id: "g4",
    source: "github",
    action: "github.issue_opened",
    actor: "dave",
    repo: "design-system",
    target: "Button Component",
    details: "Opened Issue #5: Button has wrong padding on mobile",
    timestamp: "2026-03-07T11:20:00Z",
  },
];

export async function mockFetchActivity(
  limit = 50,
  offset = 0,
  repo?: string
): Promise<{ entries: Activity[]; total: number }> {
  await delay(300);
  const filtered = repo
    ? mockActivityLog.filter((e) => e.repo === repo)
    : mockActivityLog;
  return {
    entries: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

// ── Template mock data ───────────────────────────────────────────

let mockTemplateStore: RepoTemplate[] = [
  {
    id: "t1",
    name: "Standard Branch Setup",
    description: "Creates main, uat, and dev branches with standard protection on main and uat",
    branches: [
      {
        branchNames: ["main", "uat"],
        protection: {
          type: "ruleset",
          requirePr: true,
          requiredApprovals: 2,
          dismissStaleReviews: true,
          requireCodeOwnerReviews: false,
          requireConversationResolution: false,
          requireStatusChecks: true,
          strictStatusChecks: true,
          requireSignedCommits: false,
          requireLinearHistory: false,
          enforceAdmins: true,
          preventForcePush: true,
          preventDeletion: true,
        },
      },
      {
        branchNames: ["dev"],
        protection: null,
      },
    ],
    autoApplyOnNewRepo: true,
    createdBy: "alice",
    createdAt: "2026-03-07T16:00:00Z",
    updatedAt: "2026-03-07T16:00:00Z",
  },
  {
    id: "t2",
    name: "Minimal Protected Main",
    description: "Only ensures main branch exists with basic PR requirement",
    branches: [
      {
        branchNames: ["main"],
        protection: {
          type: "classic",
          requirePr: true,
          requiredApprovals: 1,
          dismissStaleReviews: false,
          requireCodeOwnerReviews: false,
          requireConversationResolution: false,
          requireStatusChecks: true,
          strictStatusChecks: true,
          requireSignedCommits: false,
          requireLinearHistory: false,
          enforceAdmins: true,
          preventForcePush: true,
          preventDeletion: true,
        },
      },
    ],
    autoApplyOnNewRepo: false,
    createdBy: "bob",
    createdAt: "2026-03-05T10:00:00Z",
    updatedAt: "2026-03-05T10:00:00Z",
  },
];

export async function mockFetchTemplates(): Promise<RepoTemplate[]> {
  await delay(300);
  return [...mockTemplateStore];
}

export async function mockCreateTemplate(
  data: { name: string; description: string; branches: BranchRule[]; autoApplyOnNewRepo: boolean }
): Promise<RepoTemplate> {
  await delay(500);
  const template: RepoTemplate = {
    ...data,
    id: crypto.randomUUID(),
    createdBy: DEMO_USER.login,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockTemplateStore = [template, ...mockTemplateStore];
  mockActivityLog.unshift({
    id: crypto.randomUUID(),
    source: "app",
    action: "template.create",
    actor: DEMO_USER.login,
    repo: "*",
    target: template.name,
    details: `Created template "${template.name}"`,
    timestamp: new Date().toISOString(),
  });
  return template;
}

export async function mockUpdateTemplate(
  id: string,
  data: Partial<{ name: string; description: string; branches: BranchRule[]; autoApplyOnNewRepo: boolean }>
): Promise<RepoTemplate> {
  await delay(400);
  const idx = mockTemplateStore.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error("Template not found");
  
  const existing = mockTemplateStore[idx];
  mockTemplateStore[idx] = { ...existing, ...data, updatedAt: new Date().toISOString() };
  
  const diff: Record<string, { old: any; new: any }> = {};
  if (data.name !== undefined && data.name !== existing.name) {
    diff.name = { old: existing.name, new: data.name };
  }
  if (data.description !== undefined && data.description !== existing.description) {
    diff.description = { old: existing.description, new: data.description };
  }
  if (data.autoApplyOnNewRepo !== undefined && data.autoApplyOnNewRepo !== existing.autoApplyOnNewRepo) {
    diff.autoApplyOnNewRepo = { old: existing.autoApplyOnNewRepo, new: data.autoApplyOnNewRepo };
  }
  if (data.branches !== undefined && JSON.stringify(data.branches) !== JSON.stringify(existing.branches)) {
    diff.branches = { old: existing.branches, new: data.branches };
  }

  mockActivityLog.unshift({
    id: crypto.randomUUID(),
    source: "app",
    action: "template.update",
    actor: DEMO_USER.login,
    repo: "*",
    target: mockTemplateStore[idx].name,
    details: `Updated template "${mockTemplateStore[idx].name}"`,
    diff: Object.keys(diff).length > 0 ? diff : undefined,
    timestamp: new Date().toISOString(),
  });

  return mockTemplateStore[idx];
}

export async function mockDeleteTemplate(id: string): Promise<{ message: string }> {
  await delay(400);
  const tmpl = mockTemplateStore.find((t) => t.id === id);
  mockTemplateStore = mockTemplateStore.filter((t) => t.id !== id);
  if (tmpl) {
    mockActivityLog.unshift({
      id: crypto.randomUUID(),
      source: "app",
      action: "template.delete",
      actor: DEMO_USER.login,
      repo: "*",
      target: tmpl.name,
      details: `Deleted template "${tmpl.name}"`,
      timestamp: new Date().toISOString(),
    });
  }
  return { message: "Template deleted" };
}

export async function mockApplyTemplate(
  _templateId: string,
  repo: string
): Promise<{ created: string[]; protected: string[]; errors: string[] }> {
  await delay(800);
  const tmpl = mockTemplateStore.find((t) => t.id === _templateId);
  if (!tmpl) throw new Error("Template not found");

  const created = tmpl.branches.map((b) => b.branchNames).flat();
  
  const rulesetGroups = new Map<number, string[]>();
  const classicProtected: string[] = [];
  
  tmpl.branches.forEach((b, index) => {
    if (!b.protection) return;
    
    if (b.protection.type === 'ruleset') {
      if (!rulesetGroups.has(index)) rulesetGroups.set(index, []);
      rulesetGroups.get(index)!.push(...b.branchNames);
    } else {
      classicProtected.push(...b.branchNames);
    }
  });

  const protectedBranches = [...classicProtected, ...Array.from(rulesetGroups.values()).flat()];
  
  let detailsStr = `Applied template "${tmpl.name}" — created: [${created.join(", ")}]`;
  if (classicProtected.length > 0) {
    detailsStr += `, classic protection: [${classicProtected.join(", ")}]`;
  }
  if (rulesetGroups.size > 0) {
    const bundles = Array.from(rulesetGroups.values()).map(g => `[${g.join(", ")}]`).join(", ");
    detailsStr += `, ruleset bundles: ${bundles}`;
  }

  mockActivityLog.unshift({
    id: crypto.randomUUID(),
    source: "app",
    action: "template.apply",
    actor: DEMO_USER.login,
    repo,
    target: tmpl.name,
    details: detailsStr,
    timestamp: new Date().toISOString(),
  });

  return { created, protected: protectedBranches, errors: [] };
}

let mockAlertsStore: SecurityAlert[] = [
  {
    id: "alert-1",
    repo: "web-platform",
    type: "protection_removed",
    message: "Branch protection rules removed for 'main'",
    severity: "critical",
    timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    resolved: false,
  },
  {
    id: "alert-2",
    repo: "api-gateway",
    type: "protection_drift",
    message: "Required approvals lowered from 2 to 1 on 'main'",
    severity: "high",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    resolved: false,
    details: { previousApprovals: 2, newApprovals: 1 },
  },
  {
    id: "alert-3",
    repo: "design-system",
    type: "repo_made_public",
    message: "Repository visibility changed to public",
    severity: "critical",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    resolved: true,
    resolvedAt: new Date(Date.now() - 1000 * 60 * 60 * 23).toISOString(),
    resolvedBy: DEMO_USER.login,
  },
  {
    id: "alert-4",
    repo: "mobile-app",
    type: "admin_added",
    message: "User 'external-contractor' was granted admin access",
    severity: "high",
    timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    resolved: false,
  },
  {
    id: "alert-5",
    repo: "infrastructure",
    type: "ruleset_disabled",
    message: "Repository ruleset 'Enforce PRs' was disabled",
    severity: "critical",
    timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    resolved: false,
  }
];

export async function mockFetchAlerts(): Promise<SecurityAlert[]> {
  await delay(500);
  return [...mockAlertsStore];
}

export async function mockResolveAlert(alertId: string): Promise<SecurityAlert> {
  await delay(400);
  const idx = mockAlertsStore.findIndex(a => a.id === alertId);
  if (idx === -1) throw new Error("Alert not found");
  mockAlertsStore[idx] = {
    ...mockAlertsStore[idx],
    resolved: true,
    resolvedAt: new Date().toISOString(),
    resolvedBy: DEMO_USER.login,
  };
  return mockAlertsStore[idx];
}

export async function mockUnresolveAlert(alertId: string): Promise<SecurityAlert> {
  await delay(400);
  const idx = mockAlertsStore.findIndex(a => a.id === alertId);
  if (idx === -1) throw new Error("Alert not found");
  mockAlertsStore[idx] = {
    ...mockAlertsStore[idx],
    resolved: false,
  };
  delete mockAlertsStore[idx].resolvedAt;
  delete mockAlertsStore[idx].resolvedBy;
  return mockAlertsStore[idx];
}

const mockComplianceDashboard: RepoComplianceScore[] = [
  {
    repo: "web-platform",
    score: 80,
    protectionsActive: false,
    rulesetsActive: true,
    hasRequiredFiles: true,
    outsideCollaborators: 0,
    issues: ["Classic branch protection is missing on main"],
    lastChecked: new Date().toISOString(),
  },
  {
    repo: "api-gateway",
    score: 90,
    protectionsActive: true,
    rulesetsActive: true,
    hasRequiredFiles: true,
    outsideCollaborators: 0,
    issues: ["Approvals required is less than organization standard (2)"],
    lastChecked: new Date().toISOString(),
  },
  {
    repo: "design-system",
    score: 100,
    protectionsActive: true,
    rulesetsActive: true,
    hasRequiredFiles: true,
    outsideCollaborators: 0,
    issues: [],
    lastChecked: new Date().toISOString(),
  },
  {
    repo: "mobile-app",
    score: 60,
    protectionsActive: true,
    rulesetsActive: false,
    hasRequiredFiles: false,
    outsideCollaborators: 2,
    issues: ["Missing CODEOWNERS file", "2 outside collaborators have access", "No rulesets active"],
    lastChecked: new Date().toISOString(),
  },
  {
    repo: "infrastructure",
    score: 40,
    protectionsActive: false,
    rulesetsActive: false,
    hasRequiredFiles: false,
    outsideCollaborators: 1,
    issues: ["No branch protections", "No rulesets active", "Missing README.md", "1 outside collaborator has access"],
    lastChecked: new Date().toISOString(),
  },
];

export async function mockFetchComplianceDashboard(): Promise<RepoComplianceScore[]> {
  await delay(600);
  return [...mockComplianceDashboard];
}

const mockDependencyAlerts: DependencyAlert[] = [
  {
    id: "dep-1",
    repo: "api-gateway",
    org: "acme-org",
    dependency: "lodash",
    severity: "high",
    cve: "CVE-2021-23337",
    ecosystem: "npm",
    vulnerable_version: "< 4.17.21",
    patched_version: "4.17.21",
    detected_at: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "dep-2",
    repo: "api-gateway",
    org: "acme-org",
    dependency: "axios",
    severity: "critical",
    cve: "CVE-2023-45857",
    ecosystem: "npm",
    vulnerable_version: "< 1.6.0",
    patched_version: "1.6.0",
    detected_at: new Date(Date.now() - 172800000).toISOString(),
  },
  {
    id: "dep-3",
    repo: "auth-service",
    org: "acme-org",
    dependency: "log4j",
    severity: "critical",
    cve: "CVE-2021-44228",
    ecosystem: "maven",
    vulnerable_version: "< 2.15.0",
    patched_version: "2.15.0",
    detected_at: new Date(Date.now() - 345600000).toISOString(),
  },
  {
    id: "dep-4",
    repo: "web-platform",
    org: "acme-org",
    dependency: "react-scripts",
    severity: "low",
    cve: "CVE-2022-24302",
    ecosystem: "npm",
    vulnerable_version: "< 5.0.1",
    patched_version: "5.0.1",
    detected_at: new Date(Date.now() - 432000000).toISOString(),
  },
  {
    id: "dep-disabled",
    repo: "infrastructure",
    org: "acme-org",
    dependency: "",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    disabled: true,
  }
];

export async function mockFetchDependencies(): Promise<DependencyAlert[]> {
  await delay(600);
  return [...mockDependencyAlerts];
}

export async function mockFetchDependencySummary(): Promise<DependencySummary> {
  await delay(400);
  return {
    critical: 3,
    high: 12,
    medium: 20,
    low: 45,
    repos_with_vulns: 7,
  };
}
