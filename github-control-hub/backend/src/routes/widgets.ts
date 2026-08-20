import { Router } from "express";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import type { Request, Response } from "express";
import { listWidgets, createWidget, updateWidget, deleteWidget } from "../services/widgetService";

const router = Router();

/**
 * There is one dashboard, not one per person.
 *
 * listWidgets scans the table with no user filter, so every widget is on
 * everyone's dashboard — `createdBy` is recorded but never used to scope
 * anything. That makes a widget shared configuration rather than a personal
 * preference, and left ungated it meant any member could delete a panel the
 * whole team reads, or undo someone else's.
 *
 * No repository or AWS access rides on this, so it is not an escalation. It is
 * gated for the same reason the rest is: shared state should not be editable by
 * everyone who can see it.
 */
async function refusedWidgetChange(res: Response, login: string, verb: string, userToken?: string): Promise<boolean> {
  if (await isControlHubAdmin(login, userToken)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `dashboard widgets — there is one dashboard, shared by everyone.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listWidgets());
});

router.post("/", async (req: Request, res: Response) => {
  if (await refusedWidgetChange(res, req.user!.login, "create", req.user!.accessToken)) return;

  const { title, type, presetId, queryId, queryParam, queryAdvanced, displayType } = req.body;
  if (!title || !type || !displayType) {
    res.status(400).json({ error: "title, type, and displayType are required" });
    return;
  }
  const widget = await createWidget(
    { title, type, presetId, queryId, queryParam, queryAdvanced, displayType, createdBy: req.user!.login },
    req.user!.login
  );
  res.status(201).json(widget);
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  if (await refusedWidgetChange(res, req.user!.login, "edit", req.user!.accessToken)) return;

  const { title, type, presetId, queryId, queryParam, queryAdvanced, displayType } = req.body;
  const updated = await updateWidget(req.params.id, { title, type, presetId, queryId, queryParam, queryAdvanced, displayType }, req.user!.login);
  if (!updated) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  if (await refusedWidgetChange(res, req.user!.login, "delete", req.user!.accessToken)) return;

  const deleted = await deleteWidget(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json({ message: "Widget deleted" });
});

export default router;
