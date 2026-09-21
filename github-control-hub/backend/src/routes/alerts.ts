import { Router, Request, Response } from "express";
import { getAlertsPage, DEFAULT_WINDOW_WEEKS } from "../services/alertService";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { requirePermission } from "../middleware/permissionGate";

const router = Router();

/**
 * One page of alerts, newest first.
 *
 * `?since=<iso>` bounds the window and defaults to the twelve weeks the
 * Security tab charts. `?cursor=` continues into older rows.
 *
 * The response says whether it is complete, so the page can state what it is
 * showing rather than drawing a truncated list as if it were everything.
 */
router.get("/", requirePermission("activity.read.app.rows"), async (req: Request, res: Response) => {
  try {
    const weeks = DEFAULT_WINDOW_WEEKS;
    const since = typeof req.query.since === "string" && req.query.since
      ? req.query.since
      : new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();

    const page = await getAlertsPage({
      since,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit: Number(req.query.limit) || undefined,
    });

    res.json({ ...page, since, windowWeeks: weeks });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

/*
 * `POST /alerts/simulate` was removed.
 *
 * It injected four hardcoded alerts naming repositories that do not exist
 * ("api-gateway", "web-platform", "design-system", "infrastructure") and was
 * left over from the mock-data era. Nothing in the app called it: the client
 * kept a `useSimulateAlert` hook that no screen ever used.
 *
 * The reason to delete it rather than leave it: it wrote **real rows into the
 * real alerts table**, indistinguishable from genuine ones once written. That
 * was tolerable when an alert was a queue item somebody would clear. It is not
 * now that alerts are the permanent security record, expire on their own, and
 * feed the drift check, which compares against what is on that record.
 */

export default router;
