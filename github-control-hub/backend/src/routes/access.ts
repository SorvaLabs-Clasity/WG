import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { logSync, SCHEDULE_ACTOR } from "../services/activityService";
import {
  accessSummary, accessForUser, accessForRepo, knownRepos, invalidateAccessMap,
} from "../services/accessMapService";

/**
 * Who can reach what.
 *
 * Read-only by design. This answers the access-review question and stops
 * there — removing someone's access is a decision with consequences that
 * belongs where the consequences are visible, not behind a button on a map.
 *
 * Open to anyone signed in, like the rest of the reporting surface. Knowing
 * who can write to which repository is not privileged information inside an
 * organization; it is the thing people most often get wrong because nobody
 * could see it.
 */

const router = Router();

router.get("/summary", async (_req: Request, res: Response) => {
  try {
    res.json(await accessSummary());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "access") });
  }
});

router.get("/user/:login", async (req: Request<{ login: string }>, res: Response) => {
  try {
    res.json(await accessForUser(req.params.login));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "access") });
  }
});

router.get("/repo/:repo", async (req: Request<{ repo: string }>, res: Response) => {
  try {
    res.json(await accessForRepo(req.params.repo));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "access") });
  }
});

router.get("/teams", async (_req: Request, res: Response) => {
  try {
    const { teamSummary } = await import("../services/accessMapService");
    res.json(await teamSummary());
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "access") });
  }
});

router.get("/team/:slug", async (req: Request<{ slug: string }>, res: Response) => {
  try {
    const { accessForTeam } = await import("../services/accessMapService");
    res.json(await accessForTeam(String(req.params.slug)));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "access") });
  }
});

router.get("/repos", async (_req: Request, res: Response) => {
  try {
    res.json(await knownRepos());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "access") });
  }
});

/** Drop the derived view so a fresh graph sync shows up without waiting a minute. */
/**
 * Drops the derived map so the next read recomputes it from the stored edges.
 *
 * Not a sync: it goes nowhere near GitHub, and it cannot pick up an access
 * change that has not been collected yet. Logged all the same, and worded so the
 * distinction is legible — somebody reading the feed to work out why a change is
 * not showing needs to see that this ran and that it was not the thing that
 * would have helped.
 */
router.post("/refresh", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  invalidateAccessMap();
  await logSync("access", req.user?.login ?? SCHEDULE_ACTOR, {
    details: "Recomputed the access map from stored data — no GitHub read",
    startedAt,
  });
  res.json({ refreshed: true });
});

export default router;
