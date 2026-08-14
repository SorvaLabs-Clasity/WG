import { Router, Request, Response } from "express";
import { getUsage } from "../services/billingService";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

const router = Router();

/**
 * What the organisation spends, per repository.
 *
 * Admin-only, and read-only. Everything else in this app is gated because it
 * *changes* something; this is gated because of what it discloses. Spend is
 * commercial information — how much a team costs to run, which projects are
 * expensive, when activity dropped off — and it is not something every member
 * with a login should be able to read.
 */
router.get("/usage", async (req: Request, res: Response) => {
  try {
    const login = req.user?.login;
    if (!login || !(await isControlHubAdmin(login))) {
      return res.status(403).json({
        error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can view billing usage.`,
        code: "CONTROL_HUB_ADMIN_REQUIRED",
      });
    }

    const months = Math.max(1, Math.min(24, Number(req.query.months) || 6));
    res.json(await getUsage(months));
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    // 403 from GitHub here means the token cannot read billing, which is a
    // different problem from the caller not being an admin of this app. Said
    // plainly, because the two are easy to confuse while debugging.
    if (error?.status === 403) {
      return res.status(502).json({
        error: "GitHub refused the billing request. The GitHub App needs the "
          + "\"organization_administration: read\" permission, or the signed-in user needs admin:org.",
        code: "GITHUB_BILLING_FORBIDDEN",
      });
    }
    if (error?.status === 410) {
      return res.status(502).json({
        error: "GitHub has retired this billing endpoint. The app needs updating to whatever replaced it.",
        code: "GITHUB_BILLING_GONE",
      });
    }
    res.status(500).json({ error: sanitizeError(error, "billing") });
  }
});

export default router;
