import { Router, Request, Response } from "express";
import crypto from "crypto";
import { sanitizeError } from "../utils/errorSanitizer";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { logActivity } from "../services/activityService";
import { CATALOG } from "../aws-guardrails/catalog";
import { canRemediate } from "../aws-guardrails/remediators";
import {
  listGuardrails, getGuardrail, putGuardrail, deleteGuardrail,
  listAwsExclusions, putAwsExclusion, deleteAwsExclusion,
  listFindings, deleteFindingsForRule,
} from "../aws-guardrails/store";
import type { Guardrail, AwsExclusionList, GuardrailMode } from "../aws-guardrails/types";

const router = Router();

const FUNCTION_NAME = process.env.GUARDRAIL_FUNCTION_NAME
  || `${process.env.STACK_NAME || "github-control-hub"}-guardrail-enforcer`;

/**
 * Enforce mode lets the app write to AWS on a schedule with no human present,
 * which is the same class of decision as auto-applying a GitHub template — so
 * it carries the same gate.
 */
async function denyEnforce(login: string): Promise<string | null> {
  if (await isControlHubAdmin(login)) return null;
  return `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can put a ` +
    `guardrail into enforce mode, because it changes AWS resources automatically.`;
}

/** The rule kinds the UI can offer, with their defaults. */
router.get("/catalog", (_req: Request, res: Response) => {
  res.json(CATALOG.map(k => ({
    kind: k.kind,
    resourceType: k.resourceType,
    defaultMode: k.defaultMode,
    defaultParams: k.defaultParams,
    createEvents: k.createEvents,
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

router.post("/guardrails", async (req: Request, res: Response) => {
  try {
    const { name, description, kind, mode, enabled, applyOnCreate, params, exclusionLists } = req.body ?? {};
    if (!name || !kind) {
      res.status(400).json({ error: "name and kind are required" });
      return;
    }
    if (!CATALOG.some(k => k.kind === kind)) {
      res.status(400).json({ error: `Unknown rule kind "${kind}"` });
      return;
    }
    if (mode === "enforce") {
      const denied = await denyEnforce(req.user!.login);
      if (denied) { res.status(403).json({ error: denied, code: "CONTROL_HUB_ADMIN_REQUIRED" }); return; }
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
      createdBy: req.user!.login, createdAt: now, updatedAt: now,
    };
    await putGuardrail(rule);
    await logActivity("aws.guardrail.create" as any, req.user!.login, rule.name, kind,
      `Created AWS guardrail "${rule.name}" in ${rule.mode} mode`);
    res.status(201).json(rule);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.put("/guardrails/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const existing = await getGuardrail(req.params.id);
    if (!existing) { res.status(404).json({ error: "Guardrail not found" }); return; }

    const { name, description, mode, enabled, applyOnCreate, params, exclusionLists } = req.body ?? {};

    // Only a change INTO enforce is gated — an admin-set rule must stay editable
    // by others for its name or thresholds without silently losing its mode.
    if (mode && mode !== existing.mode && mode === "enforce") {
      const denied = await denyEnforce(req.user!.login);
      if (denied) { res.status(403).json({ error: denied, code: "CONTROL_HUB_ADMIN_REQUIRED" }); return; }
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

router.delete("/guardrails/:id", async (req: Request<{ id: string }>, res: Response) => {
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
  const client = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });
  const out = await client.send(new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({ source: "manual", ...payload })),
  }));
  const body = out.Payload ? JSON.parse(Buffer.from(out.Payload).toString()) : {};
  if (out.FunctionError) throw new Error(body?.errorMessage || "Guardrail run failed");
  return body;
}

router.post("/run", async (req: Request, res: Response) => {
  try {
    const { ruleIds, resourceIds } = req.body ?? {};
    const result = await invokeEngine({ ruleIds, resourceIds });
    await logActivity("aws.guardrail.run" as any, req.user!.login, "*",
      ruleIds?.length ? `${ruleIds.length} rule(s)` : "all rules",
      `Ran AWS guardrails: ${result.violations ?? 0} violation(s), ${result.remediated ?? 0} remediated`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/** Evaluate without writing, whatever mode the rules are in. */
router.post("/preview", async (req: Request, res: Response) => {
  try {
    const { ruleIds, resourceIds } = req.body ?? {};
    res.json(await invokeEngine({ ruleIds, resourceIds, dryRun: true }));
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

router.post("/exclusions", async (req: Request, res: Response) => {
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

router.put("/exclusions/:id", async (req: Request<{ id: string }>, res: Response) => {
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

router.delete("/exclusions/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await deleteAwsExclusion(req.params.id);
    res.json({ message: "Exclusion list deleted" });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

export default router;
