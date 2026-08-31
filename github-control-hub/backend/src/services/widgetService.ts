import crypto from "crypto";
import { docClient, hasTable, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand, scanAll } from "../utils/dynamo";
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
  /**
   * Whose personal dashboard this belongs to, if anybody's.
   *
   * Absent means the shared organization dashboard, so widgets created before
   * this existed need no migration. Set means it appears on that one person's
   * My work and nowhere else, and only they can change it.
   *
   * Deliberately not `createdBy`. Who made a shared widget is worth keeping
   * about a widget everybody sees; whose dashboard it sits on is a different
   * question, and conflating them makes every widget anybody created disappear
   * from the shared board.
   */
  owner?: string;
  /**
   * Per-column filters, on a personal widget.
   *
   * Stored here rather than held in the page: a dashboard you have to
   * re-narrow every time you open it is not a dashboard. Applied where the rows
   * are assembled, so the count on the card and the rows in the table cannot
   * disagree.
   *
   * Absent on every widget that predates this, which is why nothing here
   * needed a migration.
   */
  filters?: Array<{
    column: string;
    mode?: "include" | "exclude";
    values?: string[];
    min?: number | null;
    max?: number | null;
  }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TABLE = () => tableName("WIDGETS_TABLE");

const memWidgets: Map<string, WidgetConfig> = new Map();

export async function listWidgets(): Promise<WidgetConfig[]> {
  if (hasTable("WIDGETS_TABLE")) {
    // Paged: a bare scan stops at 1MB without saying so, and a list that
    // silently loses its tail is worse here than an error would be.
    return (await scanAll<WidgetConfig>(TABLE())).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }
  return Array.from(memWidgets.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export async function getWidget(id: string): Promise<WidgetConfig | undefined> {
  if (hasTable("WIDGETS_TABLE")) {
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

  if (hasTable("WIDGETS_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: widget }));
  } else {
    memWidgets.set(widget.id, widget);
  }

  // Flagged from the stored record rather than from a parameter: whether this
  // is somebody's own card is a fact about the widget, and a caller that forgot
  // to pass it would file a personal change as an organization one.
  await logActivity("widget.create", actor, "*", widget.title, `Created analytics widget "${widget.title}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "delete_widget", params: { widgetId: widget.id, widgetData: widget } },
      personal: !!widget.owner }
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

  if (hasTable("WIDGETS_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memWidgets.set(id, updated);
  }

  await logActivity("widget.update", actor, "*", updated.title, `Updated analytics widget "${updated.title}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "revert_widget", params: { widgetId: id, previousState: existing, currentState: updated } },
      personal: !!updated.owner }
  );
  return updated;
}

export async function deleteWidget(id: string, actor: string): Promise<boolean> {
  const existing = await getWidget(id);
  if (!existing) return false;

  if (hasTable("WIDGETS_TABLE")) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memWidgets.delete(id);
  }

  await logActivity("widget.delete", actor, "*", existing.title, `Deleted analytics widget "${existing.title}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "restore_widget", params: { widgetData: existing } },
      personal: !!existing.owner }
  );
  return true;
}

export async function putWidgetRaw(widget: WidgetConfig): Promise<void> {
  if (hasTable("WIDGETS_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: widget }));
  } else {
    memWidgets.set(widget.id, widget);
  }
}

export async function deleteWidgetRaw(id: string): Promise<void> {
  if (hasTable("WIDGETS_TABLE")) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memWidgets.delete(id);
  }
}
