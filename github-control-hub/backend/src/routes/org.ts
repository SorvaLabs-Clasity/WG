import { Router, Request, Response } from "express";
import { getOrgConfig } from "../services/orgConfigService";

const router = Router();

router.get("/config", async (req: Request, res: Response) => {
  try {
    const config = await getOrgConfig();
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
