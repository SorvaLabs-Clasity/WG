import { Router } from "express";
import type { Request, Response } from "express";
import { listWidgets, createWidget, updateWidget, deleteWidget } from "../services/widgetService";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listWidgets());
});

router.post("/", async (req: Request, res: Response) => {
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
  const updated = await updateWidget(req.params.id, req.body, req.user!.login);
  if (!updated) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const deleted = await deleteWidget(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json({ message: "Widget deleted" });
});

export default router;
