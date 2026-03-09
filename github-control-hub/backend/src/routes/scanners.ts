import { Router } from "express";
import type { Request, Response } from "express";
import {
  listScanners,
  getScanner,
  createScanner,
  updateScanner,
  deleteScanner,
  getScanResult,
  runScan,
} from "../services/scannerService";
import { createOctokit } from "../github/client";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  res.json(await listScanners());
});

router.post("/", async (req: Request, res: Response) => {
  const scanner = await createScanner(req.body);
  res.status(201).json(scanner);
});

router.put("/:id", async (req: Request<{id: string}>, res: Response) => {
  const scanner = await updateScanner(req.params.id, req.body);
  if (!scanner) {
    res.status(404).json({ error: "Scanner not found" });
    return;
  }
  res.json(scanner);
});

router.delete("/:id", async (req: Request<{id: string}>, res: Response) => {
  const success = await deleteScanner(req.params.id);
  if (!success) {
    res.status(404).json({ error: "Scanner not found" });
    return;
  }
  res.status(204).send();
});

router.get("/:id/results", async (req: Request<{id: string}>, res: Response) => {
  const result = await getScanResult(req.params.id);
  if (!result) {
    res.status(404).json({ error: "Scan results not found" });
    return;
  }
  res.json(result);
});

router.post("/:id/run", async (req: Request<{id: string}>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const result = await runScan(octokit, req.params.id);
    res.json(result);
  } catch (err: any) {
    console.error("Error running scan:", err);
    res.status(500).json({ error: err.message || "Failed to run scan" });
  }
});

export default router;
