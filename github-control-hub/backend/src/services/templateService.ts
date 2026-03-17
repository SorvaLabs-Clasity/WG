import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { logActivity } from "./activityService";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand } from "../utils/dynamo";
import { buildRulesetRules, buildTagRulesetRules, buildPushRulesetRules, listRulesets, getRuleset, getProtection, compareRulesetConfigs, compareClassicConfigs, createRulesetWithFallback } from "./branchService";

export interface ConflictItem {
  type: "ruleset" | "classic";
  repo: string;
  name: string;
  existingId?: number;
  existingConfig: any;
  templateConfig: any;
  differences: string[];
  activityId?: string;
}

/** Extract a readable message from a GitHub API error (Octokit). */
function githubErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { message?: string; errors?: unknown[] } }; message?: string };
  const msg = e.response?.data?.message ?? e.message ?? "Unknown error";
  const details = e.response?.data?.errors;
  if (Array.isArray(details) && details.length > 0) {
    return `${msg} — ${JSON.stringify(details)}`;
  }
  return msg;
}

export type OnBaseBranchMissing = "skip_rule" | "use_default" | "undo_repo";

export interface BranchRule {
  branchNames: string[];
  /** When true (default), create branches that don't exist. When false, only apply protection to branches that already exist. */
  createBranchesIfMissing?: boolean;
  baseBranchMode?: "default" | "specific";
  baseBranch?: string;
  onBaseBranchMissing?: OnBaseBranchMissing;
  protection: {
    type: "classic" | "ruleset" | "ruleset_json";
    rawJson?: any;
    rulesetName?: string;
    enforcement?: "active" | "evaluate" | "disabled";

    restrictCreations?: boolean;
    restrictUpdates?: boolean;

    requirePr: boolean;
    requiredApprovals: number;
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
    requireLastPushApproval?: boolean;
    requireConversationResolution: boolean;
    allowedMergeMethods?: string[];

    requireStatusChecks: boolean;
    strictStatusChecks: boolean;
    doNotRequireStatusChecksOnCreation?: boolean;
    statusCheckContexts?: string[];

    requireDeployments?: boolean;
    requiredDeploymentEnvironments?: string[];

    requireSignedCommits: boolean;
    requireLinearHistory: boolean;
    enforceAdmins: boolean;
    preventForcePush: boolean;
    preventDeletion: boolean;

    requireCodeScanning?: boolean;
    codeScanningTool?: string;
    codeScanningAlertsThreshold?: string;
    codeScanningSecurityAlertsThreshold?: string;

    requireCodeQuality?: boolean;
    codeQualitySeverity?: string;

    copilotCodeReview?: boolean;
    copilotReviewOnPush?: boolean;
    copilotReviewDraftPrs?: boolean;

    bypassActors?: Array<{
      actor_id: number;
      actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
      bypass_mode: "always" | "pull_request";
    }>;

    restrictPushes?: boolean;
    restrictMatchingBranchCreation?: boolean;
    pushRestrictionUsers?: string[];
    pushRestrictionTeams?: string[];
    pushRestrictionApps?: string[];
  } | null;
}

export interface TagRule {
  tagPatterns: string[];
  rulesetName?: string;
  enforcement?: "active" | "evaluate" | "disabled";
  preventCreation?: boolean;
  preventUpdate?: boolean;
  preventDeletion?: boolean;
  preventForcePush?: boolean;
  requireSignedCommits?: boolean;
  rawJson?: any;
  namePattern?: {
    operator: "starts_with" | "ends_with" | "contains" | "regex";
    pattern: string;
    negate?: boolean;
    name?: string;
  };
  bypassActors?: Array<{
    actor_id: number;
    actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
    bypass_mode: "always" | "pull_request";
  }>;
}

export interface PushRule {
  rulesetName?: string;
  enforcement?: "active" | "evaluate" | "disabled";
  filePathRestriction?: {
    restrictedFilePaths: string[];
  };
  maxFilePathLength?: number;
  maxFileSize?: number;
  fileExtensionRestriction?: {
    restrictedFileExtensions: string[];
  };
  rawJson?: any;
  bypassActors?: Array<{
    actor_id: number;
    actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
    bypass_mode: "always" | "pull_request";
  }>;
}

