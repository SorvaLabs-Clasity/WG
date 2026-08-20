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
import { createOctokit, getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { logSync } from "../services/activityService";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

const router = Router();

/**
 * Scanners are org-wide and run with elevated credentials.
 *
 * Defining one decides what gets searched for across every repository, and
 * /:id/run executes it with the system token rather than the caller's — so an
 * ordinary member could have used a scan to read repositories GitHub would
 * never have shown them directly. Reading definitions and past results stays
 * open; creating, editing, deleting and running do not.
 */
async function refusedScannerChange(res: Response, login: string, verb: string, userToken?: string): Promise<boolean> {
  if (await isControlHubAdmin(login, userToken)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `scanners, because a scan searches every repository using the app's own credentials.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

router.get("/", async (req: Request, res: Response) => {
  res.json(await listScanners());
});

router.post("/", async (req: Request, res: Response) => {
  if (await refusedScannerChange(res, req.user!.login, "create", req.user!.accessToken)) return;

  const { name, description, conditions, targetRepos, includeFutureRepos } = req.body;
  const scanner = await createScanner({ name, description, conditions, targetRepos, includeFutureRepos }, req.user!.login);
  res.status(201).json(scanner);
});

router.put("/:id", async (req: Request<{id: string}>, res: Response) => {
  if (await refusedScannerChange(res, req.user!.login, "edit", req.user!.accessToken)) return;

  const { name, description, conditions, targetRepos, includeFutureRepos } = req.body;
  const scanner = await updateScanner(req.params.id, { name, description, conditions, targetRepos, includeFutureRepos }, req.user!.login);
  if (!scanner) {
    res.status(404).json({ error: "Scanner not found" });
    return;
  }
  res.json(scanner);
});

router.delete("/:id", async (req: Request<{id: string}>, res: Response) => {
  if (await refusedScannerChange(res, req.user!.login, "delete", req.user!.accessToken)) return;

  const success = await deleteScanner(req.params.id, req.user!.login);
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
  if (await refusedScannerChange(res, req.user!.login, "run", req.user!.accessToken)) return;

  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      res.status(401).json({ error: "No GitHub token available. Sign in again." });
      return;
    }
    const octokit = createOctokit(token);
    const startedAt = Date.now();
    let result;
    try {
      result = await runScan(octokit, req.params.id, undefined, token);
    } catch (err: any) {
      await logSync("scanner", req.user!.login, {
        target: req.params.id, details: "Scan failed", failed: true,
        error: err?.message ?? String(err), startedAt,
      });
      throw err;
    }
    await logSync("scanner", req.user!.login, {
      target: req.params.id,
      details: `Scanned ${result.totalScanned} repositories — `
        + `${result.nonCompliantCount} in violation, ${result.compliantCount} compliant`,
      startedAt,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: sanitizeError(err, "scanners") });
  }
});

export default router;
