import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand } from "../utils/dynamo";
import { logActivity } from "./activityService";
import { listTemplates, putTemplateRaw } from "./templateService";

export interface ExclusionList {
  id: string;
  name: string;
  description: string;
  repos: string[];
  forceTemplateIds: string[];
  forceOnNewTemplates: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TABLE = () => tableName("EXCLUSIONS_TABLE");

// In-memory fallback
const memExclusions: Map<string, ExclusionList> = new Map();

export async function listExclusions(): Promise<ExclusionList[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return ((result.Items || []) as ExclusionList[]).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  return Array.from(memExclusions.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getExclusion(id: string): Promise<ExclusionList | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    return result.Item as ExclusionList | undefined;
  }
  return memExclusions.get(id);
}

export async function createExclusion(
  data: Omit<ExclusionList, "id" | "createdAt" | "updatedAt">,
  actor: string
): Promise<ExclusionList> {
  const now = new Date().toISOString();
  const exclusion: ExclusionList = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: exclusion }));
  } else {
    memExclusions.set(exclusion.id, exclusion);
  }

  await logActivity("exclusion.create", actor, "*", exclusion.name, `Created exclusion list "${exclusion.name}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "delete_exclusion", params: { exclusionId: exclusion.id, exclusionData: exclusion } } }
  );

  if (exclusion.forceOnNewTemplates || exclusion.forceTemplateIds.length > 0) {
    await cascadeForceToTemplates(exclusion.id, exclusion.forceTemplateIds, exclusion.forceOnNewTemplates, [], false);
  }

  return exclusion;
}

export async function updateExclusion(
  id: string,
  data: Partial<Omit<ExclusionList, "id" | "createdAt" | "updatedAt">>,
  actor: string
): Promise<ExclusionList | null> {
  const existing = await getExclusion(id);
  if (!existing) return null;

  const updated: ExclusionList = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memExclusions.set(id, updated);
  }

  await logActivity("exclusion.update", actor, "*", updated.name, `Updated exclusion list "${updated.name}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "revert_exclusion", params: { exclusionId: id, previousState: existing, currentState: updated } } }
  );

  await cascadeForceToTemplates(
    id,
    updated.forceTemplateIds || [],
    updated.forceOnNewTemplates || false,
    existing.forceTemplateIds || [],
    existing.forceOnNewTemplates || false
  );

  return updated;
}

async function cascadeForceToTemplates(
  exclusionId: string,
  newForceTemplateIds: string[],
  newForceOnNew: boolean,
  oldForceTemplateIds: string[],
  oldForceOnNew: boolean
): Promise<void> {
  const templates = await listTemplates();

  for (const tmpl of templates) {
    const has = (tmpl.exclusionLists || []).includes(exclusionId);
    const shouldForce =
      newForceOnNew ||
      newForceTemplateIds.includes(tmpl.id);
    const wasForced =
      oldForceOnNew ||
      oldForceTemplateIds.includes(tmpl.id);

    if (shouldForce && !has) {
      await putTemplateRaw({ ...tmpl, exclusionLists: [...(tmpl.exclusionLists || []), exclusionId] });
    }
  }
}

export async function putExclusionRaw(exclusion: ExclusionList): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: exclusion }));
  } else {
    memExclusions.set(exclusion.id, exclusion);
  }
}

export async function deleteExclusionRaw(id: string): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memExclusions.delete(id);
  }
}

export async function deleteExclusion(id: string, actor: string): Promise<boolean> {
  const existing = await getExclusion(id);
  if (!existing) return false;

  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memExclusions.delete(id);
  }

  await logActivity("exclusion.delete", actor, "*", existing.name, `Deleted exclusion list "${existing.name}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "restore_exclusion", params: { exclusionData: existing } } }
  );

  const templates = await listTemplates();
  for (const tmpl of templates) {
    if ((tmpl.exclusionLists || []).includes(id)) {
      await putTemplateRaw({ ...tmpl, exclusionLists: (tmpl.exclusionLists || []).filter(eid => eid !== id) });
    }
  }

  return true;
}
