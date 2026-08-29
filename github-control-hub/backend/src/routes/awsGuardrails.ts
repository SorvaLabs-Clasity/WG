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
import { ruleExclusionsChanged, listContentChanged, rulesUsingList } from "../aws-guardrails/staleness";
import { callerMayRemediate, liveProbe, type ResourceRef, type WriteIntent } from "../aws-guardrails/permissions";
import type { Guardrail, AwsExclusionList, GuardrailMode, GuardrailKind, AwsAccount } from "../aws-guardrails/types";
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
  isAwsAdmin(req.user!.login, req.user!.accessToken)
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
        res.status(400).json({ error: `"${kind}" is report-only. Remediating it automatically could cut live access.` });
        return;
      }
      // No named resources: arming enforce is a standing instruction over every
      // resource the rule matches, including ones that do not exist yet.
      if (await refuseIfCallerCannotWrite(kind as GuardrailKind, [], res, "enforce")) return;
    }

    const now = new Date().toISOString();
    const rule: Guardrail = {
      id: crypto.randomUUID(),
      name, description: description ?? "", kind,
      enabled: enabled !== false,
      mode: (mode as GuardrailMode) ?? "report",
      applyOnCreate: applyOnCreate !== false,
      // Catalog defaults underneath whatever was sent.
    //
    // The rule form fills these in and shows every field regardless of mode, so
    // a rule made in the app already carries them. One made through the API
    // might not — and the fix parameters are exactly the ones a `report` rule
    // looks like it does not need, right up until somebody presses Fix on a
    // single resource. Storing them means the rule describes its own fix rather
    // than leaning on a fallback inside the remediator that could drift from
    // the documented default.
    params: { ...(CATALOG.find(c => c.kind === kind)?.defaultParams ?? {}), ...(params ?? {}) },
      exclusionLists: exclusionLists ?? [],
      // Empty means every account, including ones added later. A rule that
      // stopped covering new accounts unless someone remembered to edit it
      // would be a rule that quietly narrows over time.
      accounts: Array.isArray(accounts) ? accounts : [],
      createdBy: req.user!.login, createdAt: now, updatedAt: now,
    };
    await putGuardrail(rule);
    await logActivity("aws.guardrail.create", req.user!.login, rule.name, kind,
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
      if (await refuseIfCallerCannotWrite(existing.kind, [], res, "enforce")) return;
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
    await logActivity("aws.guardrail.update", req.user!.login, updated.name, updated.kind,
      `Updated AWS guardrail "${updated.name}"${mode && mode !== existing.mode ? ` (${existing.mode} → ${updated.mode})` : ""}`);

    // Its own findings are the ones this can have invalidated, and only when
    // the set of lists actually moved.
    const findingsRefreshed = await recheckRules(
      ruleExclusionsChanged(existing, updated) && updated.enabled ? [updated.id] : [],
    );
    res.json({ ...updated, findingsRefreshed });
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
    await logActivity("aws.guardrail.delete", req.user!.login, existing.name, existing.kind,
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

/**
 * Re-evaluate the rules whose exclusions have just changed.
 *
 * Synchronous on purpose. The alternative is returning a saved rule while the
 * findings behind it still say the opposite — which is precisely the bug this
 * exists to close: a resource stays marked "skipped" after the list excluding
 * it has been taken away, and pressing refresh cannot fix it, because refresh
 * re-reads stored findings rather than producing new ones.
 *
 * Scoped to the affected rules, so this is one collector pass rather than a
 * whole sweep, and skipped entirely when nothing exclusion-related moved —
 * renaming a rule or toggling its mode stays instant.
 *
 * A failure here is not a failed save. The change is already stored and is
 * correct; only the re-check did not run. Rejecting the request would tell
 * somebody their edit had not taken, which is both worse and untrue — so the
 * outcome is reported instead, and the caller can say the findings are still
 * from before rather than implying they are current.
 */
async function recheckRules(ruleIds: string[]): Promise<boolean> {
  if (ruleIds.length === 0) return false;
  try {
    await invokeEngine({ ruleIds });
    return true;
  } catch (err) {
    console.error(
      "[aws-guardrails] Findings could not be re-checked after an exclusion change:",
      (err as Error)?.message ?? err,
    );
    return false;
  }
}

/**
 * Whether this caller could make the change themselves.
 *
 * Team membership says somebody may configure guardrails. It does not say they
 * may rewrite a production bucket policy, and remediation runs under the
 * engine's role rather than theirs — so without this, being in the admin team
 * is enough to have a privileged Lambda perform a write AWS would refuse them
 * directly. See the note in permissions.ts.
 *
 * Called at the moment of authoring for enforce mode, and per resource for the
 * fix button, because a policy can allow one bucket and not another.
 */
async function refuseIfCallerCannotWrite(
  kind: GuardrailKind, resources: ResourceRef[], res: Response,
  intent: WriteIntent, region?: string,
): Promise<boolean> {
  const verdict = await callerMayRemediate(kind, resources, liveProbe(awsRegion()),
    region ?? awsRegion(), intent);
  if (verdict.allowed) return false;
  res.status(403).json({ code: "AWS_WRITE_DENIED", error: verdict.reason });
  return true;
}

router.post("/run", requireAdmin, async (req: Request, res: Response) => {
  const { ruleIds, resourceIds, accountIds } = req.body ?? {};
  const scope = ruleIds?.length ? `${ruleIds.length} rule(s)` : "all rules";
  try {
    const result = await invokeEngine({ ruleIds, resourceIds, accountIds });
    await logActivity("aws.guardrail.run", req.user!.login, "*", scope,
      `Ran AWS guardrails: ${result.violations ?? 0} violation(s), ${result.remediated ?? 0} remediated`);
    res.json(result);
  } catch (err) {
    // Logged on the way out too. Somebody pressed this, so the press is history
    // whether or not the engine answered — and a sweep that failed is the more
    // interesting of the two outcomes to be able to find later.
    await logActivity("aws.guardrail.run", req.user!.login, "*", scope,
      "AWS guardrail run failed", undefined, "app", undefined, undefined,
      { failed: true, errorMessage: (err as Error)?.message ?? String(err) });
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/**
 * Fix one failing resource, now, without changing what the rule does next time.
 *
 * The button beside a single failed item. Somebody has looked at this one thing
 * and decided to correct it; that is a different decision from deciding every
 * future violation should be corrected automatically, and this keeps them
 * separate — the rule's mode is not touched.
 *
 * So a setting changed back afterwards is reported again, not silently
 * re-corrected. Unless the rule is in `enforce` mode, where re-correcting is
 * the whole point.
 *
 * `resourceId` is required, and the engine refuses without it. Omitting it
 * would turn this into enforcing the entire rule.
 */
router.post("/remediate", requireAdmin, async (req: Request, res: Response) => {
  const { ruleId, resourceId, accountId } = req.body ?? {};
  if (!ruleId || !resourceId) {
    res.status(400).json({ error: "ruleId and resourceId are both required" });
    return;
  }

  const rule = (await listGuardrails()).find(r => r.id === ruleId);
  if (!rule) {
    res.status(404).json({ error: "No such guardrail rule" });
    return;
  }
  if (!canRemediate(rule.kind)) {
    res.status(400).json({
      error: `"${rule.kind}" has no automatic fix. Correcting it could cut live access, so it needs a human.`,
    });
    return;
  }

  // The narrow question, for the one thing being changed. A policy can allow
  // the sandbox bucket and refuse the production one, and this is the only
  // gate between "read-only in production" and a privileged Lambda rewriting
  // its bucket policy on request.
  // Region and account come off the finding, falling back to the request. A
  // log-group ARN needs both, and a missing one refuses rather than guessing —
  // simulating against a group in the wrong account would look like an answer.
  const found = (await listFindings()).find(
    f => f.ruleId === ruleId && f.resourceId === resourceId);
  const region = found?.region;
  if (await refuseIfCallerCannotWrite(
        rule.kind,
        [{ id: resourceId, region, accountId: accountId ?? found?.accountId }],
        res, "fix", region)) return;

  try {
    const result = await invokeEngine({
      ruleIds: [ruleId],
      resourceIds: [resourceId],
      accountIds: accountId ? [accountId] : undefined,
      forceRemediate: true,
    });

    const fixed = (result.remediated ?? 0) > 0;
    await logActivity("aws.guardrail.run", req.user!.login, "*", resourceId,
      fixed
        ? `Fixed ${resourceId} for "${rule.name}"`
        : `Asked to fix ${resourceId} for "${rule.name}". Nothing was changed`,
      undefined, "app", undefined, undefined,
      { failed: !fixed && (result.errors?.length ?? 0) > 0 });

    res.json({
      remediated: result.remediated ?? 0,
      // Returned rather than assumed. A resource that was already compliant by
      // the time this ran reports zero, and the caller should say so instead of
      // claiming a fix that did not happen.
      findings: result.findings ?? [],
      errors: result.errors ?? [],
    });
  } catch (err) {
    await logActivity("aws.guardrail.run", req.user!.login, "*", resourceId,
      `Failed to fix ${resourceId} for "${rule.name}"`,
      undefined, "app", undefined, undefined,
      { failed: true, errorMessage: (err as Error)?.message ?? String(err) });
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/** Evaluate without writing, whatever mode the rules are in. */
router.post("/preview", requireAdmin, async (req: Request, res: Response) => {
  const { ruleIds, resourceIds, accountIds } = req.body ?? {};
  const scope = ruleIds?.length ? `${ruleIds.length} rule(s)` : "all rules";
  try {
    const result = await invokeEngine({ ruleIds, resourceIds, accountIds, dryRun: true });
    // A preview writes nothing to AWS, which is exactly why it is worth a row:
    // it reads every resource the real sweep would, so it costs the same and is
    // indistinguishable from a run in every log but this one.
    await logActivity("aws.guardrail.preview", req.user!.login, "*", scope,
      `Previewed AWS guardrails: ${result.violations ?? 0} violation(s) found, nothing written`);
    res.json(result);
  } catch (err) {
    await logActivity("aws.guardrail.preview", req.user!.login, "*", scope,
      "AWS guardrail preview failed", undefined, "app", undefined, undefined,
      { failed: true, errorMessage: (err as Error)?.message ?? String(err) });
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

// ── Exclusion lists ───────────────────────────────────────────────────

/**
 * Refuse a malformed list rather than storing one that cannot be read.
 *
 * `resources` and `whitelist` are matched with `.includes` and `.some`. A
 * string sent where an array belongs makes the first match on substrings, so
 * "prod" would exclude "prod-logs" and everything else containing it, and
 * makes the second throw mid-sweep. Neither is visible until a rule runs.
 */
function badExclusionShape(b: { resources?: unknown; patterns?: unknown; whitelist?: unknown }): string | null {
  for (const [field, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `${field} must be an array`;
    if (field !== "patterns" && v.some(x => typeof x !== "string")) {
      return `${field} must contain only resource identifiers`;
    }
  }
  const patterns = b.patterns as any[] | undefined;
  const allowed = new Set(["starts_with", "contains", "tag_equals"]);
  for (const p of patterns ?? []) {
    // An unknown type matches nothing, so storing one leaves a rule somebody
    // believes is excluding when it is not.
    if (!p || typeof p !== "object" || !allowed.has(p.type)) {
      return `pattern type must be one of ${[...allowed].join(", ")}`;
    }
    if (typeof p.value !== "string" || p.value === "") {
      return "pattern value must not be empty";
    }
  }
  return null;
}

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
    const bad = badExclusionShape({ resources, patterns, whitelist });
    if (bad) { res.status(400).json({ error: bad }); return; }
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
    const bad = badExclusionShape({ resources, patterns, whitelist });
    if (bad) { res.status(400).json({ error: bad }); return; }
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

    // Every rule pointing at this list, because each of them evaluated its own
    // resources against the contents that just changed.
    const findingsRefreshed = await recheckRules(
      listContentChanged(existing, updated)
        ? rulesUsingList(updated.id, await listGuardrails())
        : [],
    );
    res.json({ ...updated, findingsRefreshed });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/**
 * Deleting a list, but not out from under a rule that is using it.
 *
 * A rule stores exclusion lists by id, and the sweep resolves them with a
 * filter: an id naming a list that no longer exists simply does not match, so
 * the rule keeps running with one fewer exclusion and says nothing. The effect
 * is that deleting a list silently widens every rule that named it, and the
 * first sign is findings appearing for resources somebody had deliberately
 * carved out, with nothing to connect them to the deletion.
 *
 * So it is refused while anything still points at it, and the rules are named
 * so the fix is obvious. Unlinking them automatically would be the same silent
 * widening with an extra step.
 */
router.delete("/exclusions/:id", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const inUse = (await listGuardrails())
      .filter(r => r.exclusionLists?.includes(req.params.id))
      .map(r => r.name);
    if (inUse.length > 0) {
      res.status(409).json({
        error: `Still used by ${inUse.length} rule${inUse.length === 1 ? "" : "s"}: `
          + `${inUse.join(", ")}. Remove it from ${inUse.length === 1 ? "that rule" : "those rules"} first, `
          + "or deleting it would quietly stop excluding what they exclude today.",
        rules: inUse,
      });
      return;
    }
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
