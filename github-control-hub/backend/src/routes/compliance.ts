import { Router, Request, Response } from "express";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { getComplianceConfig, updateComplianceConfig } from "../services/complianceConfigService";
import { getCachedScores, refreshAll, refreshRepo } from "../services/complianceCacheService";
import { sanitizeError } from "../utils/errorSanitizer";
import { logSync, SCHEDULE_ACTOR } from "../services/activityService";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

const router = Router();

/**
 * Reading a compliance score is open. Changing what "compliant" means is not.
 *
 * `PUT /config` replaces the rule set the whole organization is scored
 * against — every weight, every required file, and whether each rule runs at
 * all. Sending `{"rules": []}` scores every repository 100 and empties the
 * dashboard, and it was reachable by anyone with a session. That is the same
 * shared-configuration argument that already gates scanners, widgets, alerts
 * and the config import; this router was exempted as "read models over the
 * graph", which was true of everything in it except this.
 *
 * The two refresh routes are gated for the second reason `/graph/aggregate` is:
 * they walk repositories with the app's own credentials, so they spend the
 * organization's GitHub budget rather than the caller's, and they overwrite a
 * cache everyone reads.
 */
async function refuseUnlessAdmin(res: Response, login: string, verb: string, userToken?: string): Promise<boolean> {
  if (await isControlHubAdmin(login, userToken)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb}. ` +
      `Compliance rules are one shared definition of what the whole organization is scored against.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

router.get("/config", async (_req: Request, res: Response) => {
  try {
    const config = await getComplianceConfig();
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "compliance") });
  }
});

router.put("/config", async (req: Request, res: Response) => {
  try {
    if (await refuseUnlessAdmin(res, req.user!.login, "change the compliance rules", req.user!.accessToken)) return;
    const { rules } = req.body;
    if (!Array.isArray(rules)) {
      return res.status(400).json({ error: "'rules' must be an array" });
    }
    const config = await updateComplianceConfig(rules);
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "compliance") });
  }
});

router.get("/dashboard", async (_req: Request, res: Response) => {
  try {
    const scores = await getCachedScores();
    res.json(scores);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "compliance") });
  }
});

router.post("/dashboard/refresh", async (req: Request, res: Response) => {
  try {
    if (await refuseUnlessAdmin(res, req.user!.login, "re-score every repository", req.user!.accessToken)) return;
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }
    const startedAt = Date.now();
    try {
      const scores = await refreshAll(token);
      await logSync("compliance", req.user?.login ?? SCHEDULE_ACTOR, {
        details: `Scored ${scores.length} repositories`,
        startedAt,
      });
      res.json(scores);
    } catch (err: any) {
      // Logged before rethrowing, so a run that burned the rate limit half way
      // through leaves a record of having been attempted. A missing row here
      // reads as "nobody refreshed", which is the wrong conclusion to draw.
      await logSync("compliance", req.user?.login ?? SCHEDULE_ACTOR, {
        details: "Scoring failed", failed: true,
        error: err?.message ?? String(err), startedAt,
      });
      throw err;
    }
  } catch (error: any) {
    if (error?.status === 403 && /rate limit/i.test(error?.message || "")) {
      return res.status(429).json({ error: "GitHub API rate limit exceeded. Please try again later." });
    }
    res.status(500).json({ error: sanitizeError(error, "compliance") });
  }
});

router.post("/dashboard/refresh/:repo", async (req: Request, res: Response) => {
  try {
    if (await refuseUnlessAdmin(res, req.user!.login, "re-score a repository", req.user!.accessToken)) return;
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }
    const repo = req.params.repo as string;
    const startedAt = Date.now();
    const score = await refreshRepo(token, repo);
    await logSync("compliance", req.user?.login ?? SCHEDULE_ACTOR, {
      target: repo,
      details: `Rescored ${repo}` + (typeof score?.score === "number" ? ` — ${score.score}` : ""),
      startedAt,
    });
    res.json(score);
  } catch (error: any) {
    if (error?.status === 403 && /rate limit/i.test(error?.message || "")) {
      return res.status(429).json({ error: "GitHub API rate limit exceeded. Please try again later." });
    }
    res.status(500).json({ error: sanitizeError(error, "compliance") });
  }
});

export default router;
