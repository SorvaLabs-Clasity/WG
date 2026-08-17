import { Router, Request, Response, RequestHandler } from "express";
import crypto from "crypto";
import { sanitizeError } from "../utils/errorSanitizer";
import { isAwsAdmin, AWS_ADMIN_TEAM } from "../services/authorizationService";
import { logActivity } from "../services/activityService";
import { CATALOG } from "../aws-guardrails/catalog";
import { canRemediate } from "../aws-guardrails/remediators";
import {
  listGuardrails, getGuardrail, putGuardrail, deleteGuardrail,
  listAwsExclusions, putAwsExclusion, deleteAwsExclusion,
  listFindings, deleteFindingsForRule,
} from "../aws-guardrails/store";
import { resolveAccounts, scopesFor } from "../aws-guardrails/accounts";
import type { Guardrail, AwsExclusionList, GuardrailMode, AwsAccount } from "../aws-guardrails/types";
import { awsRegion, resolveAwsRegion } from "../utils/region";

const router = Router();

const FUNCTION_NAME = process.env.GUARDRAIL_FUNCTION_NAME
  || `${process.env.STACK_NAME || "github-control-hub"}-guardrail-enforcer`;

/**
 * Everything that changes or triggers a guardrail is restricted to the admin
 * team. Unlike the GitHub side — where a repo action is authorized by GitHub
 * itself, because the call is made with the user's own token — these calls run
 * as the Lambda's role, which holds account-wide write permissions. There is no
 * per-user AWS identity to delegate to, so the app has to decide.
 *
 * Reading is deliberately open: anyone signed in can see rules and findings.
 */
const requireAdmin: RequestHandler = (req, res, next) => {
  isAwsAdmin(req.user!.login)
    .then(allowed => {
      if (allowed) return next();
      res.status(403).json({
        code: "CONTROL_HUB_ADMIN_REQUIRED",
        error: `Only members of the "${AWS_ADMIN_TEAM}" team (or organization owners) can change or run ` +
          `AWS guardrails. They act on the whole account, so they are not scoped to what you personally can reach. ` +
          `Viewing rules and findings is open to everyone.`,
      });
    })
    .catch(() => res.status(503).json({ error: "Could not verify team membership" }));
};

/** The rule kinds the UI can offer, with their defaults. */
router.get("/catalog", (_req: Request, res: Response) => {
  res.json(CATALOG.map(k => ({
    kind: k.kind,
    title: k.title,
    summary: k.summary,
    paramSchema: k.paramSchema,
    resourceType: k.resourceType,
    defaultMode: k.defaultMode,
    defaultParams: k.defaultParams,
    triggerEvents: k.triggerEvents,
    // Report-only kinds have no remediator: fixing them automatically could cut
    // live access, so the UI should not offer enforce mode for them.
    canRemediate: canRemediate(k.kind),
  })));
});

