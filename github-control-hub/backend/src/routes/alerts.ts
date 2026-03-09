import { Router, Request, Response } from "express";
import { getAlerts, resolveAlert, createAlert } from "../services/alertService";

const router = Router();

// GET /api/alerts
router.get("/", (req: Request, res: Response) => {
  try {
    const alerts = getAlerts();
    res.json(alerts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/alerts/:id/resolve
router.post("/:id/resolve", (req: Request, res: Response) => {
  try {
    const user = req.user?.login || "system";
    const alert = resolveAlert(req.params.id, user);
    if (!alert) {
      return res.status(404).json({ error: "Alert not found" });
    }
    res.json(alert);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/alerts/simulate
router.post("/simulate", (req: Request, res: Response) => {
  try {
    const { scenario } = req.body;
    
    switch (scenario) {
      case "compromised_dev":
        createAlert("api-gateway", "suspicious_activity", "User 'dev-john' pushed to 40 repos in 5 minutes.", "critical");
        break;
      case "malicious_pr":
        createAlert("web-platform", "protection_drift", "Branch protection bypassed for malicious PR on 'main'.", "high");
        break;
      case "force_push":
        createAlert("design-system", "protection_drift", "Force push protection disabled on 'main'.", "high");
        break;
      case "privilege_escalation":
        createAlert("infrastructure", "user_promoted", "User 'guest-user' promoted to Admin.", "critical");
        break;
      default:
        return res.status(400).json({ error: "Unknown scenario" });
    }
    
    res.json({ message: "Simulation triggered" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/alerts/inactive-users
router.get("/inactive-users", (req: Request, res: Response) => {
  try {
    // Mock inactive users (180 days)
    const inactiveUsers = [
      { username: "old-contractor", lastActive: new Date(Date.now() - 1000 * 60 * 60 * 24 * 190).toISOString(), role: "collaborator" },
      { username: "former-employee", lastActive: new Date(Date.now() - 1000 * 60 * 60 * 24 * 210).toISOString(), role: "member" },
      { username: "test-bot-2024", lastActive: new Date(Date.now() - 1000 * 60 * 60 * 24 * 300).toISOString(), role: "admin" }
    ];
    res.json(inactiveUsers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
