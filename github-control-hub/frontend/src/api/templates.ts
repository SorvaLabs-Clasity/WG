import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
import {
  mockFetchTemplates,
  mockCreateTemplate,
  mockUpdateTemplate,
  mockDeleteTemplate,
  mockApplyTemplate,
} from "./mock";
import type { RepoTemplate, BranchRule, TagRule } from "../types/Template";

export function fetchTemplates(): Promise<RepoTemplate[]> {
  if (DEMO_MODE) return mockFetchTemplates();
  return apiGet<RepoTemplate[]>("/templates");
}

export function createTemplate(data: {
  name: string;
  description: string;
  branches: BranchRule[];
  tags?: TagRule[];
  autoApplyOnNewRepo: boolean;
  exclusionLists?: string[];
}): Promise<RepoTemplate> {
  if (DEMO_MODE) return mockCreateTemplate(data);
  return apiPost<RepoTemplate>("/templates", data);
}

export function updateTemplate(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    branches: BranchRule[];
    tags?: TagRule[];
    autoApplyOnNewRepo: boolean;
    exclusionLists?: string[];
  }>
): Promise<RepoTemplate> {
  if (DEMO_MODE) return mockUpdateTemplate(id, data);
  return apiPut<RepoTemplate>(`/templates/${id}`, data);
}

export function deleteTemplateApi(id: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteTemplate(id);
  return apiDelete<{ message: string }>(`/templates/${id}`);
}

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

function fmtVal(v: any): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length === 0 ? "None" : `${v.length} item(s)`;
  return String(v);
}

export interface ComparisonRow {
  label: string;
  existing: string;
  template: string;
}

