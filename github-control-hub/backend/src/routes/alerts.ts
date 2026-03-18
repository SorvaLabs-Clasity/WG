import { Router, Request, Response } from "express";
import { getAlerts, resolveAlert, unresolveAlert, createAlert } from "../services/alertService";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const alerts = await getAlerts();
    res.json(alerts);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

router.post("/:id/resolve", async (req: Request, res: Response) => {
  try {
    const user = req.user?.login || "system";
    const alertId = req.params.id as string;
    const alert = await resolveAlert(alertId, user);
    if (!alert) {
      return res.status(404).json({ error: "Alert not found" });
    }
    res.json(alert);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

router.post("/:id/unresolve", async (req: Request, res: Response) => {
  try {
    const alertId = req.params.id as string;
    const alert = await unresolveAlert(alertId);
    if (!alert) {
      return res.status(404).json({ error: "Alert not found" });
    }
    res.json(alert);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

router.post("/simulate", async (req: Request, res: Response) => {
  try {
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
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

router.get("/inactive-users", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token available" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    const { data: members } = await octokit.rest.orgs.listMembers({ org, per_page: 100 });

    const inactiveUsers: { username: string; lastActive: string; role: string }[] = [];
    const cutoff = Date.now() - (180 * 24 * 60 * 60 * 1000);

    for (const member of members) {
      try {
        // Get the user's GitHub profile to check account creation date
        const { data: userProfile } = await octokit.rest.users.getByUsername({
          username: member.login,
        });

        // If account was created within the cutoff period, they can't be stale
        const accountCreated = new Date(userProfile.created_at).getTime();
        if (accountCreated >= cutoff) continue;

        const { data: events } = await octokit.rest.activity.listPublicEventsForUser({
          username: member.login,
          per_page: 1,
        });
        const lastEvent = events[0];
        // Use the later of: last public event OR account creation date (not 1970)
        const lastActive = lastEvent?.created_at || userProfile.created_at;

        if (new Date(lastActive).getTime() < cutoff) {
          const { data: membership } = await octokit.rest.orgs.getMembershipForUser({
            org,
            username: member.login,
          });
          inactiveUsers.push({
            username: member.login,
            lastActive,
            role: membership.role,
          });
        }
      } catch {
        // skip members we can't fetch events for
      }
    }

    res.json(inactiveUsers);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alerts") });
  }
});

export default router;
