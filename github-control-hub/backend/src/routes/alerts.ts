import { Router, Request, Response } from "express";
import { getAlertsPage, DEFAULT_WINDOW_WEEKS } from "../services/alertService";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

const router = Router();

/**
 * Resolving an alert is the org's record that a security finding was dealt
 * with — a public repository, an admin added, protection removed. Anyone could
 * clear that record, or reopen a closed one, which makes the whole security
 * view something no one can rely on. Reading stays open; changing state does
 * not.
 *
 * /simulate creates alerts outright, so it is gated for the same reason.
 */
async function refusedAlertChange(res: Response, login: string, verb: string, userToken?: string): Promise<boolean> {
  if (await isControlHubAdmin(login, userToken)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `security alerts. The record of what was dealt with is the point of them.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

/**
 * One page of alerts, newest first.
 *
 * `?since=<iso>` bounds the window and defaults to the twelve weeks the
 * Security tab charts. `?cursor=` continues into older rows.
 *
 * This used to return the whole table on every request, which is fine at
 * seventeen rows and ships megabytes at ten thousand. The response now says
 * whether it is complete, so the page can state what it is showing rather than
 * drawing a truncated list as if it were everything.
 */
router.get("/", async (req: Request, res: Response) => {
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