export function buildConflictComparison(
  type: "ruleset" | "classic",
  existingConfig: any,
  templateConfig: any
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  if (type === "ruleset") {
    const isTag = !!templateConfig._isTagRuleset;
    const exRules = new Map<string, any>();
    for (const r of existingConfig.rules || []) exRules.set(r.type, r.parameters || {});

    rows.push({ label: "Enforcement", existing: existingConfig.enforcement || "active", template: templateConfig.enforcement || "active" });

    if (isTag) {
      rows.push({ label: "Restrict Creation", existing: fmtVal(exRules.has("creation")), template: fmtVal(!!templateConfig.preventCreation) });
      rows.push({ label: "Restrict Updates", existing: fmtVal(exRules.has("update")), template: fmtVal(!!templateConfig.preventUpdate) });
      rows.push({ label: "Prevent Deletion", existing: fmtVal(exRules.has("deletion")), template: fmtVal(!!templateConfig.preventDeletion) });
      rows.push({ label: "Block Force Push", existing: fmtVal(exRules.has("non_fast_forward")), template: fmtVal(!!templateConfig.preventForcePush) });
      rows.push({ label: "Signed Commits", existing: fmtVal(exRules.has("required_signatures")), template: fmtVal(!!templateConfig.requireSignedCommits) });

      const exPattern = exRules.get("tag_name_pattern");
      const tmplPattern = templateConfig.namePattern;
      if (exPattern || tmplPattern?.pattern) {
        rows.push({ label: "Name Pattern", existing: exPattern ? `${exPattern.operator}: ${exPattern.pattern}` : "—", template: tmplPattern?.pattern ? `${tmplPattern.operator}: ${tmplPattern.pattern}` : "—" });
      }

      const supported = new Set(["creation", "update", "deletion", "non_fast_forward", "required_signatures", "tag_name_pattern"]);
      for (const [t] of exRules) {
        if (!supported.has(t)) rows.push({ label: `Rule: ${t}`, existing: "Yes", template: "—" });
      }
    } else {
      const exPr = exRules.get("pull_request");
      rows.push({ label: "Require Pull Request", existing: fmtVal(!!exPr), template: fmtVal(!!templateConfig.requirePr) });
      if (exPr || templateConfig.requirePr) {
        rows.push({ label: "Required Approvals", existing: fmtVal(exPr?.required_approving_review_count ?? 0), template: fmtVal(templateConfig.requiredApprovals ?? 0) });
        rows.push({ label: "Dismiss Stale Reviews", existing: fmtVal(!!exPr?.dismiss_stale_reviews_on_push), template: fmtVal(!!templateConfig.dismissStaleReviews) });
        rows.push({ label: "Code Owner Review", existing: fmtVal(!!exPr?.require_code_owner_review), template: fmtVal(!!templateConfig.requireCodeOwnerReviews) });
        rows.push({ label: "Last Push Approval", existing: fmtVal(!!exPr?.require_last_push_approval), template: fmtVal(!!templateConfig.requireLastPushApproval) });
        rows.push({ label: "Conversation Resolution", existing: fmtVal(!!exPr?.required_review_thread_resolution), template: fmtVal(!!templateConfig.requireConversationResolution) });
      }

      const exChecks = exRules.get("required_status_checks");
      rows.push({ label: "Require Status Checks", existing: fmtVal(!!exChecks), template: fmtVal(!!templateConfig.requireStatusChecks) });
      if (exChecks || templateConfig.requireStatusChecks) {
        rows.push({ label: "Strict Status Checks", existing: fmtVal(!!exChecks?.strict_required_status_checks_policy), template: fmtVal(!!templateConfig.strictStatusChecks) });
      }

      rows.push({ label: "Restrict Creations", existing: fmtVal(exRules.has("creation")), template: fmtVal(!!templateConfig.restrictCreations) });
      rows.push({ label: "Restrict Updates", existing: fmtVal(exRules.has("update")), template: fmtVal(!!templateConfig.restrictUpdates) });
      rows.push({ label: "Prevent Deletion", existing: fmtVal(exRules.has("deletion")), template: fmtVal(!!templateConfig.preventDeletion) });
      rows.push({ label: "Prevent Force Push", existing: fmtVal(exRules.has("non_fast_forward")), template: fmtVal(!!templateConfig.preventForcePush) });
      rows.push({ label: "Linear History", existing: fmtVal(exRules.has("required_linear_history")), template: fmtVal(!!templateConfig.requireLinearHistory) });
      rows.push({ label: "Signed Commits", existing: fmtVal(exRules.has("required_signatures")), template: fmtVal(!!templateConfig.requireSignedCommits) });

      const supported = new Set(["pull_request", "required_status_checks", "creation", "update", "deletion", "non_fast_forward", "required_linear_history", "required_signatures", "required_deployments", "required_code_scanning", "code_quality", "copilot_code_review"]);
      for (const [t] of exRules) {
        if (!supported.has(t)) rows.push({ label: `Rule: ${t}`, existing: "Yes", template: "—" });
      }
    }

    const exBypass = (existingConfig.bypass_actors || []).length;
    let tmplBypass = 0;
    if (templateConfig.bypassActors?.length > 0) tmplBypass = templateConfig.bypassActors.length;
    else if (!isTag && !templateConfig.enforceAdmins) tmplBypass = 1;
    rows.push({ label: "Bypass Actors", existing: `${exBypass} actor(s)`, template: `${tmplBypass} actor(s)` });
  } else {
    const exAdmin = existingConfig.enforce_admins?.enabled ?? existingConfig.enforce_admins ?? false;
    rows.push({ label: "Enforce Admins", existing: fmtVal(!!exAdmin), template: fmtVal(!!templateConfig.enforceAdmins) });

    const exPr = existingConfig.required_pull_request_reviews;
    rows.push({ label: "Require Pull Request", existing: fmtVal(!!exPr), template: fmtVal(!!templateConfig.requirePr) });
    if (exPr || templateConfig.requirePr) {
      rows.push({ label: "Required Approvals", existing: fmtVal(exPr?.required_approving_review_count ?? 0), template: fmtVal(templateConfig.requiredApprovals ?? 0) });
      rows.push({ label: "Dismiss Stale Reviews", existing: fmtVal(!!exPr?.dismiss_stale_reviews), template: fmtVal(!!templateConfig.dismissStaleReviews) });
      rows.push({ label: "Code Owner Review", existing: fmtVal(!!exPr?.require_code_owner_reviews), template: fmtVal(!!templateConfig.requireCodeOwnerReviews) });
    }

    const exChecks = existingConfig.required_status_checks;
    rows.push({ label: "Require Status Checks", existing: fmtVal(!!exChecks), template: fmtVal(!!templateConfig.requireStatusChecks) });
    if (exChecks || templateConfig.requireStatusChecks) {
      rows.push({ label: "Strict Status Checks", existing: fmtVal(!!exChecks?.strict), template: fmtVal(!!templateConfig.strictStatusChecks) });
    }

    rows.push({ label: "Linear History", existing: fmtVal(!!existingConfig.required_linear_history?.enabled), template: fmtVal(!!templateConfig.requireLinearHistory) });
    rows.push({ label: "Allow Force Push", existing: fmtVal(!!existingConfig.allow_force_pushes?.enabled), template: fmtVal(!templateConfig.preventForcePush) });
    rows.push({ label: "Allow Deletions", existing: fmtVal(!!existingConfig.allow_deletions?.enabled), template: fmtVal(!templateConfig.preventDeletion) });
    rows.push({ label: "Conversation Resolution", existing: fmtVal(!!existingConfig.required_conversation_resolution?.enabled), template: fmtVal(!!templateConfig.requireConversationResolution) });
    rows.push({ label: "Signed Commits", existing: fmtVal(!!existingConfig.required_signatures?.enabled), template: fmtVal(!!templateConfig.requireSignedCommits) });

    const exRestrictions = existingConfig.restrictions;
    const hasExRestrictions = (exRestrictions?.users?.length || 0) + (exRestrictions?.teams?.length || 0) + (exRestrictions?.apps?.length || 0) > 0;
    rows.push({ label: "Push Restrictions", existing: fmtVal(hasExRestrictions), template: fmtVal(!!templateConfig.restrictPushes) });
  }

  return rows.filter((r) => r.existing !== r.template);
}

export function applyTemplate(
  templateId: string,
  repos: string[]
): Promise<{ created: string[]; protected: string[]; errors: string[]; conflicts?: ConflictItem[] }> {
  if (DEMO_MODE) return mockApplyTemplate(templateId, repos);
  return apiPost(`/templates/${templateId}/apply`, { repos });
}
