import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";

const router = Router();

/**
 * Where the GitHub allowance goes.
 *
 * Cached for half a minute. Both halves are live numbers and the counters are
 * flushed every thirty seconds, so a shorter cache would repaint the same
 * figures; a longer one would make a limit look stuck while it recovered.
 */
let cache: { at: number; hours: number; report: any } | null = null;
const CACHE_MS = 30_000;

router.get("/", async (req: Request, res: Response) => {
  try {
    // One hour matches the allowance's own window, so headroom and usage
    // describe the same period. Twenty-four is offered for the shape of a day.
    const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 1));
    if (cache && cache.hours === hours && Date.now() - cache.at < CACHE_MS) {
      return res.json({ ...cache.report, cached: true });
    }
    // Write this process's buffer before reading, so a request made a moment
    // ago is on the page rather than up to half a minute behind it. The other
    // processes flush at the end of their own pass; this is the one whose
    // requests somebody has just made by clicking around.
    const { flushUsage } = await import("../services/githubUsageService");
    await flushUsage().catch(() => { /* the report still stands */ });

    const { buildBudgetReport } = await import("../services/githubBudgetService");
    const report = await buildBudgetReport(hours);
    cache = { at: Date.now(), hours, report };
    res.json({ ...report, cached: false });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "github budget") });
  }
});

export default router;
