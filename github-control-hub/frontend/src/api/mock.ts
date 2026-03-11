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
    name: "repo-1",
    full_name: "acme-org/repo-1",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 1",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-2",
    full_name: "acme-org/repo-2",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 2",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-3",
    full_name: "acme-org/repo-3",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 3",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-4",
    full_name: "acme-org/repo-4",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 4",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-5",
    full_name: "acme-org/repo-5",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 5",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-6",
    full_name: "acme-org/repo-6",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 6",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-7",
    full_name: "acme-org/repo-7",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 7",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-8",
    full_name: "acme-org/repo-8",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 8",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-9",
    full_name: "acme-org/repo-9",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 9",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-10",
    full_name: "acme-org/repo-10",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 10",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-11",
    full_name: "acme-org/repo-11",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 11",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-12",
    full_name: "acme-org/repo-12",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 12",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-13",
    full_name: "acme-org/repo-13",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 13",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-14",
    full_name: "acme-org/repo-14",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 14",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-15",
    full_name: "acme-org/repo-15",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 15",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-16",
    full_name: "acme-org/repo-16",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 16",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-17",
    full_name: "acme-org/repo-17",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 17",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-18",
    full_name: "acme-org/repo-18",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 18",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-19",
    full_name: "acme-org/repo-19",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 19",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-20",
    full_name: "acme-org/repo-20",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 20",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-21",
    full_name: "acme-org/repo-21",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 21",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-22",
    full_name: "acme-org/repo-22",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 22",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-23",
    full_name: "acme-org/repo-23",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 23",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-24",
    full_name: "acme-org/repo-24",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 24",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-25",
    full_name: "acme-org/repo-25",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 25",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-26",
    full_name: "acme-org/repo-26",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 26",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-27",
    full_name: "acme-org/repo-27",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 27",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-28",
    full_name: "acme-org/repo-28",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 28",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-29",
    full_name: "acme-org/repo-29",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 29",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-30",
    full_name: "acme-org/repo-30",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 30",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-31",
    full_name: "acme-org/repo-31",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 31",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-32",
    full_name: "acme-org/repo-32",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 32",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-33",
    full_name: "acme-org/repo-33",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 33",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-34",
    full_name: "acme-org/repo-34",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 34",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-35",
    full_name: "acme-org/repo-35",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 35",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-36",
    full_name: "acme-org/repo-36",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 36",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-37",
    full_name: "acme-org/repo-37",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 37",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-38",
    full_name: "acme-org/repo-38",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 38",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-39",
    full_name: "acme-org/repo-39",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 39",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-40",
    full_name: "acme-org/repo-40",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 40",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-41",
    full_name: "acme-org/repo-41",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 41",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-42",
    full_name: "acme-org/repo-42",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 42",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-43",
    full_name: "acme-org/repo-43",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 43",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-44",
    full_name: "acme-org/repo-44",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 44",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-45",
    full_name: "acme-org/repo-45",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 45",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-46",
    full_name: "acme-org/repo-46",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 46",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][1],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-47",
    full_name: "acme-org/repo-47",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 47",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][2],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-48",
    full_name: "acme-org/repo-48",
    private: true,
    default_branch: "main",
    description: "Auto-generated mock repo 48",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][3],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-49",
    full_name: "acme-org/repo-49",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 49",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][4],
    updated_at: "2026-03-08T18:30:00Z",
  },
  {
    name: "repo-50",
    full_name: "acme-org/repo-50",
    private: false,
    default_branch: "main",
    description: "Auto-generated mock repo 50",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][0],
    updated_at: "2026-03-08T18:30:00Z",
  }
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
  },
  {
    id: "dep-clean",
    repo: "design-system",
    org: "acme-org",
    dependency: "No vulnerabilities found",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    clean: true,
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

export async function mockGetGraphNode(id: string): Promise<any> {
  await delay(300);
  if (id.startsWith("REPO#")) {
    return {
      node: id,
      edges: [
        { target: "TEAM#engineers", type: "owned_by_team", metadata: { permission: "admin" } },
        { target: "WORKFLOW#deploy-prod", type: "uses_workflow", metadata: { path: ".github/workflows/deploy-prod.yml" } },
        { target: "DEPENDENCY#lodash", type: "has_vulnerable_dependency", metadata: { severity: "high" } }
      ]
    };
  } else if (id.startsWith("USER#")) {
    return {
      node: id,
      edges: [
        { target: "TEAM#engineers", type: "member_of", metadata: {} },
        { target: "REPO#payments-api", type: "collaborates_on", metadata: { role: "admin" } }
      ]
    };
  } else if (id.startsWith("TEAM#")) {
    return {
      node: id,
      edges: [
        { target: "REPO#payments-api", type: "owns_repo", metadata: { permission: "admin" } },
        { target: "REPO#auth-lib", type: "owns_repo", metadata: { permission: "write" } },
        { target: "USER#alice", type: "has_member", metadata: {} },
        { target: "USER#bob", type: "has_member", metadata: {} }
      ]
    };
  }
  return { node: id, edges: [] };
}

export async function mockGetBlastRadius(repo: string): Promise<any> {
  await delay(500);
  return {
    repo,
    workflows: ["deploy-prod", "ci-tests"],
    vulnerableDependencies: [
      { name: "lodash", severity: "high" },
      { name: "axios", severity: "critical" }
    ],
    teamsWithAccess: [
      { name: "engineers", permission: "admin" },
      { name: "contractors", permission: "read" }
    ],
    directCollaborators: [
      { name: "alice", role: "admin" }
    ],
    riskScore: "High"
  };
}

export async function mockGetBlastRadiusRanking(): Promise<any[]> {
  await delay(500);
  return [
    {
      repo: "repo-19",
      score: 39,
      riskLevel: "CRITICAL",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 4
    },
    {
      repo: "repo-4",
      score: 38,
      riskLevel: "CRITICAL",
      workflowsCount: 2,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 0
    },
    {
      repo: "repo-26",
      score: 37,
      riskLevel: "CRITICAL",
      workflowsCount: 4,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 9
    },
    {
      repo: "repo-30",
      score: 34,
      riskLevel: "CRITICAL",
      workflowsCount: 3,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 4
    },
    {
      repo: "repo-35",
      score: 33,
      riskLevel: "CRITICAL",
      workflowsCount: 2,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 0
    },
    {
      repo: "repo-15",
      score: 31,
      riskLevel: "CRITICAL",
      workflowsCount: 1,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 3
    },
    {
      repo: "repo-33",
      score: 31,
      riskLevel: "CRITICAL",
      workflowsCount: 0,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 9
    },
    {
      repo: "repo-44",
      score: 30,
      riskLevel: "HIGH",
      workflowsCount: 1,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 7
    },
    {
      repo: "repo-37",
      score: 29,
      riskLevel: "HIGH",
      workflowsCount: 1,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 3
    },
    {
      repo: "repo-36",
      score: 28,
      riskLevel: "HIGH",
      workflowsCount: 0,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 9
    },
    {
      repo: "repo-34",
      score: 27,
      riskLevel: "HIGH",
      workflowsCount: 1,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 4
    },
    {
      repo: "repo-22",
      score: 26,
      riskLevel: "HIGH",
      workflowsCount: 3,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 7
    },
    {
      repo: "repo-25",
      score: 25,
      riskLevel: "HIGH",
      workflowsCount: 3,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 8
    },
    {
      repo: "repo-14",
      score: 24,
      riskLevel: "HIGH",
      workflowsCount: 1,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 6
    },
    {
      repo: "repo-29",
      score: 22,
      riskLevel: "HIGH",
      workflowsCount: 1,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 5
    },
    {
      repo: "repo-31",
      score: 21,
      riskLevel: "HIGH",
      workflowsCount: 4,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 2
    },
    {
      repo: "repo-9",
      score: 20,
      riskLevel: "HIGH",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 1
    },
    {
      repo: "repo-42",
      score: 20,
      riskLevel: "HIGH",
      workflowsCount: 0,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 6
    },
    {
      repo: "repo-17",
      score: 19,
      riskLevel: "HIGH",
      workflowsCount: 4,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 2
    },
    {
      repo: "repo-49",
      score: 19,
      riskLevel: "HIGH",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 5
    },
    {
      repo: "repo-10",
      score: 18,
      riskLevel: "HIGH",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 8
    },
    {
      repo: "repo-5",
      score: 16,
      riskLevel: "HIGH",
      workflowsCount: 1,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 4
    },
    {
      repo: "repo-16",
      score: 16,
      riskLevel: "HIGH",
      workflowsCount: 3,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 7
    },
    {
      repo: "repo-2",
      score: 14,
      riskLevel: "MEDIUM",
      workflowsCount: 4,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 0
    },
    {
      repo: "repo-12",
      score: 14,
      riskLevel: "MEDIUM",
      workflowsCount: 4,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 9
    },
    {
      repo: "repo-45",
      score: 14,
      riskLevel: "MEDIUM",
      workflowsCount: 2,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 2
    },
    {
      repo: "repo-13",
      score: 13,
      riskLevel: "MEDIUM",
      workflowsCount: 0,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 7
    },
    {
      repo: "repo-50",
      score: 13,
      riskLevel: "MEDIUM",
      workflowsCount: 4,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 8
    },
    {
      repo: "repo-11",
      score: 12,
      riskLevel: "MEDIUM",
      workflowsCount: 1,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 9
    },
    {
      repo: "repo-27",
      score: 12,
      riskLevel: "MEDIUM",
      workflowsCount: 2,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 6
    },
    {
      repo: "repo-8",
      score: 11,
      riskLevel: "MEDIUM",
      workflowsCount: 1,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 5
    },
    {
      repo: "repo-32",
      score: 11,
      riskLevel: "MEDIUM",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 0
    },
    {
      repo: "repo-47",
      score: 11,
      riskLevel: "MEDIUM",
      workflowsCount: 4,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 4
    },
    {
      repo: "repo-48",
      score: 10,
      riskLevel: "MEDIUM",
      workflowsCount: 4,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 8
    },
    {
      repo: "repo-23",
      score: 9,
      riskLevel: "MEDIUM",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 9
    },
    {
      repo: "repo-28",
      score: 9,
      riskLevel: "MEDIUM",
      workflowsCount: 4,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 4
    },
    {
      repo: "repo-41",
      score: 9,
      riskLevel: "MEDIUM",
      workflowsCount: 2,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 6
    },
    {
      repo: "repo-46",
      score: 9,
      riskLevel: "MEDIUM",
      workflowsCount: 2,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 7
    },
    {
      repo: "repo-24",
      score: 7,
      riskLevel: "MEDIUM",
      workflowsCount: 0,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 7
    },
    {
      repo: "repo-1",
      score: 6,
      riskLevel: "MEDIUM",
      workflowsCount: 3,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 5
    },
    {
      repo: "repo-6",
      score: 6,
      riskLevel: "MEDIUM",
      workflowsCount: 0,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 3
    },
    {
      repo: "repo-18",
      score: 5,
      riskLevel: "LOW",
      workflowsCount: 4,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 9
    },
    {
      repo: "repo-40",
      score: 5,
      riskLevel: "LOW",
      workflowsCount: 0,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 9
    },
    {
      repo: "repo-3",
      score: 4,
      riskLevel: "LOW",
      workflowsCount: 1,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 4
    },
    {
      repo: "repo-20",
      score: 3,
      riskLevel: "LOW",
      workflowsCount: 3,
      vulnerabilitiesCount: 3,
      accessVectorsCount: 3
    },
    {
      repo: "repo-43",
      score: 3,
      riskLevel: "LOW",
      workflowsCount: 2,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 0
    },
    {
      repo: "repo-7",
      score: 1,
      riskLevel: "LOW",
      workflowsCount: 2,
      vulnerabilitiesCount: 2,
      accessVectorsCount: 8
    },
    {
      repo: "repo-39",
      score: 1,
      riskLevel: "LOW",
      workflowsCount: 4,
      vulnerabilitiesCount: 1,
      accessVectorsCount: 4
    },
    {
      repo: "repo-21",
      score: 0,
      riskLevel: "LOW",
      workflowsCount: 0,
      vulnerabilitiesCount: 4,
      accessVectorsCount: 8
    },
    {
      repo: "repo-38",
      score: 0,
      riskLevel: "LOW",
      workflowsCount: 4,
      vulnerabilitiesCount: 0,
      accessVectorsCount: 2
    }
  ];
}

export async function mockGetUserImpact(user: string): Promise<any> {
  await delay(500);
  return {
    user,
    teams: ["engineers", "platform"],
    repos: [
      { repo: "payments-api", access: "direct", permission: "admin" },
      { repo: "auth-lib", access: "via_team", team: "engineers", permission: "write" },
      { repo: "infrastructure", access: "via_team", team: "platform", permission: "admin" }
    ],
    writeOrAdminReposCount: 3,
    productionPipelinesReachable: 2
  };
}

export async function mockFetchSecurityQuery(q: string, param?: string, advanced?: any): Promise<any[]> {
  await delay(600);
  switch (q) {
    case "repos-dependent-on":
      return [
        { repo: "payments-api", reason: `Depends on ${param || 'unknown'} (critical severity)` },
        { repo: "billing-service", reason: `Depends on ${param || 'unknown'} (high severity)` }
      ];
    case "repos-deploying-to-prod":
      return [
        { repo: "payments-api", reason: "Uses workflow: deploy-prod" },
        { repo: "auth-lib", reason: "Uses workflow: release-to-npm" }
      ];
    case "repos-with-outside-admins":
      return [
        { repo: "infrastructure", reason: "User alice has direct admin access" },
        { repo: "auth-lib", reason: "User bob has direct admin access" }
      ];
    case "highly-privileged-users":
      return [
        { user: "alice", reason: "Has direct write/admin access to 8 repos", details: "repo1, repo2, repo3, repo4, repo5..." },
        { user: "bob", reason: "Has direct write/admin access to 5 repos", details: "auth-lib, core, frontend..." }
      ];
    case "unowned-repos":
      return [
        { repo: "legacy-tooling", reason: "No team assigned as owner" },
        { repo: "test-repo-123", reason: "No team assigned as owner" }
      ];
    case "repos-with-critical-vulns":
      return [
        { repo: "payments-api", reason: "Critical vulnerability in lodash" },
        { repo: "frontend-ui", reason: "Critical vulnerability in react-scripts" }
      ];
    case "repos-missing-branch":
      return [
        { repo: "legacy-api", reason: `Missing branch: ${param || 'main'}` },
        { repo: "old-docs", reason: `Missing branch: ${param || 'main'}` }
      ];
    case "repos-with-unprotected-branch":
      return [
        { repo: "frontend-ui", reason: `Branch '${param || 'main'}' exists but is NOT protected` },
        { repo: "payments-api", reason: `Branch '${param || 'main'}' exists but is NOT protected` }
      ];
    case "repos-with-branch":
      return [
        { repo: "repo-1", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-3", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-5", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-7", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-9", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-11", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-13", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-15", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-17", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-19", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-21", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-23", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-25", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-27", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-29", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-31", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-33", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-35", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-37", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-39", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-41", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-43", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-45", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-47", reason: `Has branch: ${param || 'main'}` },
        { repo: "repo-49", reason: `Has branch: ${param || 'main'}` }
      ];
    case "repos-with-branch-rules":
      const reqs = [];
      if (advanced?.protectionType && advanced.protectionType !== 'any') reqs.push(advanced.protectionType);
      if (advanced?.requirePr) reqs.push("PRs");
      if (advanced?.requireStatusChecks) reqs.push("Status Checks");
      if (advanced?.enforceAdmins) reqs.push("Enforce Admins");
      
      return [
        { repo: "payments-api", reason: `Branch '${param}' matches required rules: ${reqs.join(", ") || "none"}` },
        { repo: "auth-lib", reason: `Branch '${param}' matches required rules: ${reqs.join(", ") || "none"}` }
      ];
    case "empty-teams":
      return [
        { team: "old-project-team", reason: "Team has no members" }
      ];
    case "stale-branch-protections":
      return [
        { repo: "payments-api", reason: "Requires 2 reviewers, but recent PRs average 0.2 approving reviews", details: "Protections are likely being bypassed (e.g., by admins)" },
        { repo: "legacy-docs", reason: "Requires 1 reviewers, but recent PRs average 0.0 approving reviews", details: "Protections are likely being bypassed (e.g., by admins)" }
      ];
    case "protection-bypasses-ranking":
      return [
        { repo: "repo-30", bypasses: 14, reason: "14 out of last 20 PRs bypassed the 2 reviewers requirement", score: 14 },
        { repo: "repo-5", bypasses: 13, reason: "13 out of last 20 PRs bypassed the 2 reviewers requirement", score: 13 },
        { repo: "repo-26", bypasses: 13, reason: "13 out of last 20 PRs bypassed the 2 reviewers requirement", score: 13 },
        { repo: "repo-34", bypasses: 13, reason: "13 out of last 20 PRs bypassed the 2 reviewers requirement", score: 13 },
        { repo: "repo-6", bypasses: 12, reason: "12 out of last 20 PRs bypassed the 2 reviewers requirement", score: 12 },
        { repo: "repo-40", bypasses: 12, reason: "12 out of last 20 PRs bypassed the 2 reviewers requirement", score: 12 },
        { repo: "repo-45", bypasses: 12, reason: "12 out of last 20 PRs bypassed the 2 reviewers requirement", score: 12 },
        { repo: "repo-8", bypasses: 11, reason: "11 out of last 20 PRs bypassed the 2 reviewers requirement", score: 11 },
        { repo: "repo-12", bypasses: 11, reason: "11 out of last 20 PRs bypassed the 2 reviewers requirement", score: 11 },
        { repo: "repo-14", bypasses: 11, reason: "11 out of last 20 PRs bypassed the 2 reviewers requirement", score: 11 },
        { repo: "repo-37", bypasses: 11, reason: "11 out of last 20 PRs bypassed the 2 reviewers requirement", score: 11 },
        { repo: "repo-16", bypasses: 10, reason: "10 out of last 20 PRs bypassed the 2 reviewers requirement", score: 10 },
        { repo: "repo-27", bypasses: 10, reason: "10 out of last 20 PRs bypassed the 2 reviewers requirement", score: 10 },
        { repo: "repo-28", bypasses: 10, reason: "10 out of last 20 PRs bypassed the 2 reviewers requirement", score: 10 },
        { repo: "repo-29", bypasses: 10, reason: "10 out of last 20 PRs bypassed the 2 reviewers requirement", score: 10 },
        { repo: "repo-31", bypasses: 10, reason: "10 out of last 20 PRs bypassed the 2 reviewers requirement", score: 10 },
        { repo: "repo-36", bypasses: 9, reason: "9 out of last 20 PRs bypassed the 2 reviewers requirement", score: 9 },
        { repo: "repo-43", bypasses: 9, reason: "9 out of last 20 PRs bypassed the 2 reviewers requirement", score: 9 },
        { repo: "repo-49", bypasses: 9, reason: "9 out of last 20 PRs bypassed the 2 reviewers requirement", score: 9 },
        { repo: "repo-4", bypasses: 8, reason: "8 out of last 20 PRs bypassed the 2 reviewers requirement", score: 8 },
        { repo: "repo-10", bypasses: 8, reason: "8 out of last 20 PRs bypassed the 2 reviewers requirement", score: 8 },
        { repo: "repo-25", bypasses: 8, reason: "8 out of last 20 PRs bypassed the 2 reviewers requirement", score: 8 },
        { repo: "repo-7", bypasses: 7, reason: "7 out of last 20 PRs bypassed the 2 reviewers requirement", score: 7 },
        { repo: "repo-9", bypasses: 7, reason: "7 out of last 20 PRs bypassed the 2 reviewers requirement", score: 7 },
        { repo: "repo-13", bypasses: 7, reason: "7 out of last 20 PRs bypassed the 2 reviewers requirement", score: 7 },
        { repo: "repo-18", bypasses: 7, reason: "7 out of last 20 PRs bypassed the 2 reviewers requirement", score: 7 },
        { repo: "repo-20", bypasses: 7, reason: "7 out of last 20 PRs bypassed the 2 reviewers requirement", score: 7 },
        { repo: "repo-41", bypasses: 7, reason: "7 out of last 20 PRs bypassed the 2 reviewers requirement", score: 7 },
        { repo: "repo-1", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-17", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-22", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-24", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-38", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-42", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-47", bypasses: 6, reason: "6 out of last 20 PRs bypassed the 2 reviewers requirement", score: 6 },
        { repo: "repo-11", bypasses: 5, reason: "5 out of last 20 PRs bypassed the 2 reviewers requirement", score: 5 },
        { repo: "repo-46", bypasses: 5, reason: "5 out of last 20 PRs bypassed the 2 reviewers requirement", score: 5 },
        { repo: "repo-48", bypasses: 5, reason: "5 out of last 20 PRs bypassed the 2 reviewers requirement", score: 5 },
        { repo: "repo-32", bypasses: 4, reason: "4 out of last 20 PRs bypassed the 2 reviewers requirement", score: 4 },
        { repo: "repo-33", bypasses: 4, reason: "4 out of last 20 PRs bypassed the 2 reviewers requirement", score: 4 },
        { repo: "repo-21", bypasses: 3, reason: "3 out of last 20 PRs bypassed the 2 reviewers requirement", score: 3 },
        { repo: "repo-39", bypasses: 3, reason: "3 out of last 20 PRs bypassed the 2 reviewers requirement", score: 3 },
        { repo: "repo-2", bypasses: 2, reason: "2 out of last 20 PRs bypassed the 2 reviewers requirement", score: 2 },
        { repo: "repo-19", bypasses: 2, reason: "2 out of last 20 PRs bypassed the 2 reviewers requirement", score: 2 },
        { repo: "repo-23", bypasses: 2, reason: "2 out of last 20 PRs bypassed the 2 reviewers requirement", score: 2 },
        { repo: "repo-15", bypasses: 1, reason: "1 out of last 20 PRs bypassed the 2 reviewers requirement", score: 1 },
        { repo: "repo-35", bypasses: 1, reason: "1 out of last 20 PRs bypassed the 2 reviewers requirement", score: 1 }
      ];
    default:
      return [];
  }
}
