import { Router } from "express";
import type { Request, Response } from "express";
import {
  listRuleTemplates,
  getRuleTemplate,
  createRuleTemplate,
  updateRuleTemplate,
  deleteRuleTemplate,
} from "../services/ruleTemplateService";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listRuleTemplates());
  } catch (err) {
    console.error("[rule-templates] list error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const rt = await getRuleTemplate(req.params.id);
    if (!rt) {
      res.status(404).json({ error: "Rule template not found" });
      return;
    }
    res.json(rt);
  } catch (err) {
    console.error("[rule-templates] get error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  const { name, description, ruleType, branchProtection, tagProtection } = req.body;
  if (!name || !ruleType) {
    res.status(400).json({ error: "name and ruleType are required" });
    return;
  }
  if (!["classic", "branch_ruleset", "tag_ruleset", "push_ruleset"].includes(ruleType)) {
    res.status(400).json({ error: "ruleType must be classic, branch_ruleset, tag_ruleset, or push_ruleset" });
    return;
  }

  try {
    const { pushProtection } = req.body;
    const rt = await createRuleTemplate(
      {
        name,
        description: description ?? "",
        ruleType,
        branchProtection: ruleType !== "tag_ruleset" && ruleType !== "push_ruleset" ? branchProtection : undefined,
        tagProtection: ruleType === "tag_ruleset" ? tagProtection : undefined,
        pushProtection: ruleType === "push_ruleset" ? pushProtection : undefined,
        createdBy: req.user!.login,
      },
      req.user!.login
    );
    res.status(201).json(rt);
  } catch (err) {
    console.error("[rule-templates] create error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const updated = await updateRuleTemplate(req.params.id, req.body, req.user!.login);
    if (!updated) {
      res.status(404).json({ error: "Rule template not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error("[rule-templates] update error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const deleted = await deleteRuleTemplate(req.params.id, req.user!.login);
    if (!deleted) {
      res.status(404).json({ error: "Rule template not found" });
      return;
    }
    res.json({ message: "Rule template deleted" });
  } catch (err) {
    console.error("[rule-templates] delete error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
