import { apiGet, apiPost, apiDelete, apiPut, DEMO_MODE } from "./client";
import {
  mockFetchBranches,
  mockCreateBranch,
  mockDeleteBranch,
  mockProtectBranch,
} from "./mock";
import type { Branch } from "../types/Branch";

export function fetchBranches(repo: string): Promise<Branch[]> {
  if (DEMO_MODE) return mockFetchBranches(repo);
  return apiGet<Branch[]>(`/repos/${repo}/branches`);
}

export function createBranch(
  repo: string,
  branchName: string,
  baseBranch: string
): Promise<{ message: string }> {
  if (DEMO_MODE) return mockCreateBranch(repo, branchName, baseBranch);
  return apiPost(`/repos/${repo}/branches`, { branchName, baseBranch });
}

export function deleteBranch(repo: string, branch: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteBranch(repo, branch);
  return apiDelete(`/repos/${repo}/branches/${branch}`);
}

export async function fetchBranchProtection(repo: string, branch: string): Promise<any> {
  if (DEMO_MODE) return Promise.resolve(null); // Will handle mock later
  return apiGet(`/repos/${repo}/protection/${branch}`);
}

export async function fetchAllBranchProtections(repo: string): Promise<Record<string, any>> {
  if (DEMO_MODE) {
    const branches = await mockFetchBranches(repo);
    const protectedBranches = branches.filter(b => b.protected);
    const protections: Record<string, any> = {};
    for (const b of protectedBranches) {
       protections[b.name] = { 
         required_pull_request_reviews: { required_approving_review_count: b.name === 'main' ? 2 : 1 },
         enforce_admins: { enabled: true },
         required_status_checks: { strict: true, contexts: ["ci/test"] }
       };
    }
    return protections;
  }
  return apiGet(`/repos/${repo}/protections`);
}

export async function fetchRepoRulesets(repo: string): Promise<any[]> {
  if (DEMO_MODE) {
    // Return mock rulesets
    return [
      { id: 1, name: "Default Main Protection", enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"] } } },
      { id: 2, name: "Release Bundles", enforcement: "evaluate", target: "branch", conditions: { ref_name: { include: ["refs/heads/release/*"] } } }
    ];
  }
  return apiGet(`/repos/${repo}/rulesets`);
}

export function protectBranch(
  repo: string,
  branch: string,
  protection: NonNullable<import("../types/Template").BranchRule["protection"]>
): Promise<{ message: string }> {
  if (DEMO_MODE) return mockProtectBranch(repo, branch, protection);
  return apiPut(`/repos/${repo}/protection/${branch}`, protection);
}
