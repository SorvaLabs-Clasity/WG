import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit } from "../github/client";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
} from "../services/templateService";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listTemplates());
});

router.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const template = await getTemplate(req.params.id);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(template);
});

router.post("/", async (req: Request, res: Response) => {
  const { name, description, branches, autoApplyOnNewRepo } = req.body;
  if (!name || !branches?.length) {
    res.status(400).json({ error: "name and at least one branch rule are required" });
    return;
  }

  const template = await createTemplate(
    {
      name,
      description: description ?? "",
      branches,
      autoApplyOnNewRepo: autoApplyOnNewRepo ?? false,
      createdBy: req.user!.login,
    },
    req.user!.login
  );

  res.status(201).json(template);
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const updated = await updateTemplate(req.params.id, req.body, req.user!.login);
  if (!updated) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const deleted = await deleteTemplate(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json({ message: "Template deleted" });
});

router.post("/:id/apply/:repo", async (req: Request<{ id: string; repo: string }>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const result = await applyTemplate(octokit, req.params.id, req.params.repo, req.user!.login);
    res.json(result);
  } catch (err) {
    console.error("Error applying template:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
