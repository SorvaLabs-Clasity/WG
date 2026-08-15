import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
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
router.post("/refresh", async (_req: Request, res: Response) => {
  invalidateAccessMap();
  res.json({ refreshed: true });
});

export default router;
