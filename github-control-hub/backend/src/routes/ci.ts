import { Router, Request, Response } from "express";
import { listFailures, correlate, WINDOW_HOURS } from "../services/ciFailureService";
import { sanitizeError } from "../utils/errorSanitizer";

const router = Router();

/**
 * Correlated failure clusters.
 *
 * Reads only what the webhook already stored — no GitHub call at all, so this
 * costs nothing to open and can be refreshed freely.
 */
router.get("/clusters", async (req: Request, res: Response) => {
  try {
    const hours = Math.min(72, Math.max(1, Number(req.query.hours) || WINDOW_HOURS));
    const failures = await listFailures();
    const clusters = correlate(failures, Date.now(), { windowHours: hours });
    res.json({
      windowHours: hours,
      clusters,
      // The total is what makes an empty cluster list readable: no clusters
      // with 40 failures means everything is failing separately, which is a
      // different thing from nothing failing at all.
      failuresInWindow: failures.filter(f => {
        const t = new Date(f.failedAt).getTime();
        return Number.isFinite(t) && Date.now() - t <= hours * 3_600_000;
      }).length,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "CI failures") });
  }
});

export default router;
