import { Octokit } from "octokit";
import { getOrg } from "../github/client";

type Protection = NonNullable<import("./templateService").BranchRule["protection"]>;

export function buildRulesetRules(protection: Protection): any[] {
  const rules: any[] = [];

  if (protection.restrictCreations) rules.push({ type: "creation" });
  if (protection.restrictUpdates) rules.push({ type: "update", parameters: { update_allows_fetch_and_merge: true } });
  if (protection.preventDeletion) rules.push({ type: "deletion" });
  if (protection.preventForcePush) rules.push({ type: "non_fast_forward" });
  if (protection.requireLinearHistory) rules.push({ type: "required_linear_history" });
  if (protection.requireSignedCommits) rules.push({ type: "required_signatures" });

  if (protection.requirePr) {
    const prParams: any = {
      required_approving_review_count: protection.requiredApprovals,
      dismiss_stale_reviews_on_push: protection.dismissStaleReviews,
      require_code_owner_review: protection.requireCodeOwnerReviews,
      require_last_push_approval: protection.requireLastPushApproval ?? false,
      required_review_thread_resolution: protection.requireConversationResolution,
    };
    if (protection.allowedMergeMethods && protection.allowedMergeMethods.length > 0) {
      prParams.allowed_merge_methods = protection.allowedMergeMethods;
    }
    rules.push({ type: "pull_request", parameters: prParams });
  }

  if (protection.requireStatusChecks) {
    const contexts = (protection.statusCheckContexts && protection.statusCheckContexts.length > 0)
      ? protection.statusCheckContexts.map(c => ({ context: c }))
      : [{ context: "build" }];

    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: protection.strictStatusChecks,
        do_not_enforce_on_create: protection.doNotRequireStatusChecksOnCreation ?? false,
        required_status_checks: contexts,
      },
    });
  }

  if (protection.requireDeployments && protection.requiredDeploymentEnvironments && protection.requiredDeploymentEnvironments.length > 0) {
    rules.push({
      type: "required_deployments",
      parameters: {
        required_deployment_environments: protection.requiredDeploymentEnvironments,
      },
    });
  }

  if (protection.requireCodeScanning) {
    rules.push({
      type: "required_code_scanning",
      parameters: {
        code_scanning_tools: [{
          tool: protection.codeScanningTool || "CodeQL",
          alerts_threshold: protection.codeScanningAlertsThreshold || "errors",
          security_alerts_threshold: protection.codeScanningSecurityAlertsThreshold || "high_or_higher",
        }],
      },
    });
  }

  if (protection.requireCodeQuality) {
    rules.push({
      type: "code_quality",
      parameters: {
        severity: protection.codeQualitySeverity || "errors",
      },
    });
  }

  if (protection.copilotCodeReview) {
    rules.push({
      type: "copilot_code_review",
      parameters: {
        review_on_push: protection.copilotReviewOnPush ?? false,
        review_draft_pull_requests: protection.copilotReviewDraftPrs ?? false,
      },
    });
  }

  return rules;
}

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

  if (protection.type === "ruleset") {
    const rules: any[] = buildRulesetRules(protection);

    await octokit.rest.repos.createRepoRuleset({
      owner: org,
      repo,
      name: protection.rulesetName || `Ruleset for ${branch}`,
      target: "branch",
      enforcement: (protection.enforcement as any) || "active",
      bypass_actors: protection.enforceAdmins ? [] : [
        {
          actor_id: 5,
          actor_type: "RepositoryRole",
          bypass_mode: "always"
        }
      ],
      conditions: {
        ref_name: {
          include: [`refs/heads/${branch}`],
          exclude: [],
        },
      },
      rules,
    });
  } else {
    // Classic Branch Protection API
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
}

export async function listRulesets(octokit: Octokit, repo: string) {
  const org = getOrg();
  try {
    const { data } = await octokit.rest.repos.getRepoRulesets({
      owner: org,
      repo,
    });
    return data;
  } catch (err: unknown) {
    console.error("Error listing rulesets:", err);
    return [];
  }
}

export async function deleteProtection(
  octokit: Octokit,
  repo: string,
  branch: string
): Promise<void> {
  const org = getOrg();
  await octokit.rest.repos.deleteBranchProtection({
    owner: org,
    repo,
    branch,
  });
}

export async function deleteRuleset(
  octokit: Octokit,
  repo: string,
  rulesetId: number
): Promise<void> {
  const org = getOrg();
  await octokit.rest.repos.deleteRepoRuleset({
    owner: org,
    repo,
    ruleset_id: rulesetId,
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

export async function getAllProtections(
  octokit: Octokit,
  repo: string
): Promise<Record<string, Record<string, unknown>>> {
  const branches = await listBranches(octokit, repo);
  const protectedBranches = branches.filter((b) => b.protected);
  
  const protections: Record<string, Record<string, unknown>> = {};
  
  // Fetch protections concurrently for all protected branches
  await Promise.all(
    protectedBranches.map(async (branch) => {
      try {
        const protection = await getProtection(octokit, repo, branch.name);
        if (protection) {
          protections[branch.name] = protection;
        }
      } catch (err) {
        console.error(`Error fetching protection for branch ${branch.name}:`, err);
      }
    })
  );
  
  return protections;
}
