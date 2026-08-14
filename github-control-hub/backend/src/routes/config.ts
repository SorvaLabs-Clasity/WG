import { Router } from "express";
import type { Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { logActivity } from "../services/activityService";
import { listWidgets, putWidgetRaw } from "../services/widgetService";
import { listScanners, putScannerRaw } from "../services/scannerService";
import { listGuardrails, putGuardrail, listAwsExclusions, putAwsExclusion } from "../aws-guardrails/store";

const router = Router();

/**
 * Everything the organisation configured, as one document.
 *
 * Scanners, widgets and guardrails live only in DynamoDB. Standing up a second
 * account — which the migration script does with a set of empty tables — meant
 * rebuilding all of it by hand, each record retyped and each a chance to get it
 * subtly wrong.
 *
 * Findings and activity are deliberately not included. They are observations
 * about one account at one time, not configuration, and carrying them to
 * another account would be importing somebody else's history as your own.
 */

/**
 * 2 since the templates, ruleTemplates and exclusions sections were removed.
 *
 * Import only rejects `format > FORMAT`, so a format-1 bundle still imports and
 * its template sections are simply no longer iterated — harmless. The bump is
 * for the other direction: an older build reading a format-2 bundle would find
 * `bundle.templates` undefined, and this makes it say "written by a newer
 * version" instead of failing on the missing section.
 */
export const FORMAT = 2;

export interface ConfigBundle {
  format: number;
  exportedAt: string;
  exportedBy: string;
  org: string | null;
  counts: Record<string, number>;
  scanners: any[];
  widgets: any[];
  awsGuardrails: any[];
  awsExclusions: any[];
}

async function refuseUnlessAdmin(res: Response, login: string, verb: string): Promise<boolean> {
  if (await isControlHubAdmin(login)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `configuration — it is every scanner, widget and guardrail the organisation runs on.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

router.get("/export", async (req: Request, res: Response) => {
  if (await refuseUnlessAdmin(res, req.user!.login, "export")) return;
  try {
    const [scanners, widgets, awsGuardrails, awsExclusions] =
      await Promise.all([
        listScanners(), listWidgets(), listGuardrails(), listAwsExclusions(),
      ]);

    const bundle: ConfigBundle = {
      format: FORMAT,
      exportedAt: new Date().toISOString(),
      exportedBy: req.user!.login,
      org: process.env.GITHUB_ORG ?? null,
      counts: {
        scanners: scanners.length, widgets: widgets.length,
        awsGuardrails: awsGuardrails.length, awsExclusions: awsExclusions.length,
      },
      scanners, widgets, awsGuardrails, awsExclusions,
    };

    res.setHeader("Content-Disposition",
      `attachment; filename="control-hub-config-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "config") });
  }
});

export type BundleWriters = Record<string, (x: any) => Promise<unknown>>;

/**
 * Anything without an id is reported rather than written — an id is what makes
 * an import idempotent, and inventing one would turn a re-import into a
 * duplicate rather than an update.
 */
export const SECTION_ORDER = [
  "scanners", "widgets", "awsGuardrails", "awsExclusions",
] as const;

const DEFAULT_WRITERS: BundleWriters = {
  scanners: putScannerRaw,
  widgets: putWidgetRaw,
  awsGuardrails: putGuardrail,
  awsExclusions: putAwsExclusion,
};

export async function applyBundle(
  bundle: Partial<ConfigBundle>,
  dryRun: boolean,
  writers: BundleWriters,
): Promise<{ applied: Record<string, number>; errors: string[] }> {
  const applied: Record<string, number> = {};
  const errors: string[] = [];

  for (const name of SECTION_ORDER) {
    const items = (bundle as any)[name];
    if (!Array.isArray(items)) continue;
    applied[name] = 0;
    for (const item of items) {
      if (!item?.id) { errors.push(`${name}: an entry has no id and was skipped`); continue; }
      if (dryRun) { applied[name]++; continue; }
      try {
        await writers[name](item);
        applied[name]++;
      } catch (err) {
        errors.push(`${name}/${item.id}: ${(err as Error).message}`);
      }
    }
  }

  return { applied, errors };
}

/**
 * Apply a bundle.
 *
 * Existing records with the same id are overwritten and everything else is left
 * alone: an import adds to an account rather than replacing it, because
 * replacing would silently delete whatever the target had that the source did
 * not, and nothing about pressing "import" suggests that.
 *
 * `dryRun` reports what would change without writing, since the honest answer
 * to "what will this do to my production account" is a list, not a promise.
 */
router.post("/import", async (req: Request, res: Response) => {
  if (await refuseUnlessAdmin(res, req.user!.login, "import")) return;
  try {
    const bundle = req.body as Partial<ConfigBundle>;
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    if (!bundle || typeof bundle !== "object" || typeof bundle.format !== "number") {
      res.status(400).json({ error: "That does not look like a Control Hub configuration export." });
      return;
    }
    if (bundle.format > FORMAT) {
      res.status(400).json({
        error: `This export was written by a newer version (format ${bundle.format}, this app reads ${FORMAT}). Upgrade before importing.`,
      });
      return;
    }

    const { applied, errors } = await applyBundle(bundle, dryRun, DEFAULT_WRITERS);

    if (!dryRun) {
      const total = Object.values(applied).reduce((a, b) => a + b, 0);
      await logActivity(
        "config.import", req.user!.login, "*", "configuration",
        `Imported ${total} configuration ${total === 1 ? "record" : "records"} ` +
        `from an export taken ${bundle.exportedAt ?? "at an unknown time"}` +
        (bundle.org && bundle.org !== process.env.GITHUB_ORG ? ` for ${bundle.org}` : ""),
        undefined, "app"
      );
    }

    res.json({ dryRun, applied, errors, from: { org: bundle.org ?? null, exportedAt: bundle.exportedAt ?? null } });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "config") });
  }
});

export default router;
