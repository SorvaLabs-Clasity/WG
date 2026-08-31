import { Router } from "express";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import type { Request, Response } from "express";
import { listWidgets, createWidget, updateWidget, deleteWidget, type WidgetConfig } from "../services/widgetService";

const router = Router();

/**
 * There is one dashboard, not one per person.
 *
 * listWidgets scans with no user filter, so every widget is on everyone's
 * dashboard and `createdBy` scopes nothing. That makes a widget shared
 * configuration rather than a personal preference, so ungated any member could
 * delete a panel the whole team reads.
 *
 * No repository or AWS access rides on this, so it is not an escalation. It is
 * gated because shared state should not be editable by everyone who can see it.
 */
async function refusedWidgetChange(res: Response, login: string, verb: string, userToken?: string): Promise<boolean> {
  if (await isControlHubAdmin(login, userToken)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `dashboard widgets. There is one dashboard, shared by everyone.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

/**
 * The shared dashboard, or your own.
 *
 * Two boards out of one table. Without a scope this returns exactly what it
 * always did, the widgets with no owner, so the Overview tab is untouched by
 * the existence of personal ones.
 *
 * Filtered on the server. A personal widget is not secret, but it is nobody
 * else's business, and shipping the whole table to be filtered in a browser
 * would put every person's board in every other person's page.
 */
/**
 * The shared board, or the caller's own.
 *
 * Only the shared half is gated. Somebody's own cards are theirs to list, and
 * gating those would take the personal board away from everybody it exists for.
 *
 * The check engine behind both stays open on purpose: a non-admin can build the
 * same check on their own board, so restricting it here would buy nothing and
 * break My work. What the gate protects is the organization's *curated* board —
 * which checks somebody thought worth watching — not the ability to run one.
 */
router.get("/", async (req: Request, res: Response) => {
  const mine = req.query.scope === "personal";
  const login = req.user!.login.toLowerCase();

  if (!mine && !(await isControlHubAdmin(login, req.user!.accessToken).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      team: CONTROL_HUB_ADMIN_TEAM,
      error: `The Overview board is limited to the "${CONTROL_HUB_ADMIN_TEAM}" team, `
        + "and to organization owners. Your own cards are on My work.",
    });
  }

  const all = await listWidgets();
  res.json(all.filter(w => mine
    ? w.owner?.toLowerCase() === login
    : !w.owner));
});

/**
 * Every widget's last computed rows, in one read.
 *
 * The dashboard opens with these rather than running each check while somebody
 * waits. `computedAt` travels with them so the page can say how old the number
 * is instead of implying it is current, a stale figure presented as live is
 * the failure this is meant to avoid, not one to introduce.
 *
 * An empty list is a normal answer: the scheduled pass may not have run yet, or
 * a widget may have been added since. The caller computes live in that case.
 */
router.get("/snapshots", async (req: Request, res: Response) => {
  const { readWidgetSnapshots } = await import("../services/alarmService");
  const all = await readWidgetSnapshots();

  // Narrowed to what the caller may see, not refused outright: My work reads
  // this too, and gating it whole would take the personal board's stored
  // answers away from everybody. A snapshot holds the check's actual findings,
  // so serving every one of them past a gated board would hand over exactly
  // what the gate was for.
  const login = req.user!.login.toLowerCase();
  if (await isControlHubAdmin(login, req.user!.accessToken).catch(() => false)) {
    return res.json(all);
  }
  const mine = new Set((await listWidgets())
    .filter(w => w.owner?.toLowerCase() === login)
    .map(w => w.id));
  res.json(all.filter(snap => mine.has(snap.widgetId)));
});

/**
 * Per-column filters, sanitised.
 *
 * Stored on the widget and applied to the rows when they are drawn, so
 * everything here is shape rather than trust: a filter naming a column that
 * does not exist narrows nothing, and one carrying a hundred values is a body
 * somebody hand-wrote. Bounds are dropped when they are not finite, because
 * `NaN` compares false against everything and would empty the widget with no
 * way to see why.
 */
function cleanFilters(raw: unknown): WidgetConfig["filters"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, 20).flatMap((f: any) => {
    if (!f || typeof f.column !== "string" || f.column.length > 64) return [];
    const values = Array.isArray(f.values)
      ? f.values.filter((v: any) => typeof v === "string" && v.length <= 200).slice(0, 50)
      : undefined;
    const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const cleaned = {
      column: f.column,
      ...(f.mode === "exclude" ? { mode: "exclude" as const } : {}),
      ...(values && values.length ? { values } : {}),
      ...(num(f.min) !== undefined ? { min: num(f.min) } : {}),
      ...(num(f.max) !== undefined ? { max: num(f.max) } : {}),
    };
    // A filter with nothing in it is not stored: it would show as a chip on the
    // card promising a narrowing that never happens.
    const narrows = (cleaned.values?.length ?? 0) > 0
      || cleaned.min !== undefined || cleaned.max !== undefined;
    return narrows ? [cleaned] : [];
  });
  return out.length ? out : undefined;
}

router.post("/", async (req: Request, res: Response) => {
  const { title, type, presetId, queryId, queryParam, queryAdvanced, displayType, personal } = req.body;

  // The admin gate is about the *shared* dashboard, which is why it exists:
  // one board, seen by everybody, so not everybody may rearrange it. A widget
  // on your own page is not that, and asking an administrator for permission to
  // arrange your own screen would be the wrong shape entirely.
  //
  // The owner is taken from the session, never from the body, otherwise this
  // would be a way to put a widget on somebody else's dashboard.
  const owner = personal ? req.user!.login : undefined;
  if (!owner && await refusedWidgetChange(res, req.user!.login, "create", req.user!.accessToken)) return;

  if (!title || !type || !displayType) {
    res.status(400).json({ error: "title, type, and displayType are required" });
    return;
  }
  const widget = await createWidget(
    { title, type, presetId, queryId, queryParam, queryAdvanced, displayType, owner,
      filters: cleanFilters(req.body.filters), createdBy: req.user!.login },
    req.user!.login
  );
  res.status(201).json(widget);
});

/**
 * Whether this widget is the caller's own to change.
 *
 * Read from what is stored, never from the request. A widget with no owner is
 * on the shared board and takes the admin gate; one owned by somebody else is
 * refused outright rather than falling back to the admin gate, because an
 * administrator has no business rearranging a person's own dashboard either.
 */
async function refusedWidgetEdit(
  res: Response, id: string, login: string, verb: string, token?: string,
): Promise<boolean> {
  const existing = (await listWidgets()).find(w => w.id === id);
  if (!existing) { res.status(404).json({ error: "Widget not found" }); return true; }
  if (!existing.owner) return refusedWidgetChange(res, login, verb, token);
  if (existing.owner.toLowerCase() === login.toLowerCase()) return false;
  res.status(403).json({ error: "That widget is on somebody else's dashboard." });
  return true;
}

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  if (await refusedWidgetEdit(res, req.params.id, req.user!.login, "edit", req.user!.accessToken)) return;

  /**
   * Only the fields the request actually sent.
   *
   * `updateWidget` merges over what is stored, so naming a field here that the
   * body did not carry sets it to undefined and DynamoDB drops the attribute:
   * a request changing one thing wipes the rest. It never showed, because the
   * only caller sent the whole widget every time. The filter editor sends
   * `filters` alone, and would have erased the title.
   *
   * `filters` is included whenever the key is present even if it cleans to
   * undefined, because that is how the last filter gets removed.
   */
  const patch: Parameters<typeof updateWidget>[1] = {};
  for (const key of ["title", "type", "presetId", "queryId", "queryParam",
    "queryAdvanced", "displayType"] as const) {
    if (key in req.body) (patch as any)[key] = req.body[key];
  }
  if ("filters" in req.body) patch.filters = cleanFilters(req.body.filters);

  const updated = await updateWidget(req.params.id, patch, req.user!.login);
  if (!updated) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  if (await refusedWidgetEdit(res, req.params.id, req.user!.login, "delete", req.user!.accessToken)) return;

  const deleted = await deleteWidget(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  // Otherwise the snapshot outlives the widget and sits in the table until its
  // own expiry, counting against a scan nothing will ever read it from.
  const { deleteWidgetSnapshot } = await import("../services/alarmService");
  await deleteWidgetSnapshot(req.params.id).catch(() => { /* the widget is gone either way */ });
  res.json({ message: "Widget deleted" });
});

export default router;
