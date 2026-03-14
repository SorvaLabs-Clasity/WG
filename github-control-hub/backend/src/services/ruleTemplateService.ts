import crypto from "crypto";
import { logActivity } from "./activityService";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand } from "../utils/dynamo";

export type RuleTemplateType = "classic" | "branch_ruleset" | "tag_ruleset" | "push_ruleset";

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  ruleType: RuleTemplateType;
  /** For classic / branch_ruleset types */
  branchProtection?: any;
  /** For tag_ruleset type */
  tagProtection?: any;
  /** For push_ruleset type */
  pushProtection?: any;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TABLE = () => tableName("RULE_TEMPLATES_TABLE");

// In-memory fallback for local development
const memStore: Map<string, RuleTemplate> = new Map();

export async function listRuleTemplates(): Promise<RuleTemplate[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return ((result.Items || []) as RuleTemplate[]).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  return Array.from(memStore.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getRuleTemplate(id: string): Promise<RuleTemplate | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    return result.Item as RuleTemplate | undefined;
  }
  return memStore.get(id);
}

export async function createRuleTemplate(
  data: Omit<RuleTemplate, "id" | "createdAt" | "updatedAt">,
  actor: string
): Promise<RuleTemplate> {
  const now = new Date().toISOString();
  const template: RuleTemplate = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: template }));
  } else {
    memStore.set(template.id, template);
  }

  await logActivity(
    "rule_template.create" as any,
    actor,
    "*",
    template.name,
    `Created rule template "${template.name}" (${template.ruleType})`
  );
  return template;
}

export async function updateRuleTemplate(
  id: string,
  data: Partial<Omit<RuleTemplate, "id" | "createdAt" | "updatedAt">>,
  actor: string
): Promise<RuleTemplate | null> {
  const existing = await getRuleTemplate(id);
  if (!existing) return null;

  const updated: RuleTemplate = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memStore.set(id, updated);
  }

  await logActivity(
    "rule_template.update" as any,
    actor,
    "*",
    updated.name,
    `Updated rule template "${updated.name}"`
  );
  return updated;
}

export async function deleteRuleTemplate(id: string, actor: string): Promise<boolean> {
  const existing = await getRuleTemplate(id);
  if (!existing) return false;

  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memStore.delete(id);
  }

  await logActivity(
    "rule_template.delete" as any,
    actor,
    "*",
    existing.name,
    `Deleted rule template "${existing.name}"`
  );
  return true;
}
