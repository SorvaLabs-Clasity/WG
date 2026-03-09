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

export function protectBranch(
  repo: string,
  branch: string,
  protection: NonNullable<import("../types/Template").BranchRule["protection"]>
): Promise<{ message: string }> {
  if (DEMO_MODE) return mockProtectBranch(repo, branch, protection);
  return apiPut(`/repos/${repo}/protection/${branch}`, protection);
}
