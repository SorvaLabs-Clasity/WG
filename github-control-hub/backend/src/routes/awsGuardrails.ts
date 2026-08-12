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
import {
  listRegisteredAccounts, putAccount, deleteAccount, resolveAccounts,
  verifyAccess, forgetCredentials, homeAccountId, accessMethod,
  discoverOrganizationAccounts, storeKeys, probeReachable, GUARDRAIL_ROLE_NAME,
  controlHubPrincipals, suggestExternalId,
} from "../aws-guardrails/accounts";
import { ACCOUNT_ROLE_TEMPLATE } from "../aws-guardrails/accountRoleTemplate";
import type { Guardrail, AwsExclusionList, GuardrailMode, AwsAccount } from "../aws-guardrails/types";

const router = Router();

const FUNCTION_NAME = process.env.GUARDRAIL_FUNCTION_NAME
  || `${process.env.STACK_NAME || "github-control-hub"}-guardrail-enforcer`;

/**
 * Everything that changes or triggers a guardrail is restricted to the admin
 * team. Unlike the GitHub side — where a repo action is authorised by GitHub
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
  const client = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });
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
 * The accounts guardrails run against.
 *
 * An organisation is rarely one account, and the rules that matter most —
 * retention floors, TLS-only buckets — matter most in the accounts nobody logs
 * into daily. Access is by assuming a role the target account grants, so
 * revoking it is a change made where the resources live rather than a stored
 * key to go and find.
 *
 * The account hosting the app is always listed and never carries a role. It
 * cannot be removed: an app that can be configured into seeing nothing at all,
 * while still rendering a page that says "compliant", is worse than one that
 * only sees itself.
 */

const ACCOUNT_ID = /^\d{12}$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/.+$/;

