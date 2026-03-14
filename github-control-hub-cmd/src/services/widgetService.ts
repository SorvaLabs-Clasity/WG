import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand } from "../utils/dynamo";
import { logActivity } from "./activityService";

export interface WidgetConfig {
  id: string;
  title: string;
  type: "preset" | "query";
  presetId?: string;
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: any;
  displayType: "metric" | "table";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TABLE = () => tableName("WIDGETS_TABLE");

const memWidgets: Map<string, WidgetConfig> = new Map();

export async function listWidgets(): Promise<WidgetConfig[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return ((result.Items || []) as WidgetConfig[]).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }
  return Array.from(memWidgets.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export async function getWidget(id: string): Promise<WidgetConfig | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    return result.Item as WidgetConfig | undefined;
  }
  return memWidgets.get(id);
}

export async function createWidget(
  data: Omit<WidgetConfig, "id" | "createdAt" | "updatedAt">,
  actor: string
): Promise<WidgetConfig> {
  const now = new Date().toISOString();
  const widget: WidgetConfig = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: widget }));
  } else {
    memWidgets.set(widget.id, widget);
  }

  await logActivity("widget.create" as any, actor, "*", widget.title, `Created analytics widget "${widget.title}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "delete_widget", params: { widgetId: widget.id, widgetData: widget } } }
  );
  return widget;
}

export async function updateWidget(
  id: string,
  data: Partial<Omit<WidgetConfig, "id" | "createdAt" | "updatedAt">>,
  actor: string
): Promise<WidgetConfig | null> {
  const existing = await getWidget(id);
  if (!existing) return null;

  const updated: WidgetConfig = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memWidgets.set(id, updated);
  }

  await logActivity("widget.update" as any, actor, "*", updated.title, `Updated analytics widget "${updated.title}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "revert_widget", params: { widgetId: id, previousState: existing, currentState: updated } } }
  );
  return updated;
}

export async function deleteWidget(id: string, actor: string): Promise<boolean> {
  const existing = await getWidget(id);
  if (!existing) return false;

  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memWidgets.delete(id);
  }

  await logActivity("widget.delete" as any, actor, "*", existing.title, `Deleted analytics widget "${existing.title}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "restore_widget", params: { widgetData: existing } } }
  );
  return true;
}

export async function putWidgetRaw(widget: WidgetConfig): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: widget }));
  } else {
    memWidgets.set(widget.id, widget);
  }
}

export async function deleteWidgetRaw(id: string): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memWidgets.delete(id);
  }
}
