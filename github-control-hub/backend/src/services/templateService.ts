import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { logActivity } from "./activityService";

export interface BranchRule {
  branchName: string;
  protection: {
    type: "classic" | "ruleset";
    requirePr: boolean;
    requiredApprovals: number;
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
    requireConversationResolution: boolean;
    requireStatusChecks: boolean;
    strictStatusChecks: boolean;
    requireSignedCommits: boolean;
    requireLinearHistory: boolean;
    enforceAdmins: boolean;
    preventForcePush: boolean;
    preventDeletion: boolean;
  } | null;
}

export interface RepoTemplate {
  id: string;
  name: string;
  description: string;
  branches: BranchRule[];
  autoApplyOnNewRepo: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory store. Swap for DynamoDB in production.
 */
const templates: Map<string, RepoTemplate> = new Map();

export function listTemplates(): RepoTemplate[] {
  return Array.from(templates.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getTemplate(id: string): RepoTemplate | undefined {
  return templates.get(id);
}

export function createTemplate(
  data: Omit<RepoTemplate, "id" | "createdAt" | "updatedAt">,
  actor: string
): RepoTemplate {
  const now = new Date().toISOString();
  const template: RepoTemplate = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  templates.set(template.id, template);

  logActivity("template.create", actor, "*", template.name, `Created template "${template.name}"`);

  return template;
}

export function updateTemplate(
  id: string,
  data: Partial<Omit<RepoTemplate, "id" | "createdAt" | "updatedAt">>,
  actor: string
): RepoTemplate | null {
  const existing = templates.get(id);
  if (!existing) return null;

  const updated: RepoTemplate = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  templates.set(id, updated);

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

  logActivity(
    "template.update", 
    actor, 
    "*", 
    updated.name, 
    `Updated template "${updated.name}"`,
    Object.keys(diff).length > 0 ? diff : undefined
  );

  return updated;
}

export function deleteTemplate(id: string, actor: string): boolean {
  const existing = templates.get(id);
  if (!existing) return false;

  templates.delete(id);
  logActivity("template.delete", actor, "*", existing.name, `Deleted template "${existing.name}"`);

  return true;
}

export async function applyTemplate(
  octokit: Octokit,
  templateId: string,
  repo: string,
  actor: string
): Promise<{ created: string[]; protected: string[]; errors: string[] }> {
  const template = templates.get(templateId);
  if (!template) throw new Error("Template not found");

  const org = getOrg();
  const created: string[] = [];
  const protectedBranches: string[] = [];
  const errors: string[] = [];

  // Get the default branch SHA to base new branches on
  let defaultSha: string;
  try {
    const { data: repoData } = await octokit.rest.repos.get({ owner: org, repo });
    const { data: ref } = await octokit.rest.git.getRef({
      owner: org,
      repo,
      ref: `heads/${repoData.default_branch}`,
    });
    defaultSha = ref.object.sha;
  } catch (err) {
    throw new Error(`Failed to read repo default branch: ${(err as Error).message}`);
  }

  // Group branches by their protection configuration to bundle rulesets
  const rulesetGroups = new Map<string, { branchNames: string[]; protection: NonNullable<BranchRule["protection"]> }>();

  for (const rule of template.branches) {
    // Create branch if it doesn't exist
    try {
      await octokit.rest.git.getRef({
        owner: org,
        repo,
        ref: `heads/${rule.branchName}`,
      });
      // Branch already exists, skip creation
    } catch {
      try {
        await octokit.rest.git.createRef({
          owner: org,
          repo,
          ref: `refs/heads/${rule.branchName}`,
          sha: defaultSha,
        });
        created.push(rule.branchName);
      } catch (err) {
        errors.push(`Failed to create ${rule.branchName}: ${(err as Error).message}`);
        continue;
      }
    }

    if (rule.protection) {
      if (rule.protection.type === "ruleset") {
        // Create a hash of the protection settings (excluding type) to group identical rules
        const { type, ...settings } = rule.protection;
        const hash = crypto.createHash("sha256").update(JSON.stringify(settings)).digest("hex");
        
        if (!rulesetGroups.has(hash)) {
          rulesetGroups.set(hash, { branchNames: [], protection: rule.protection });
        }
        rulesetGroups.get(hash)!.branchNames.push(rule.branchName);
      } else {
        // Classic protection gets applied individually
        try {
          await octokit.rest.repos.updateBranchProtection({
            owner: org,
            repo,
            branch: rule.branchName,
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
                }
              : null,
            restrictions: null,
            required_linear_history: rule.protection.requireLinearHistory,
            allow_force_pushes: !rule.protection.preventForcePush,
            allow_deletions: !rule.protection.preventDeletion,
            required_conversation_resolution: rule.protection.requireConversationResolution,
            required_signatures: rule.protection.requireSignedCommits,
          });
          protectedBranches.push(rule.branchName);
        } catch (err) {
          errors.push(`Failed to apply classic protection to ${rule.branchName}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Apply bundled rulesets
  for (const { branchNames, protection } of rulesetGroups.values()) {
    try {
      const rules: any[] = [];
      if (protection.preventDeletion) rules.push({ type: "deletion" });
      if (protection.preventForcePush) rules.push({ type: "non_fast_forward" });
      if (protection.requireLinearHistory) rules.push({ type: "required_linear_history" });
      if (protection.requireSignedCommits) rules.push({ type: "required_signatures" });
      
      if (protection.requirePr) {
        rules.push({
          type: "pull_request",
          parameters: {
            required_approving_review_count: protection.requiredApprovals,
            dismiss_stale_reviews_on_push: protection.dismissStaleReviews,
            require_code_owner_review: protection.requireCodeOwnerReviews,
            require_last_push_approval: false,
            required_review_thread_resolution: protection.requireConversationResolution,
          },
        });
      }
      
      if (protection.requireStatusChecks) {
        rules.push({
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: protection.strictStatusChecks,
            required_status_checks: [],
          },
        });
      }

      await octokit.rest.repos.createRepoRuleset({
        owner: org,
        repo,
        name: `Template Ruleset (${branchNames.join(', ')})`,
        target: "branch",
        enforcement: "active",
        bypass_actors: protection.enforceAdmins ? [] : [
          {
            actor_id: 1, // pseudo ID for repository admin
            actor_type: "RepositoryRole",
            bypass_mode: "always"
          }
        ],
        conditions: {
          ref_name: {
            include: branchNames.map(b => `refs/heads/${b}`),
            exclude: [],
          },
        },
        rules,
      });
      protectedBranches.push(...branchNames);
    } catch (err) {
      errors.push(`Failed to create ruleset for [${branchNames.join(', ')}]: ${(err as Error).message}`);
    }
  }

  logActivity(
    "template.apply",
    actor,
    repo,
    template.name,
    `Applied template "${template.name}" — created: [${created.join(", ")}], protected: [${protectedBranches.join(", ")}]`
  );

  return { created, protected: protectedBranches, errors };
}
