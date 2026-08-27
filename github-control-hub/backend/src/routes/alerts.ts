import { Router, Request, Response } from "express";
import { getAlerts, createAlert } from "../services/alertService";
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

router.get("/", async (req: Request, res: Response) => {
  try {
    const alerts = await getAlerts();
    res.json(alerts);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

/*
 * There is no route to clear an alert, and that is the feature.
 *
 * An alert is a record of something that happened, not a task. Clearing one by
 * hand wrote `resolvedBy: "<someone>"` into a row nobody ever opened again,
 * and asking for it on every routine change is what turned a security tab into
 * a queue nobody could keep up with. Rows age out on their own now, and the
 * only thing that still sets `resolved` is the webhook worker noticing that
 * the change was undone. See REVERTED_BY in services/alertService.ts.
 */

router.post("/simulate", async (req: Request, res: Response) => {
  try {
    if (await refusedAlertChange(res, req.user!.login, "create", req.user!.accessToken)) return;
    const { scenario } = req.body;
    
    switch (scenario) {
      case "compromised_dev":
        await createAlert("api-gateway", "suspicious_activity", "User 'dev-john' pushed to 40 repos in 5 minutes.", "critical");
        break;
      case "malicious_pr":
        await createAlert("web-platform", "protection_drift", "Branch protection bypassed for malicious PR on 'main'.", "high");
        break;
      case "force_push":
        await createAlert("design-system", "protection_drift", "Force push protection disabled on 'main'.", "high");
        break;
      case "privilege_escalation":
        await createAlert("infrastructure", "user_promoted", "User 'guest-user' promoted to Admin.", "critical");
        break;
      default:
        return res.status(400).json({ error: "Unknown scenario" });
    }
    
    res.json({ message: "Simulation triggered" });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});


export default router;