router.get("/accounts", async (_req: Request, res: Response) => {
  try {
    res.json(await resolveAccounts());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/**
 * Every account in the AWS Organization, so nobody types twelve digits.
 *
 * Returns whether each is already registered, which is the only thing the UI
 * needs to turn this into a list of checkboxes.
 */
router.get("/accounts/discover", requireAdmin, async (req: Request, res: Response) => {
  try {
    // The org-wide StackSet sets one external ID for every account, so probing
    // without it would report a correctly-deployed estate as unreachable.
    const externalId = typeof req.query.externalId === "string" ? req.query.externalId : undefined;
    const found = await discoverOrganizationAccounts();
    if (!found.ok) {
      res.json({ available: false, error: found.error, accounts: [] });
      return;
    }
    const [home, registered] = await Promise.all([homeAccountId(), listRegisteredAccounts()]);

    // Each is rattled before it is offered. This app can only assume one role
    // name and holds no fallback to an administrator role, so an account
    // without that role is not addable yet — and saying so up front beats
    // ticking five and watching four fail.
    const accounts = await Promise.all(found.accounts.map(async a => {
      const isHome = a.accountId === home;
      const probe = isHome ? { reachable: true } : await probeReachable(a.accountId, externalId);
      return {
        ...a,
        isHome,
        registered: registered.some(r => r.accountId === a.accountId),
        ...probe,
      };
    }));

    res.json({ available: true, roleName: GUARDRAIL_ROLE_NAME, rootId: found.rootId, accounts });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.post("/accounts", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { accountId, name, access, roleArn, externalId, regions, enabled,
            accessKeyId, secretAccessKey } = req.body ?? {};

    if (!ACCOUNT_ID.test(String(accountId ?? ""))) {
      res.status(400).json({ error: "An AWS account id is exactly twelve digits." });
      return;
    }
    if (!name?.trim()) {
      res.status(400).json({ error: "Give the account a name — twelve digits is not something anyone recognises under pressure." });
      return;
    }

    const home = await homeAccountId();
    const isHome = accountId === home;
    const existing = (await listRegisteredAccounts()).find(a => a.accountId === accountId);

    // The home account is reached with the role the app already has. Letting
    // someone attach a role or keys to it is a way to lock the app out of the
    // account it lives in, with no route back through the app itself.
    const method: AwsAccount["access"] = isHome ? "home" : (access ?? (roleArn ? "role" : "organization"));

    if (method === "role") {
      const match = ROLE_ARN.exec(String(roleArn ?? "").trim());
      if (!match) {
        res.status(400).json({
          error: "A role ARN looks like arn:aws:iam::<account>:role/<name>.",
        });
        return;
      }
      if (match[1] !== accountId) {
        res.status(400).json({
          error: `That role lives in account ${match[1]}, but you entered ${accountId}. One of the two is wrong.`,
        });
        return;
      }
    }

    // Keys are written to Secrets Manager and never kept on the record, so a
    // later GET /accounts cannot hand them back to a browser.
    let secretId = existing?.secretId;
    let keyHint = existing?.keyHint;
    if (method === "keys" && accessKeyId && secretAccessKey) {
      const stored = await storeKeys(accountId, String(accessKeyId).trim(), String(secretAccessKey).trim());
      secretId = stored.secretId;
      keyHint = stored.keyHint;
    }
    if (method === "keys" && !secretId) {
      res.status(400).json({ error: "Enter an access key ID and secret for this account." });
      return;
    }

    const now = new Date().toISOString();
    const account: AwsAccount = {
      accountId,
      name: name.trim(),
      access: method,
      roleArn: method === "role" ? String(roleArn).trim() : undefined,
      externalId: externalId?.trim() || undefined,
      secretId: method === "keys" ? secretId : undefined,
      keyHint: method === "keys" ? keyHint : undefined,
      regions: Array.isArray(regions) && regions.length ? regions : [process.env.AWS_REGION || "us-east-1"],
      enabled: enabled !== false,
      isHome,
      createdBy: existing?.createdBy ?? req.user!.login,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Changed credentials must not be checked against ones cached from before.
    forgetCredentials(accountId);

    // Verified before it is stored. A role that was never created, or keys that
    // were revoked, otherwise surface as an account that quietly reports
    // nothing — indistinguishable from an account with nothing wrong in it.
    const reachable = await verifyAccess(account);
    if (!reachable.ok) {
      res.status(400).json({ error: reachable.error, code: "ACCOUNT_UNREACHABLE" });
      return;
    }
    await putAccount(account);
    await logActivity("aws.account.save" as any, req.user!.login, "*", account.name,
      existing
        ? `Updated AWS account "${account.name}" (${accountId})`
        : `Added AWS account "${account.name}" (${accountId}) via ${reachable.via}, swept in ${account.regions.join(", ")}`);
    res.json({ ...account, via: reachable.via });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

router.delete("/accounts/:accountId", requireAdmin, async (req: Request<{ accountId: string }>, res: Response) => {
  try {
    const { accountId } = req.params;
    if (accountId === await homeAccountId()) {
      res.status(400).json({
        error: "This is the account the app runs in. It cannot be removed — turn it off instead if you only want to watch others.",
      });
      return;
    }
    const existing = (await listRegisteredAccounts()).find(a => a.accountId === accountId);
    if (!existing) {
      res.status(404).json({ error: "No such account." });
      return;
    }

    await deleteAccount(accountId);
    forgetCredentials(accountId);
    // Findings from that account stay until the next sweep rewrites the table.
    // Deleting them here would be the app claiming to know the account is clean.
    await logActivity("aws.account.delete" as any, req.user!.login, "*", existing.name,
      `Removed AWS account "${existing.name}" (${accountId}). Its findings remain until the next sweep.`);
    res.json({ removed: accountId });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/** Re-check that a stored account is still reachable, without changing anything. */
router.post("/accounts/:accountId/verify", requireAdmin, async (req: Request<{ accountId: string }>, res: Response) => {
  try {
    const account = (await resolveAccounts()).find(a => a.accountId === req.params.accountId);
    if (!account) {
      res.status(404).json({ error: "No such account." });
      return;
    }
    forgetCredentials(account.accountId);
    const result = await verifyAccess(account);
    res.json({ ...result, access: accessMethod(account) });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

/**
 * Everything needed to grant this app access to an account, pre-filled.
 *
 * The app cannot create the role itself, and that is the point rather than a
 * gap. Creating an IAM role across an organisation requires permissions —
 * cloudformation:CreateStackSet with CAPABILITY_NAMED_IAM — that would let
 * whoever held them deploy an administrator role into every account. Holding
 * that would be strictly worse than the administrator access this app was
 * deliberately built without.
 *
 * So the app does the part that has no security cost: it works out every
 * value, generates the external ID, carries the template, and builds the exact
 * commands and console links. What is left for a human is clicking Create
 * while signed in as themselves.
 */
router.get("/accounts/setup", requireAdmin, async (req: Request, res: Response) => {
  try {
    const [principals, home, org] = await Promise.all([
      controlHubPrincipals(), homeAccountId(),
      // Listed but not probed. Opening this panel should not fire an
      // AssumeRole at forty accounts; that is what "Find my accounts" is for.
      discoverOrganizationAccounts(),
    ]);
    // Reuse an ID already in play rather than handing out a new one that would
    // not match the accounts already set up with it.
    const existing = (await listRegisteredAccounts()).find(a => a.externalId)?.externalId;
    const externalId = typeof req.query.externalId === "string" && req.query.externalId
      ? req.query.externalId
      : existing ?? suggestExternalId();

    const trusted = [principals.app, principals.engine].filter(Boolean) as string[];
    const region = process.env.AWS_REGION || "us-east-1";

    res.json({
      roleName: GUARDRAIL_ROLE_NAME,
      homeAccountId: home,
      region,
      principals,
      externalId,
      reusedExternalId: !!existing,
      template: ACCOUNT_ROLE_TEMPLATE,
      templateFileName: "control-hub-guardrail-role.yaml",
      // The org-wide path. One StackSet, every account, plus accounts made
      // later — which is the only version of this that stays true.
      stackSetName: "github-control-hub-guardrail-access",
      organization: org.ok
        ? { available: true, rootId: org.rootId, accounts: org.accounts.filter(a => a.accountId !== home) }
        : { available: false, error: org.error, rootId: null, accounts: [] },
      consoleUrls: {
        stackSets: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacksets/create`,
        singleStack: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create`,
        organizations: "https://us-east-1.console.aws.amazon.com/organizations/v2/home/accounts",
      },
      parameters: {
        ControlHubRoleArns: trusted.join(","),
        RoleName: GUARDRAIL_ROLE_NAME,
        ExternalId: externalId,
        ReadOnly: "true",
      },
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "aws-guardrails") });
  }
});

export default router;
