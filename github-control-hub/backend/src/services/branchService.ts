import { Octokit } from "octokit";
import { getOrg } from "../github/client";

export interface BranchSummary {
  name: string;
  protected: boolean;
  sha: string;
}

export async function listBranches(octokit: Octokit, repo: string): Promise<BranchSummary[]> {
  const org = getOrg();
  const branches: BranchSummary[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.repos.listBranches({
      owner: org,
      repo,
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    for (const b of data) {
      branches.push({
        name: b.name,
        protected: b.protected,
        sha: b.commit.sha,
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return branches;
}

export async function createBranch(
  octokit: Octokit,
  repo: string,
  branchName: string,
  baseBranch: string
): Promise<void> {
  const org = getOrg();

  const { data: ref } = await octokit.rest.git.getRef({
    owner: org,
    repo,
    ref: `heads/${baseBranch}`,
  });

  await octokit.rest.git.createRef({
    owner: org,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
}

export async function deleteBranch(octokit: Octokit, repo: string, branch: string): Promise<void> {
  const org = getOrg();

  await octokit.rest.git.deleteRef({
    owner: org,
    repo,
    ref: `heads/${branch}`,
  });
}

export async function protectBranch(
  octokit: Octokit,
  repo: string,
  branch: string,
  protection: NonNullable<import("./templateService").BranchRule["protection"]>
): Promise<void> {
  const org = getOrg();

  await octokit.rest.repos.updateBranchProtection({
    owner: org,
    repo,
    branch,
    required_status_checks: protection.requireStatusChecks
      ? {
          strict: protection.strictStatusChecks,
          contexts: [],
        }
      : null,
    enforce_admins: protection.enforceAdmins,
    required_pull_request_reviews: protection.requirePr
      ? {
          required_approving_review_count: protection.requiredApprovals,
          dismiss_stale_reviews: protection.dismissStaleReviews,
          require_code_owner_reviews: protection.requireCodeOwnerReviews,
        }
      : null,
    restrictions: null,
    required_linear_history: protection.requireLinearHistory,
    allow_force_pushes: !protection.preventForcePush,
    allow_deletions: !protection.preventDeletion,
    required_conversation_resolution: protection.requireConversationResolution,
    required_signatures: protection.requireSignedCommits,
  });
}

export async function getProtection(
  octokit: Octokit,
  repo: string,
  branch: string
): Promise<Record<string, unknown> | null> {
  const org = getOrg();

  try {
    const { data } = await octokit.rest.repos.getBranchProtection({
      owner: org,
      repo,
      branch,
    });
    return data as unknown as Record<string, unknown>;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 404) return null;
    throw err;
  }
}
