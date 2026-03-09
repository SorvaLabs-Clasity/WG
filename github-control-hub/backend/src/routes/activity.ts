import { Router } from "express";
import type { Request, Response } from "express";
import { getActivity, getActivityForRepo, getActivityCount } from "../services/activityService";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const repo = req.query.repo as string | undefined;

  const entries = repo
    ? await getActivityForRepo(repo, limit)
    : await getActivity(limit, offset);

  res.json({
    entries,
    total: await getActivityCount(),
    limit,
    offset,
  });
});

export default router;