export interface RepoTemplate {
  id: string;
  name: string;
  description: string;
  branches: BranchRule[];
  tags?: TagRule[];
  pushRules?: PushRule[];
  autoApplyOnNewRepo: boolean;
  exclusionLists?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TABLE = () => tableName("TEMPLATES_TABLE");

// In-memory fallback for local development
const memTemplates: Map<string, RepoTemplate> = new Map();

export async function listTemplates(): Promise<RepoTemplate[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return ((result.Items || []) as RepoTemplate[]).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  return Array.from(memTemplates.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getTemplate(id: string): Promise<RepoTemplate | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    return result.Item as RepoTemplate | undefined;
  }
  return memTemplates.get(id);
}

export async function putTemplateRaw(template: RepoTemplate): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: template }));
  } else {
    memTemplates.set(template.id, template);
  }
}

export async function deleteTemplateRaw(id: string): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memTemplates.delete(id);
  }
}

export async function createTemplate(
  data: Omit<RepoTemplate, "id" | "createdAt" | "updatedAt">,
  actor: string
): Promise<RepoTemplate> {
  const now = new Date().toISOString();
  const template: RepoTemplate = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: template }));
  } else {
    memTemplates.set(template.id, template);
  }

  await logActivity("template.create", actor, "*", template.name, `Created template "${template.name}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "delete_template", params: { templateId: template.id, templateData: template } } }
  );
  return template;
}

export async function updateTemplate(
  id: string,
  data: Partial<Omit<RepoTemplate, "id" | "createdAt" | "updatedAt">>,
  actor: string,
  exclusionNameMap?: Map<string, string>
): Promise<RepoTemplate | null> {
  const existing = await getTemplate(id);
  if (!existing) return null;

  const updated: RepoTemplate = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memTemplates.set(id, updated);
  }

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
  if (data.exclusionLists !== undefined && JSON.stringify(data.exclusionLists) !== JSON.stringify(existing.exclusionLists)) {
    const resolveNames = (ids: string[] | undefined) =>
      (ids || []).map(id => exclusionNameMap?.get(id) || id);
    diff.exclusionLists = { old: resolveNames(existing.exclusionLists), new: resolveNames(data.exclusionLists as string[]) };
  }
  if (data.tags !== undefined && JSON.stringify(data.tags) !== JSON.stringify(existing.tags)) {
    diff.tags = { old: existing.tags || [], new: data.tags };
  }
  if (data.pushRules !== undefined && JSON.stringify(data.pushRules) !== JSON.stringify(existing.pushRules)) {
    diff.pushRules = { old: existing.pushRules || [], new: data.pushRules };
  }

  await logActivity(
    "template.update", 
    actor, 
    "*", 
    updated.name, 
    `Updated template "${updated.name}"`,
    Object.keys(diff).length > 0 ? diff : undefined,
    "app", undefined, undefined,
    { undoPayload: { action: "revert_template", params: { templateId: id, previousState: existing, currentState: updated } } }
  );

  return updated;
}

export async function deleteTemplate(id: string, actor: string): Promise<boolean> {
  const existing = await getTemplate(id);
  if (!existing) return false;

  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memTemplates.delete(id);
  }

  await logActivity("template.delete", actor, "*", existing.name, `Deleted template "${existing.name}"`, undefined, "app", undefined, undefined, {
    undoPayload: { action: "restore_template", params: { templateData: existing } },
  });
  return true;
}

export async function applyTemplate(
  octokit: Octokit,
  templateId: string,
  repo: string,
  actor: string,
  repoParentId?: string
): Promise<{ created: string[]; protected: string[]; errors: string[]; conflicts: ConflictItem[]; templateName: string }> {
  const template = await getTemplate(templateId);
  if (!template) throw new Error("Template not found");

  const org = getOrg();
  const created: string[] = [];
  const protectedBranches: string[] = [];
  const errors: string[] = [];
  const conflicts: ConflictItem[] = [];

  let defaultSha: string;
  let defaultBranch = "main";
  try {
    const { data: repoData } = await octokit.rest.repos.get({ owner: org, repo });
    defaultBranch = repoData.default_branch || "main";

    try {
      const { data: ref } = await octokit.rest.git.getRef({
        owner: org,
        repo,
        ref: `heads/${defaultBranch}`,
      });
      defaultSha = ref.object.sha;
    } catch {
      // Empty repo — create initial README using the Contents API (works on completely empty repos)
      let initSha: string | null = null;
      for (let initAttempt = 0; initAttempt < 3; initAttempt++) {
        try {
          const { data: fileResult } = await octokit.rest.repos.createOrUpdateFileContents({
            owner: org,
            repo,
            path: "README.md",
            message: "Initial commit",
            content: Buffer.from(`# ${repo}\n`).toString("base64"),
          });
          initSha = fileResult.commit.sha!;
          break;
        } catch (initErr) {
          console.warn(`[applyTemplate] Empty repo init attempt ${initAttempt + 1}/3 failed for "${repo}": ${(initErr as Error).message}`);
          if (initAttempt < 2) await new Promise(r => setTimeout(r, 3000));
        }
      }
      if (!initSha) throw new Error(`Failed to initialize empty repo "${repo}" after 3 attempts`);
      defaultSha = initSha;
    }
  } catch (err) {
    throw new Error(`Failed to read repo default branch: ${(err as Error).message}`);
  }

  const rulesetGroups = new Map<number, { branchNames: string[]; protection: NonNullable<BranchRule["protection"]> }>();
  let abortRepo = false;

  for (let i = 0; i < template.branches.length; i++) {
    if (abortRepo) break;
    const rule = template.branches[i];

    // Resolve the SHA to use when creating new branches for this rule
    let ruleSha = defaultSha;
    let ruleBaseName = defaultBranch;
    let skipThisRule = false;

    if (rule.baseBranchMode === "specific" && rule.baseBranch) {
      try {
        const { data: ref } = await octokit.rest.git.getRef({ owner: org, repo, ref: `heads/${rule.baseBranch}` });
        ruleSha = ref.object.sha;
        ruleBaseName = rule.baseBranch;
      } catch {
        const fallback = rule.onBaseBranchMissing || "use_default";
        const msg = `Base branch "${rule.baseBranch}" not found in ${repo}`;
        console.warn(`[applyTemplate] ${msg}, fallback=${fallback}`);

        if (fallback === "skip_rule") {
          errors.push(`${msg} — skipped rule`);
          if (repoParentId) {
            await logActivity("branch.create", actor, repo, rule.branchNames.join(", "),
              `Skipped rule: base branch "${rule.baseBranch}" not found`,
              undefined, "app", undefined, undefined,
              { parentId: repoParentId, failed: true, errorMessage: msg }
            );
          }
          skipThisRule = true;
        } else if (fallback === "undo_repo") {
          errors.push(`${msg} — aborting and undoing repo`);
          if (repoParentId) {
            await logActivity("branch.create", actor, repo, rule.branchNames.join(", "),
              `Aborted: base branch "${rule.baseBranch}" not found — undoing all changes on ${repo}`,
              undefined, "app", undefined, undefined,
              { parentId: repoParentId, failed: true, errorMessage: msg }
            );
          }
          // Undo everything created so far on this repo
          for (const b of [...created].reverse()) {
            try { await octokit.rest.git.deleteRef({ owner: org, repo, ref: `heads/${b}` }); } catch { /* best effort */ }
          }
          for (const b of [...protectedBranches].reverse()) {
            try { await octokit.rest.repos.deleteBranchProtection({ owner: org, repo, branch: b }); } catch { /* best effort */ }
          }
          created.length = 0;
          protectedBranches.length = 0;
          rulesetGroups.clear();
          abortRepo = true;
          continue;
        }
        // fallback === "use_default": ruleSha already set to defaultSha
      }
    }

    if (skipThisRule) continue;

    const createBranchesIfMissing = rule.createBranchesIfMissing !== false;
    const effectiveBranchNames: string[] = [];

    for (const branchName of rule.branchNames) {
      try {
        await octokit.rest.git.getRef({ owner: org, repo, ref: `heads/${branchName}` });
        effectiveBranchNames.push(branchName);
      } catch {
        if (createBranchesIfMissing) {
          try {
            await octokit.rest.git.createRef({
              owner: org,
              repo,
              ref: `refs/heads/${branchName}`,
              sha: ruleSha,
            });
            created.push(branchName);
            effectiveBranchNames.push(branchName);
            if (repoParentId) {
              await logActivity("branch.create", actor, repo, branchName,
                `Created branch "${branchName}" (from ${ruleBaseName}) via template "${template.name}"`,
                undefined, "app", undefined, undefined,
                { parentId: repoParentId, undoPayload: { action: "delete_branch", params: { repo, branch: branchName, baseBranch: ruleBaseName } } }
              );
            }
          } catch (err) {
            const msg = `Create branch ${branchName}: ${githubErrorMessage(err)}`;
            console.error("[applyTemplate]", msg);
            errors.push(msg);
            if (repoParentId) {
              await logActivity("branch.create", actor, repo, branchName,
                `Failed to create branch "${branchName}" via template "${template.name}"`,
                undefined, "app", undefined, undefined,
                { parentId: repoParentId, failed: true, errorMessage: githubErrorMessage(err),
                  retryPayload: { action: "create_branch", params: { repo, branch: branchName, baseBranch: ruleBaseName } } }
              );
            }
            continue;
          }
        }
      }
    }

    if (rule.protection) {
      if (rule.protection.type === "ruleset" || rule.protection.type === "ruleset_json") {
        if (!rulesetGroups.has(i)) {
          rulesetGroups.set(i, { branchNames: [], protection: rule.protection });
        }
        rulesetGroups.get(i)!.branchNames.push(...effectiveBranchNames);
      } else {
        for (const branchName of effectiveBranchNames) {
          try {
            const existingProt = await getProtection(octokit, repo, branchName);
            if (existingProt) {
              const diffs = compareClassicConfigs(existingProt, rule.protection as any);
              if (diffs.length === 0) {
                protectedBranches.push(branchName);
                continue;
              }
              const conflictEntry = repoParentId ? await logActivity(
                "conflict.pending" as any, actor, repo, branchName,
                `Conflict: Classic protection on "${branchName}" already exists with different settings`,
                undefined, "app", undefined, undefined,
                { parentId: repoParentId, conflictPayload: { type: "classic", repo, name: branchName, existingConfig: existingProt, templateConfig: rule.protection, differences: diffs } } as any
              ) : undefined;
              conflicts.push({ type: "classic", repo, name: branchName, existingConfig: existingProt, templateConfig: rule.protection, differences: diffs, activityId: conflictEntry?.id });
              continue;
            }

            const classicRestrictions = rule.protection.restrictPushes
              ? {
                  users: rule.protection.pushRestrictionUsers || [],
                  teams: rule.protection.pushRestrictionTeams || [],
                  apps: rule.protection.pushRestrictionApps || [],
                }
              : { users: [], teams: [], apps: [] };

            await octokit.rest.repos.updateBranchProtection({
              owner: org,
              repo,
              branch: branchName,
              required_status_checks: rule.protection.requireStatusChecks
                ? {
                    strict: rule.protection.strictStatusChecks,
                    contexts: [],
                  }
                : null,
              enforce_admins: rule.protection.enforceAdmins,
              required_pull_request_reviews: rule.protection.requirePr
                ? {
                    required_approving_review_count: rule.protection.requiredApprovals,
                    dismiss_stale_reviews: rule.protection.dismissStaleReviews,
                    require_code_owner_reviews: rule.protection.requireCodeOwnerReviews,
                    dismissal_restrictions: {},
                  }
                : null,
              restrictions: classicRestrictions,
              required_linear_history: rule.protection.requireLinearHistory,
              allow_force_pushes: !rule.protection.preventForcePush,
              allow_deletions: !rule.protection.preventDeletion,
              required_conversation_resolution: rule.protection.requireConversationResolution,
              required_signatures: rule.protection.requireSignedCommits,
            });
            protectedBranches.push(branchName);
            if (repoParentId) {
              await logActivity("branch.protect", actor, repo, branchName,
                `Applied classic protection to "${branchName}" via template "${template.name}"`,
                undefined, "app", undefined, undefined,
                { parentId: repoParentId, undoPayload: { action: "delete_protection", params: { repo, branch: branchName, protectionConfig: rule.protection } } }
              );
            }
          } catch (err) {
            const msg = `Classic protection ${branchName}: ${githubErrorMessage(err)}`;
            console.error("[applyTemplate]", msg);
            errors.push(msg);
            if (repoParentId) {
              await logActivity("branch.protect", actor, repo, branchName,
                `Failed to apply classic protection to "${branchName}" via template "${template.name}"`,
                undefined, "app", undefined, undefined,
                { parentId: repoParentId, failed: true, errorMessage: githubErrorMessage(err),
                  retryPayload: { action: "apply_protection", params: { repo, branch: branchName, protectionConfig: rule.protection } } }
              );
            }
          }
        }
      }
    }
  }

  let existingRulesets: any[] | undefined;
  if (!abortRepo && rulesetGroups.size > 0) {
    try { existingRulesets = await listRulesets(octokit, repo); } catch { existingRulesets = []; }
  }

  for (const { branchNames, protection } of abortRepo ? [] : rulesetGroups.values()) {
    try {
      const rulesetName = protection.rulesetName || (protection.type === "ruleset_json" && protection.rawJson?.name) || `Template Ruleset (${branchNames.join(", ")})`;

      const nameMatch = (existingRulesets || []).find((r: any) => r.name === rulesetName);
      if (nameMatch) {
        let fullExisting: any;
        try { fullExisting = await getRuleset(octokit, repo, nameMatch.id); } catch { /* skip comparison if fetch fails */ }

        if (fullExisting) {
          const tmplRules = buildRulesetRules(protection as any);
          let tmplBypass: any[];
          if (protection.bypassActors && protection.bypassActors.length > 0) {
            tmplBypass = protection.bypassActors;
          } else if (protection.enforceAdmins) {
            tmplBypass = [];
          } else {
            tmplBypass = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
          }
          const tmplEnforcement = protection.enforcement || "active";
          const diffs = compareRulesetConfigs(fullExisting, tmplRules, tmplBypass, tmplEnforcement);

          if (diffs.length === 0) {
            protectedBranches.push(...branchNames);
            continue;
          }

          const conflictEntry = repoParentId ? await logActivity(
            "conflict.pending" as any, actor, repo, rulesetName,
            `Conflict: Ruleset "${rulesetName}" already exists with different settings`,
            undefined, "app", undefined, undefined,
            { parentId: repoParentId, conflictPayload: { type: "ruleset", repo, name: rulesetName, existingId: nameMatch.id, existingConfig: fullExisting, templateConfig: protection, differences: diffs } } as any
          ) : undefined;
          conflicts.push({ type: "ruleset", repo, name: rulesetName, existingId: nameMatch.id, existingConfig: fullExisting, templateConfig: protection, differences: diffs, activityId: conflictEntry?.id });
          continue;
        }
      }

      let createdRulesetId: number | undefined;
      if (protection.type === "ruleset_json" && protection.rawJson) {
        const { id, source, source_type, node_id, _links, ...payload } = protection.rawJson;
        const customPayload = {
          ...payload,
          name: protection.rulesetName || payload.name || `Template Ruleset (${branchNames.join(", ")})`,
          conditions: {
            ref_name: {
              include: branchNames.map((b) => `refs/heads/${b}`),
              exclude: [],
            },
          },
        };
        const { data: created } = await octokit.rest.repos.createRepoRuleset({
          owner: org,
          repo,
          ...customPayload,
        });
        createdRulesetId = created.id;
      } else {
        const rules: any[] = buildRulesetRules(protection);

        if (rules.length === 0) {
          rules.push({ type: "pull_request", parameters: { required_approving_review_count: 0 } });
        }

        let bypassActors: any[];
        if (protection.bypassActors && protection.bypassActors.length > 0) {
          bypassActors = protection.bypassActors;
        } else if (protection.enforceAdmins) {
          bypassActors = [];
        } else {
          bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
        }

        const { data: created, skippedRules } = await createRulesetWithFallback(octokit, org, repo, {
          name: protection.rulesetName || `Template Ruleset (${branchNames.join(", ")})`,
          target: "branch",
          enforcement: (protection.enforcement as any) || "active",
          bypass_actors: bypassActors,
          conditions: {
            ref_name: {
              include: branchNames.map((b) => `refs/heads/${b}`),
              exclude: [],
            },
          },
          rules,
        });
        createdRulesetId = created.id;
        if (skippedRules.length > 0) {
          errors.push(`Skipped unsupported rule(s) for ruleset "${protection.rulesetName || "Template Ruleset"}": ${skippedRules.join(", ")}`);
        }
      }
      protectedBranches.push(...branchNames);
      if (repoParentId) {
        const rulesetName = protection.rulesetName || `Template Ruleset (${branchNames.join(", ")})`;
        await logActivity("repo.ruleset.create" as any, actor, repo, rulesetName,
          `Created ruleset "${rulesetName}" for branches [${branchNames.join(", ")}] via template "${template.name}"`,
          undefined, "app", undefined, undefined,
          { parentId: repoParentId, undoPayload: { action: "delete_ruleset", params: { repo, rulesetId: createdRulesetId, protectionConfig: protection, branchNames } } }
        );
      }
    } catch (err) {
      const msg = `Ruleset [${branchNames.join(", ")}]: ${githubErrorMessage(err)}`;
      console.error("[applyTemplate]", msg);
      errors.push(msg);
      if (repoParentId) {
        const rulesetName = protection.rulesetName || `Template Ruleset (${branchNames.join(", ")})`;
        await logActivity("repo.ruleset.create" as any, actor, repo, rulesetName,
          `Failed to create ruleset "${rulesetName}" via template "${template.name}"`,
          undefined, "app", undefined, undefined,
          { parentId: repoParentId, failed: true, errorMessage: githubErrorMessage(err),
            retryPayload: { action: "create_ruleset", params: { repo, protectionConfig: protection, branchNames } } }
        );
      }
    }
  }

  /* ── Tag rulesets ── */
  const tagRules = template.tags || [];
  let existingTagRulesets: any[] = [];
  if (!abortRepo && tagRules.length > 0) {
    try {
      existingTagRulesets = await listRulesets(octokit, repo);
    } catch (listErr) {
      console.error(`[applyTemplate] Failed to list rulesets for ${repo}:`, listErr);
      existingTagRulesets = [];
    }
  }

  for (const tag of abortRepo ? [] : tagRules) {
    if (!tag.tagPatterns || tag.tagPatterns.length === 0) continue;

    try {
      const rulesetName = tag.rulesetName || (tag.rawJson?.name) || `Tag Ruleset (${tag.tagPatterns.join(", ")})`;

      const nameMatch = existingTagRulesets.find((r: any) => r.name === rulesetName);
      if (nameMatch) {
        let fullExisting: any;
        try {
          fullExisting = await getRuleset(octokit, repo, nameMatch.id);
        } catch {
          fullExisting = undefined;
        }

        let diffs: string[];
        if (fullExisting) {
          const tmplRules = tag.rawJson?.rules || buildTagRulesetRules(tag);
          const tmplBypass = (tag.bypassActors && tag.bypassActors.length > 0)
            ? tag.bypassActors.map((a: any) => ({ ...a, bypass_mode: "always" }))
            : [];
          const tmplEnforcement = tag.enforcement || "active";
          diffs = compareRulesetConfigs(fullExisting, tmplRules, tmplBypass, tmplEnforcement);

          if (diffs.length === 0) {
            continue;
          }
        } else {
          diffs = ["Existing tag ruleset could not be fetched; override will replace it with template."];
        }

        const existingConfigForConflict = fullExisting ?? { id: nameMatch.id, name: nameMatch.name };
        const conflictEntry = repoParentId ? await logActivity(
          "conflict.pending" as any, actor, repo, rulesetName,
          `Conflict: Tag ruleset "${rulesetName}" already exists with different settings`,
          undefined, "app", undefined, undefined,
          { parentId: repoParentId, conflictPayload: { type: "ruleset", repo, name: rulesetName, existingId: nameMatch.id, existingConfig: existingConfigForConflict, templateConfig: { ...tag, _isTagRuleset: true }, differences: diffs } } as any
        ) : undefined;
        conflicts.push({ type: "ruleset", repo, name: rulesetName, existingId: nameMatch.id, existingConfig: existingConfigForConflict, templateConfig: { ...tag, _isTagRuleset: true }, differences: diffs, activityId: conflictEntry?.id });
        continue;
      }

      let createdTagId: number;

      if (tag.rawJson) {
        const { id: _id, source: _s, source_type: _st, node_id: _n, _links: _l, created_at: _ca, updated_at: _ua, ...payload } = tag.rawJson;
        if (payload.bypass_actors) {
          payload.bypass_actors = payload.bypass_actors.map((a: any) => ({ ...a, bypass_mode: "always" }));
        }
        const { data: createdTag } = await octokit.rest.repos.createRepoRuleset({
          owner: org, repo, ...payload,
          name: rulesetName,
          target: "tag",
          conditions: { ref_name: { include: tag.tagPatterns.map((t: string) => `refs/tags/${t}`), exclude: [] } },
        });
        createdTagId = createdTag.id;
      } else {
        const rules = buildTagRulesetRules(tag);

        if (rules.length === 0) {
          rules.push({ type: "creation" });
        }

        const bypassActors = (tag.bypassActors && tag.bypassActors.length > 0)
          ? tag.bypassActors.map((a: any) => ({ ...a, bypass_mode: "always" }))
          : [];

        const { data: createdTag, skippedRules } = await createRulesetWithFallback(octokit, org, repo, {
          name: rulesetName,
          target: "tag",
          enforcement: (tag.enforcement as any) || "active",
          bypass_actors: bypassActors,
          conditions: {
            ref_name: {
              include: tag.tagPatterns.map((t) => `refs/tags/${t}`),
              exclude: [],
            },
          },
          rules,
        });
        createdTagId = createdTag.id;
        if (skippedRules.length > 0) {
          errors.push(`Skipped unsupported rule(s) for tag ruleset "${rulesetName}": ${skippedRules.join(", ")}`);
        }
      }

      if (repoParentId) {
        await logActivity("repo.ruleset.create" as any, actor, repo, rulesetName,
          `Created tag ruleset "${rulesetName}" for patterns [${tag.tagPatterns.join(", ")}] via template "${template.name}"`,
          undefined, "app", undefined, undefined,
          { parentId: repoParentId, undoPayload: { action: "delete_ruleset", params: { repo, rulesetId: createdTagId, tagRule: tag, tagPatterns: tag.tagPatterns } } }
        );
      }
    } catch (err) {
      const errMsg = githubErrorMessage(err);
      console.log(`[applyTemplate] Tag ruleset create failed: "${errMsg}"`);

      if (/unique/i.test(errMsg)) {
        console.log(`[applyTemplate] Detected name-uniqueness error, converting to conflict`);
        try {
          const rulesetName = tag.rulesetName || (tag.rawJson?.name) || `Tag Ruleset (${tag.tagPatterns.join(", ")})`;
          let freshList: any[] = [];
          try {
            freshList = await listRulesets(octokit, repo);
            console.log(`[applyTemplate] Fresh list has ${freshList.length} rulesets:`, freshList.map((r: any) => r?.name));
          } catch { /* ignore */ }

          const altName = `Tag Ruleset (${tag.tagPatterns.join(", ")})`;
          const nameMatch = Array.isArray(freshList)
            ? freshList.find((r: any) => r && (r.name === rulesetName || r.name === altName))
            : undefined;

          let conflictName = rulesetName;
          let existingId: number | undefined;
          let existingConfigForConflict: any = {};
          let diffs: string[] = ["A tag ruleset with this name already exists; override will delete it and apply the template."];

          if (nameMatch) {
            conflictName = nameMatch.name;
            existingId = nameMatch.id;
            let fullExisting: any;
            try { fullExisting = await getRuleset(octokit, repo, nameMatch.id); } catch { fullExisting = undefined; }
            if (fullExisting) {
              const tmplRules = tag.rawJson?.rules || buildTagRulesetRules(tag);
              const tmplBypass = (tag.bypassActors && tag.bypassActors.length > 0)
                ? tag.bypassActors.map((a: any) => ({ ...a, bypass_mode: "always" }))
                : [];
              diffs = compareRulesetConfigs(fullExisting, tmplRules, tmplBypass, tag.enforcement || "active");
              if (diffs.length === 0) diffs = ["Configs appear identical but GitHub rejected duplicate name."];
              existingConfigForConflict = fullExisting;
            } else {
              existingConfigForConflict = { id: nameMatch.id, name: nameMatch.name };
            }
          }

          let conflictActivityId: string | undefined;
          if (repoParentId) {
            try {
              const entry = await logActivity(
                "conflict.pending" as any, actor, repo, conflictName,
                `Conflict: Tag ruleset "${conflictName}" already exists`,
                undefined, "app", undefined, undefined,
                { parentId: repoParentId, conflictPayload: { type: "ruleset", repo, name: conflictName, existingId, existingConfig: existingConfigForConflict, templateConfig: { ...tag, _isTagRuleset: true }, differences: diffs } } as any
              );
              conflictActivityId = entry?.id;
            } catch (logErr) {
              console.error("[applyTemplate] Failed to log conflict activity:", logErr);
            }
          }
          conflicts.push({ type: "ruleset", repo, name: conflictName, existingId, existingConfig: existingConfigForConflict, templateConfig: { ...tag, _isTagRuleset: true }, differences: diffs, activityId: conflictActivityId });
          console.log(`[applyTemplate] Pushed tag ruleset conflict for "${conflictName}"`);
          continue;
        } catch (conflictErr) {
          console.error("[applyTemplate] Failed to create conflict from name-uniqueness error:", conflictErr);
        }
      }

      const msg = `Tag Ruleset [${tag.tagPatterns.join(", ")}]: ${errMsg}`;
      console.error("[applyTemplate]", msg);
      errors.push(msg);
      if (repoParentId) {
        const tagRulesetName = tag.rulesetName || `Tag Ruleset (${tag.tagPatterns.join(", ")})`;
        try {
          await logActivity("repo.ruleset.create" as any, actor, repo, tagRulesetName,
            `Failed to create tag ruleset "${tagRulesetName}" via template "${template.name}"`,
            undefined, "app", undefined, undefined,
            { parentId: repoParentId, failed: true, errorMessage: errMsg,
              retryPayload: { action: "create_tag_ruleset", params: { repo, tagRule: tag, tagPatterns: tag.tagPatterns } } }
          );
        } catch { /* ignore logging failure */ }
      }
    }
  }

  /* ── Push rulesets ── */
  const pushRules = template.pushRules || [];
  for (const push of abortRepo ? [] : pushRules) {
    try {
      const rulesetName = push.rulesetName || (push.rawJson?.name) || "Push Protection Ruleset";

      let createdPushId: number;

      if (push.rawJson) {
        const { id: _id, source: _s, source_type: _st, node_id: _n, _links: _l, created_at: _ca, updated_at: _ua, ...payload } = push.rawJson;
        const { data: createdPush } = await octokit.rest.repos.createRepoRuleset({
          owner: org, repo, ...payload,
          name: rulesetName,
          target: "push" as any,
        });
        createdPushId = createdPush.id;
      } else {
        const rules = buildPushRulesetRules(push);

        if (rules.length === 0) continue; // nothing to create

        const bypassActors = (push.bypassActors && push.bypassActors.length > 0)
          ? push.bypassActors
          : [];

        const { data: createdPush, skippedRules } = await createRulesetWithFallback(octokit, org, repo, {
          name: rulesetName,
          target: "push",
          enforcement: (push.enforcement as any) || "active",
          bypass_actors: bypassActors,
          conditions: {},
          rules,
        });
        createdPushId = createdPush.id;
        if (skippedRules.length > 0) {
          errors.push(`Skipped unsupported rule(s) for push ruleset "${rulesetName}": ${skippedRules.join(", ")}`);
        }
      }

      if (repoParentId) {
        await logActivity("repo.ruleset.create" as any, actor, repo, rulesetName,
          `Created push ruleset "${rulesetName}" via template "${template.name}"`,
          undefined, "app", undefined, undefined,
          { parentId: repoParentId, undoPayload: { action: "delete_ruleset", params: { repo, rulesetId: createdPushId } } }
        );
      }
    } catch (err) {
      const msg = `Push Ruleset: ${githubErrorMessage(err)}`;
      console.error("[applyTemplate]", msg);
      errors.push(msg);
      if (repoParentId) {
        const pushRulesetName = push.rulesetName || "Push Protection Ruleset";
        try {
          await logActivity("repo.ruleset.create" as any, actor, repo, pushRulesetName,
            `Failed to create push ruleset "${pushRulesetName}" via template "${template.name}"`,
            undefined, "app", undefined, undefined,
            { parentId: repoParentId, failed: true, errorMessage: githubErrorMessage(err) }
          );
        } catch { /* ignore logging failure */ }
      }
    }
  }

  return { created, protected: protectedBranches, errors, conflicts, templateName: template.name };
}
