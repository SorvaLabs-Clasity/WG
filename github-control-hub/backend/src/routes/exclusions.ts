import { Router } from "express";
import type { Request, Response } from "express";
import {
  listExclusions,
  getExclusion,
  createExclusion,
  updateExclusion,
  deleteExclusion,
} from "../services/exclusionService";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listExclusions());
});

router.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const exclusion = await getExclusion(req.params.id);
  if (!exclusion) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json(exclusion);
});

router.post("/", async (req: Request, res: Response) => {
  const { name, description, repos, forceTemplateIds, forceOnNewTemplates } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const exclusion = await createExclusion(
    {
      name,
      description: description ?? "",
      repos: repos ?? [],
      forceTemplateIds: forceTemplateIds ?? [],
      forceOnNewTemplates: forceOnNewTemplates ?? false,
      createdBy: req.user!.login,
    },
    req.user!.login
  );

  res.status(201).json(exclusion);
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const { name, description, repos, forceTemplateIds, forceOnNewTemplates } = req.body;
  const updated = await updateExclusion(req.params.id, { name, description, repos, forceTemplateIds, forceOnNewTemplates }, req.user!.login);
  if (!updated) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const deleted = await deleteExclusion(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json({ message: "Exclusion list deleted" });
});

export default router;
