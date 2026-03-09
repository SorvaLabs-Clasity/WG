import type { Repo } from "../types/Repo";
import type { Branch } from "../types/Branch";
import type { Activity } from "../types/Activity";
import type { RepoTemplate, BranchRule } from "../types/Template";

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

// ── Activity mock data ───────────────────────────────────────────

const mockActivityLog: Activity[] = [
  {
    id: "a1",
    action: "branch.create",
    actor: "alice",
    repo: "web-platform",
    target: "feature/dark-mode",
    details: "Created from main",
    timestamp: "2026-03-09T09:12:00Z",
  },
  {
    id: "a2",
    action: "branch.protect",
    actor: "bob",
    repo: "web-platform",
    target: "main",
    details: "Applied default protection rules",
    timestamp: "2026-03-09T08:45:00Z",
  },
  {
    id: "a3",
    action: "branch.delete",
    actor: "alice",
    repo: "api-gateway",
    target: "hotfix/old-fix",
    timestamp: "2026-03-08T17:30:00Z",
  },
  {
    id: "a4",
    action: "template.apply",
    actor: "carol",
    repo: "design-system",
    target: "Standard Branch Setup",
    details: 'Applied template "Standard Branch Setup" — created: [dev, uat], protected: [main, uat]',
    timestamp: "2026-03-08T14:20:00Z",
  },
  {
    id: "a5",
    action: "branch.create",
    actor: "dave",
    repo: "ml-pipeline",
    target: "experiment/transformer-v3",
    details: "Created from develop",
    timestamp: "2026-03-08T11:05:00Z",
  },
  {
    id: "a6",
    action: "template.create",
    actor: "alice",
    repo: "*",
    target: "Standard Branch Setup",
    details: 'Created template "Standard Branch Setup"',
    timestamp: "2026-03-07T16:00:00Z",
  },
  {
    id: "a7",
    action: "branch.protect",
    actor: "bob",
    repo: "api-gateway",
    target: "main",
    details: "Applied default protection rules",
    timestamp: "2026-03-07T10:30:00Z",
  },
  {
    id: "a8",
    action: "branch.create",
    actor: "carol",
    repo: "api-gateway",
    target: "feature/rate-limiter",
    details: "Created from main",
    timestamp: "2026-03-06T15:45:00Z",
  },
  {
    id: "a9",
    action: "branch.create",
    actor: "dave",
    repo: "mobile-app",
    target: "feature/push-notifications",
    details: "Created from main",
    timestamp: "2026-03-06T09:20:00Z",
  },
  {
    id: "a10",
    action: "branch.protect",
    actor: "alice",
    repo: "ml-pipeline",
    target: "develop",
    details: "Applied default protection rules",
    timestamp: "2026-03-05T18:10:00Z",
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
        branchName: "main",
        protection: {
          type: "classic",
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
        branchName: "uat",
        protection: {
          type: "classic",
          requirePr: true,
          requiredApprovals: 1,
          dismissStaleReviews: true,
          requireCodeOwnerReviews: false,
          requireConversationResolution: false,
          requireStatusChecks: true,
          strictStatusChecks: true,
          requireSignedCommits: false,
          requireLinearHistory: false,
          enforceAdmins: true,
          preventForcePush: true,
          preventDeletion: false,
        },
      },
      {
        branchName: "dev",
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
        branchName: "main",
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

  const created = tmpl.branches.map((b) => b.branchName);
  
  const rulesetGroups = new Map<string, string[]>();
  const classicProtected: string[] = [];
  
  tmpl.branches.forEach(b => {
    if (!b.protection) return;
    
    if (b.protection.type === 'ruleset') {
      const { type, ...settings } = b.protection;
      // In JS, object key order matters for JSON.stringify, but for this mock this naive approach is fine
      // since the settings object usually comes directly from state in the same order.
      const hash = JSON.stringify(settings);
      if (!rulesetGroups.has(hash)) rulesetGroups.set(hash, []);
      rulesetGroups.get(hash)!.push(b.branchName);
    } else {
      classicProtected.push(b.branchName);
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
    action: "template.apply",
    actor: DEMO_USER.login,
    repo,
    target: tmpl.name,
    details: detailsStr,
    timestamp: new Date().toISOString(),
  });

  return { created, protected: protectedBranches, errors: [] };
}
