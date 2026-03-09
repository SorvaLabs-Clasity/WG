import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { logActivity } from "./activityService";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand } from "../utils/dynamo";

export interface BranchRule {
  branchNames: string[];
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

  await logActivity("template.create", actor, "*", template.name, `Created template "${template.name}"`);
  return template;
}

export async function updateTemplate(
  id: string,
  data: Partial<Omit<RepoTemplate, "id" | "createdAt" | "updatedAt">>,
  actor: string
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

  await logActivity(
    "template.update", 
    actor, 
    "*", 
    updated.name, 
    `Updated template "${updated.name}"`,
    Object.keys(diff).length > 0 ? diff : undefined
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

  await logActivity("template.delete", actor, "*", existing.name, `Deleted template "${existing.name}"`);
  return true;
}

export async function applyTemplate(
  octokit: Octokit,
  templateId: string,
  repo: string,
  actor: string
): Promise<{ created: string[]; protected: string[]; errors: string[] }> {
  const template = await getTemplate(templateId);
  if (!template) throw new Error("Template not found");

  const org = getOrg();
  const created: string[] = [];
  const protectedBranches: string[] = [];
  const errors: string[] = [];

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

  const rulesetGroups = new Map<number, { branchNames: string[]; protection: NonNullable<BranchRule["protection"]> }>();

  for (let i = 0; i < template.branches.length; i++) {
    const rule = template.branches[i];
    for (const branchName of rule.branchNames) {
      try {
        await octokit.rest.git.getRef({
          owner: org,
          repo,
          ref: `heads/${branchName}`,
        });
      } catch {
        try {
          await octokit.rest.git.createRef({
            owner: org,
            repo,
            ref: `refs/heads/${branchName}`,
            sha: defaultSha,
          });
          created.push(branchName);
        } catch (err) {
          const msg = `Failed to create ${branchName}: ${(err as Error).message}`;
          console.error("[applyTemplate]", msg);
          errors.push(msg);
          continue;
        }
      }
    }

    if (rule.protection) {
      if (rule.protection.type === "ruleset") {
        if (!rulesetGroups.has(i)) {
          rulesetGroups.set(i, { branchNames: [], protection: rule.protection });
        }
        rulesetGroups.get(i)!.branchNames.push(...rule.branchNames);
      } else {
        for (const branchName of rule.branchNames) {
          try {
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
                  }
                : null,
              restrictions: null,
              required_linear_history: rule.protection.requireLinearHistory,
              allow_force_pushes: !rule.protection.preventForcePush,
              allow_deletions: !rule.protection.preventDeletion,
              required_conversation_resolution: rule.protection.requireConversationResolution,
              required_signatures: rule.protection.requireSignedCommits,
            });
            protectedBranches.push(branchName);
          } catch (err) {
            const msg = `Failed to apply classic protection to ${branchName}: ${(err as Error).message}`;
            console.error("[applyTemplate]", msg);
            errors.push(msg);
          }
        }
      }
    }
  }

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
            actor_id: 1,
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
      const msg = `Failed to create ruleset for [${branchNames.join(', ')}]: ${(err as Error).message}`;
      console.error("[applyTemplate]", msg);
      errors.push(msg);
    }
  }

  await logActivity(
    "template.apply",
    actor,
    repo,
    template.name,
    `Applied template "${template.name}" — created: [${created.join(", ")}], protected: [${protectedBranches.join(", ")}]`
  );

  return { created, protected: protectedBranches, errors };
}