router.get("/guardrails", async (_req: Request, res: Response) => {
  try {
    res.json(await listGuardrails());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.post("/guardrails", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, description, kind, mode, enabled, applyOnCreate, params, exclusionLists, accounts } = req.body ?? {};
    if (!name || !kind) {
      res.status(400).json({ error: "name and kind are required" });
      return;
    }
    if (!CATALOG.some(k => k.kind === kind)) {
      res.status(400).json({ error: `Unknown rule kind "${kind}"` });
      return;
    }
    if (mode === "enforce") {
      if (!canRemediate(kind)) {
        res.status(400).json({ error: `"${kind}" is report-only — remediating it automatically could cut live access.` });
        return;
      }
    }

    const now = new Date().toISOString();
    const rule: Guardrail = {
      id: crypto.randomUUID(),
      name, description: description ?? "", kind,
      enabled: enabled !== false,
      mode: (mode as GuardrailMode) ?? "report",
      applyOnCreate: applyOnCreate !== false,
      params: params ?? {},
      exclusionLists: exclusionLists ?? [],
      // Empty means every account, including ones added later. A rule that
      // stopped covering new accounts unless someone remembered to edit it
      // would be a rule that quietly narrows over time.
      accounts: Array.isArray(accounts) ? accounts : [],
      createdBy: req.user!.login, createdAt: now, updatedAt: now,
    };
    await putGuardrail(rule);
    await logActivity("aws.guardrail.create" as any, req.user!.login, rule.name, kind,
      `Created AWS guardrail "${rule.name}" in ${rule.mode} mode` +
      (rule.accounts?.length ? `, limited to ${rule.accounts.length} account(s)` : ", across every account"));
    res.status(201).json(rule);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.put("/guardrails/:id", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const existing = await getGuardrail(req.params.id);
    if (!existing) { res.status(404).json({ error: "Guardrail not found" }); return; }

    const { name, description, mode, enabled, applyOnCreate, params, exclusionLists, accounts } = req.body ?? {};

    // Only a change INTO enforce is gated — an admin-set rule must stay editable
    // by others for its name or thresholds without silently losing its mode.
    if (mode && mode !== existing.mode && mode === "enforce") {
      if (!canRemediate(existing.kind)) {
        res.status(400).json({ error: `"${existing.kind}" is report-only.` });
        return;
      }
    }

    const updated: Guardrail = {
      ...existing,
      name: name ?? existing.name,
      description: description ?? existing.description,
      mode: (mode as GuardrailMode) ?? existing.mode,
      enabled: enabled ?? existing.enabled,
      applyOnCreate: applyOnCreate ?? existing.applyOnCreate,
      params: params ?? existing.params,
      exclusionLists: exclusionLists ?? existing.exclusionLists,
      accounts: Array.isArray(accounts) ? accounts : existing.accounts ?? [],
      updatedAt: new Date().toISOString(),
    };
    await putGuardrail(updated);
    await logActivity("aws.guardrail.update" as any, req.user!.login, updated.name, updated.kind,
      `Updated AWS guardrail "${updated.name}"${mode && mode !== existing.mode ? ` (${existing.mode} → ${updated.mode})` : ""}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.delete("/guardrails/:id", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const existing = await getGuardrail(req.params.id);
    if (!existing) { res.status(404).json({ error: "Guardrail not found" }); return; }
    await deleteGuardrail(req.params.id);
    // Otherwise the findings table keeps showing results for a rule that is gone.
    await deleteFindingsForRule(req.params.id);
    await logActivity("aws.guardrail.delete" as any, req.user!.login, existing.name, existing.kind,
      `Deleted AWS guardrail "${existing.name}"`);
    res.json({ message: "Guardrail deleted" });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.get("/findings", async (_req: Request, res: Response) => {
  try {
    const findings = await listFindings();
    findings.sort((a, b) => {
      const rank = (v: string) => (v === "violation" ? 0 : v === "compliant" ? 1 : 2);
      return rank(a.verdict) - rank(b.verdict) || a.resourceId.localeCompare(b.resourceId);
    });
    res.json(findings);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/**
 * Run the engine. The app never evaluates or remediates itself — it invokes the
 * same Lambda the schedule and the creation events use, so a manual run cannot
 * behave differently from an automatic one.
 */
async function invokeEngine(payload: Record<string, unknown>): Promise<any> {
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
  const client = new LambdaClient({ region: awsRegion() });
  const out = await client.send(new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({ source: "manual", ...payload })),
  }));
  const body = out.Payload ? JSON.parse(Buffer.from(out.Payload).toString()) : {};
  if (out.FunctionError) throw new Error(body?.errorMessage || "Guardrail run failed");
  return body;
}

router.post("/run", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ruleIds, resourceIds, accountIds } = req.body ?? {};
    const result = await invokeEngine({ ruleIds, resourceIds, accountIds });
    await logActivity("aws.guardrail.run" as any, req.user!.login, "*",
      ruleIds?.length ? `${ruleIds.length} rule(s)` : "all rules",
      `Ran AWS guardrails: ${result.violations ?? 0} violation(s), ${result.remediated ?? 0} remediated`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/** Evaluate without writing, whatever mode the rules are in. */
router.post("/preview", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ruleIds, resourceIds, accountIds } = req.body ?? {};
    res.json(await invokeEngine({ ruleIds, resourceIds, accountIds, dryRun: true }));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

// ── Exclusion lists ───────────────────────────────────────────────────

router.get("/exclusions", async (_req: Request, res: Response) => {
  try {
    res.json(await listAwsExclusions());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.post("/exclusions", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, description, resources, patterns, whitelist } = req.body ?? {};
    if (!name) { res.status(400).json({ error: "name is required" }); return; }
    const now = new Date().toISOString();
    const list: AwsExclusionList = {
      id: crypto.randomUUID(), name, description: description ?? "",
      resources: resources ?? [], patterns: patterns ?? [], whitelist: whitelist ?? [],
      createdBy: req.user!.login, createdAt: now, updatedAt: now,
    };
    await putAwsExclusion(list);
    res.status(201).json(list);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.put("/exclusions/:id", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const all = await listAwsExclusions();
    const existing = all.find(l => l.id === req.params.id);
    if (!existing) { res.status(404).json({ error: "Exclusion list not found" }); return; }
    const { name, description, resources, patterns, whitelist } = req.body ?? {};
    const updated: AwsExclusionList = {
      ...existing,
      name: name ?? existing.name,
      description: description ?? existing.description,
      resources: resources ?? existing.resources,
      patterns: patterns ?? existing.patterns,
      whitelist: whitelist ?? existing.whitelist,
      updatedAt: new Date().toISOString(),
    };
    await putAwsExclusion(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.delete("/exclusions/:id", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    await deleteAwsExclusion(req.params.id);
    res.json({ message: "Exclusion list deleted" });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────

/**
 * Which account is being watched.
 *
 * One, always: the account the app runs in. The registry that let an
 * organisation add others is gone, along with the standing `sts:AssumeRole` and
 * stored-credential permissions it required. This endpoint remains so the AWS
 * tab can name the account and the regions being swept, rather than showing
 * findings with no indication of where they came from.
 */
router.get("/accounts", async (_req: Request, res: Response) => {
  try {
    const accounts = await resolveAccounts();
    res.json({ accounts, regions: scopesFor(accounts).map(s => s.region) });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-accounts") });
  }
});

export default router;
