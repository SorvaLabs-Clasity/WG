import { Router } from "express";
import type { Request, Response } from "express";
import {
  listRuleTemplates,
  getRuleTemplate,
  createRuleTemplate,
  updateRuleTemplate,
  deleteRuleTemplate,
} from "../services/ruleTemplateService";
import { sanitizeError } from "../utils/errorSanitizer";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

const router = Router();

/**
 * Rule templates are org-wide configuration, and were the one kind that anybody
 * could rewrite.
 *
 * Templates, exclusions, scanners, widgets, alerts and the config bundle are
 * all gated on the admin team — config.ts even gates *importing* a rule
 * template — but the rule template routes themselves shipped with no check at
 * all. A rule template is the protection preset the Protect modals offer and
 * the Templates page builds on, so editing one changes what an admin applies to
 * a repository later, under their name and with their token. Reading stays open,
 * as it is everywhere else here.
 */
async function refusedRuleTemplateChange(res: Response, login: string, verb: string): Promise<boolean> {
  if (await isControlHubAdmin(login)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `rule templates, because a rule template decides what protection every repository it is applied to receives.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listRuleTemplates());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "ruleTemplates") });
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
    res.status(500).json({ error: sanitizeError(err, "ruleTemplates") });
  }
});

router.post("/", async (req: Request, res: Response) => {
  if (await refusedRuleTemplateChange(res, req.user!.login, "create")) return;
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
    res.status(500).json({ error: sanitizeError(err, "ruleTemplates") });
  }
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  if (await refusedRuleTemplateChange(res, req.user!.login, "edit")) return;
  try {
    const { name, description, ruleType, branchProtection, tagProtection, pushProtection } = req.body;
    const updated = await updateRuleTemplate(req.params.id, { name, description, ruleType, branchProtection, tagProtection, pushProtection }, req.user!.login);
    if (!updated) {
      res.status(404).json({ error: "Rule template not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "ruleTemplates") });
  }
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  if (await refusedRuleTemplateChange(res, req.user!.login, "delete")) return;
  try {
    const deleted = await deleteRuleTemplate(req.params.id, req.user!.login);
    if (!deleted) {
      res.status(404).json({ error: "Rule template not found" });
      return;
    }
    res.json({ message: "Rule template deleted" });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "ruleTemplates") });
  }
});

export default router;
