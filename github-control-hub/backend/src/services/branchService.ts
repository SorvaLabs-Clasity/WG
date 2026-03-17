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

type TagProtection = import("./templateService").TagRule;

export function buildTagRulesetRules(tag: TagProtection): any[] {
  const rules: any[] = [];

  if (tag.preventCreation) rules.push({ type: "creation" });
  if (tag.preventUpdate) rules.push({ type: "update", parameters: { update_allows_fetch_and_merge: false } });
  if (tag.preventDeletion) rules.push({ type: "deletion" });
  if (tag.preventForcePush) rules.push({ type: "non_fast_forward" });
  if (tag.requireSignedCommits) rules.push({ type: "required_signatures" });

  if (tag.namePattern) {
    rules.push({
      type: "tag_name_pattern",
      parameters: {
        operator: tag.namePattern.operator,
        pattern: tag.namePattern.pattern,
        negate: tag.namePattern.negate ?? false,
        name: tag.namePattern.name || "Tag name pattern",
      },
    });
  }

  return rules;
}

type PushProtection = import("./templateService").PushRule;

export function buildPushRulesetRules(push: PushProtection): any[] {
  const rules: any[] = [];

  if (push.filePathRestriction && push.filePathRestriction.restrictedFilePaths.length > 0) {
    rules.push({
      type: "file_path_restriction",
      parameters: {
        restricted_file_paths: push.filePathRestriction.restrictedFilePaths,
      },
    });
  }

  if (push.maxFilePathLength && push.maxFilePathLength > 0) {
    rules.push({
      type: "max_file_path_length",
      parameters: { max_file_path_length: push.maxFilePathLength },
    });
  }

  if (push.maxFileSize && push.maxFileSize > 0) {
    rules.push({
      type: "max_file_size",
      parameters: { max_file_size: push.maxFileSize },
    });
  }

  if (push.fileExtensionRestriction && push.fileExtensionRestriction.restrictedFileExtensions.length > 0) {
    rules.push({
      type: "file_extension_restriction",
      parameters: {
        restricted_file_extensions: push.fileExtensionRestriction.restrictedFileExtensions,
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

export async function renameBranch(octokit: Octokit, repo: string, branch: string, newName: string): Promise<void> {
  const org = getOrg();

  await octokit.rest.repos.renameBranch({
    owner: org,
    repo,
    branch,
    new_name: newName,
  });
}

/**
 * Try to create a repo ruleset, automatically retrying without rules that
 * the org's GitHub plan doesn't support (e.g. code_quality, copilot_code_review).
 */
export async function createRulesetWithFallback(
  octokit: Octokit,
  owner: string,
  repo: string,
  params: {
    name: string;
    target: string;
    enforcement: string;
    bypass_actors: any[];
    conditions?: any;
    rules: any[];
  }
): Promise<{ data: any; skippedRules: string[] }> {
  let rules = [...params.rules];
  const skippedRules: string[] = [];
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data } = await octokit.rest.repos.createRepoRuleset({
        owner,
        repo,
        name: params.name,
        target: params.target as any,
        enforcement: params.enforcement as any,
        bypass_actors: params.bypass_actors,
        ...(params.conditions && Object.keys(params.conditions).length > 0 ? { conditions: params.conditions } : {}),
        rules,
      });
      if (skippedRules.length > 0) {
        console.warn(`[createRulesetWithFallback] Created ruleset "${params.name}" after skipping unsupported rules: ${skippedRules.join(", ")}`);
      }
      return { data, skippedRules };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || "";
      const match = msg.match(/\/rules\/(\d+)/);
      if (match && attempt < MAX_RETRIES && rules.length > 1) {
        const idx = parseInt(match[1], 10);
        if (idx >= 0 && idx < rules.length) {
          const removed = rules[idx];
          skippedRules.push(removed.type || `unknown(index ${idx})`);
          console.warn(`[createRulesetWithFallback] Rule "${removed.type}" at index ${idx} not supported — removing and retrying`);
          rules = rules.filter((_, i) => i !== idx);
          continue;
        }
      }
      throw err;
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new Error("createRulesetWithFallback: max retries exceeded");
}

export async function protectBranch(
  octokit: Octokit,
  repo: string,
  branch: string,
  protection: NonNullable<import("./templateService").BranchRule["protection"]>
): Promise<{ rulesetId?: number }> {
  const org = getOrg();

  if (protection.type === "ruleset") {
    const rules: any[] = buildRulesetRules(protection);

    let bypassActors: any[];
    if (protection.bypassActors && protection.bypassActors.length > 0) {
      bypassActors = protection.bypassActors;
    } else if (protection.enforceAdmins) {
      bypassActors = [];
    } else {
      bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
    }

    const { data: created, skippedRules } = await createRulesetWithFallback(octokit, org, repo, {
      name: protection.rulesetName || `Ruleset for ${branch}`,
      target: "branch",
      enforcement: (protection.enforcement as any) || "active",
      bypass_actors: bypassActors,
      conditions: {
        ref_name: {
          include: [`refs/heads/${branch}`],
          exclude: [],
        },
      },
      rules,
    });
    if (skippedRules.length > 0) {
      console.warn(`[protectBranch] Skipped unsupported rules for ${repo}/${branch}: ${skippedRules.join(", ")}`);
    }
    return { rulesetId: created.id };
  } else {
    const restrictions = protection.restrictPushes
      ? {
          users: protection.pushRestrictionUsers || [],
          teams: protection.pushRestrictionTeams || [],
          apps: protection.pushRestrictionApps || [],
        }
      : null;

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
      restrictions,
      required_linear_history: protection.requireLinearHistory,
      allow_force_pushes: !protection.preventForcePush,
      allow_deletions: !protection.preventDeletion,
      required_conversation_resolution: protection.requireConversationResolution,
      required_signatures: protection.requireSignedCommits,
    });

    if (protection.restrictPushes && protection.restrictMatchingBranchCreation) {
      try {
        await (octokit as any).request("POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions", {
          owner: org,
          repo,
          branch,
        });
      } catch { /* restrict matching branch creation may not be available */ }
    }
    return {};
  }
}

function deepSortedJson(obj: any): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(deepSortedJson).join(",")}]`;
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${deepSortedJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

function normalizeRules(rules: any[]): any[] {
  return [...rules]
    .map((r: any) => ({ type: r.type, ...(r.parameters ? { parameters: r.parameters } : {}) }))
    .sort((a: any, b: any) => (a.type || "").localeCompare(b.type || ""));
}

function normalizeBypass(actors: any[]): any[] {
  return [...(actors || [])]
    .map((a: any) => ({ actor_id: a.actor_id, actor_type: a.actor_type, bypass_mode: a.bypass_mode }))
    .sort((a: any, b: any) => `${a.actor_type}-${a.actor_id}`.localeCompare(`${b.actor_type}-${b.actor_id}`));
}

const PARAM_LABELS: Record<string, string> = {
  required_approving_review_count: "Required approvals",
  dismiss_stale_reviews_on_push: "Dismiss stale reviews",
  require_code_owner_review: "Code owner review",
  require_last_push_approval: "Last push approval",
  required_review_thread_resolution: "Conversation resolution",
  allowed_merge_methods: "Allowed merge methods",
  strict_required_status_checks_policy: "Strict status checks",
  do_not_enforce_on_create: "Don't enforce on create",
  required_status_checks: "Status check contexts",
  update_allows_fetch_and_merge: "Allow fetch and merge",
  required_deployment_environments: "Deployment environments",
  code_scanning_tools: "Code scanning tools",
};

function fmtParam(v: any): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "None" : JSON.stringify(v);
  return JSON.stringify(v);
}

export function compareRulesetConfigs(
  existing: any,
  templateRules: any[],
  templateBypass: any[],
  templateEnforcement: string
): string[] {
  const diffs: string[] = [];

  const exRulesMap = new Map<string, any>();
  for (const r of normalizeRules(existing.rules || [])) exRulesMap.set(r.type, r.parameters || {});

  const tmplRulesMap = new Map<string, any>();
  for (const r of normalizeRules(templateRules)) tmplRulesMap.set(r.type, r.parameters || {});

  for (const [t] of tmplRulesMap) {
    if (!exRulesMap.has(t)) diffs.push(`Template adds rule "${t}" not in existing ruleset`);
  }
  for (const [t] of exRulesMap) {
    if (!tmplRulesMap.has(t)) diffs.push(`Existing ruleset has rule "${t}" not in template`);
  }

  for (const [t, tmplParams] of tmplRulesMap) {
    if (!exRulesMap.has(t)) continue;
    const exParams = exRulesMap.get(t) || {};
    for (const key of Object.keys(tmplParams)) {
      if (deepSortedJson(tmplParams[key]) !== deepSortedJson(exParams[key])) {
        const label = PARAM_LABELS[key] || key;
        diffs.push(`${label}: ${fmtParam(exParams[key])} → ${fmtParam(tmplParams[key])}`);
      }
    }
  }

  if ((existing.enforcement || "active") !== templateEnforcement) {
    diffs.push(`Enforcement: ${existing.enforcement || "active"} → ${templateEnforcement}`);
  }

  const exBypass = normalizeBypass(existing.bypass_actors || []);
  const tmplBypass = normalizeBypass(templateBypass);
  if (deepSortedJson(exBypass) !== deepSortedJson(tmplBypass)) {
    diffs.push(`Bypass actors differ (existing: ${exBypass.length}, template: ${tmplBypass.length})`);
  }

  return diffs;
}

export function compareClassicConfigs(existing: any, templateProtection: Protection): string[] {
  const diffs: string[] = [];

  const exAdmin = existing.enforce_admins?.enabled ?? existing.enforce_admins ?? false;
  if (!!exAdmin !== !!templateProtection.enforceAdmins) {
    diffs.push(`Enforce admins differs: existing=${exAdmin}, template=${templateProtection.enforceAdmins}`);
  }

  const exPr = existing.required_pull_request_reviews;
  if (templateProtection.requirePr && !exPr) {
    diffs.push("Template requires pull requests, existing does not");
  } else if (!templateProtection.requirePr && exPr) {
    diffs.push("Existing requires pull requests, template does not");
  } else if (templateProtection.requirePr && exPr) {
    if ((exPr.required_approving_review_count ?? 0) !== templateProtection.requiredApprovals) {
      diffs.push(`Required approvals differ: existing=${exPr.required_approving_review_count}, template=${templateProtection.requiredApprovals}`);
    }
    if (!!exPr.dismiss_stale_reviews !== !!templateProtection.dismissStaleReviews) {
      diffs.push("Dismiss stale reviews setting differs");
    }
    if (!!exPr.require_code_owner_reviews !== !!templateProtection.requireCodeOwnerReviews) {
      diffs.push("Code owner reviews setting differs");
    }
    if (exPr.dismissal_restrictions && Object.keys(exPr.dismissal_restrictions).length > 0) {
      const hasUsers = exPr.dismissal_restrictions.users?.length > 0;
      const hasTeams = exPr.dismissal_restrictions.teams?.length > 0;
      if (hasUsers || hasTeams) diffs.push("Existing has dismissal restrictions that template doesn't specify");
    }
  }

  const exChecks = existing.required_status_checks;
  if (templateProtection.requireStatusChecks && !exChecks) {
    diffs.push("Template requires status checks, existing does not");
  } else if (!templateProtection.requireStatusChecks && exChecks) {
    diffs.push("Existing requires status checks, template does not");
  } else if (templateProtection.requireStatusChecks && exChecks) {
    if (!!exChecks.strict !== !!templateProtection.strictStatusChecks) {
      diffs.push("Strict status checks setting differs");
    }
  }

  const exLinear = existing.required_linear_history?.enabled ?? false;
  if (!!exLinear !== !!templateProtection.requireLinearHistory) {
    diffs.push("Required linear history setting differs");
  }

  const exForcePush = existing.allow_force_pushes?.enabled ?? false;
  if (exForcePush === templateProtection.preventForcePush) {
    diffs.push("Force push setting differs");
  }

  const exDeletion = existing.allow_deletions?.enabled ?? false;
  if (exDeletion === templateProtection.preventDeletion) {
    diffs.push("Branch deletion setting differs");
  }

  const exConvo = existing.required_conversation_resolution?.enabled ?? false;
  if (!!exConvo !== !!templateProtection.requireConversationResolution) {
    diffs.push("Required conversation resolution setting differs");
  }

  const exSigned = existing.required_signatures?.enabled ?? false;
  if (!!exSigned !== !!templateProtection.requireSignedCommits) {
    diffs.push("Required signed commits setting differs");
  }

  const exRestrictions = existing.restrictions;
  if (exRestrictions && !templateProtection.restrictPushes) {
    const hasActors = (exRestrictions.users?.length || 0) + (exRestrictions.teams?.length || 0) + (exRestrictions.apps?.length || 0) > 0;
    if (hasActors) diffs.push("Existing has push restrictions that template doesn't specify");
  }

  return diffs;
}

export async function getRuleset(octokit: Octokit, repo: string, rulesetId: number): Promise<any> {
  const org = getOrg();
  const { data } = await octokit.rest.repos.getRepoRuleset({ owner: org, repo, ruleset_id: rulesetId });
  return data;
}

export async function listRulesets(octokit: Octokit, repo: string): Promise<any[]> {
  const org = getOrg();
  const all: any[] = [];
  try {
    let page = 1;
    for (;;) {
      const { data } = await octokit.rest.repos.getRepoRulesets({
        owner: org,
        repo,
        per_page: 100,
        page,
        includes_parents: false,
      });
      if (!Array.isArray(data)) break;
      all.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return all;
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
