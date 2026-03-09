import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert } from "../services/alertService";

const router = Router();

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

const SYSTEM_GITHUB_TOKEN = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

function verifySignature(req: Request): boolean {
  if (!WEBHOOK_SECRET) return false;

  const signature = req.headers["x-hub-signature-256"] as string;
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  const payloadStr = JSON.stringify(req.body); 
  hmac.update(payloadStr);
  
  const expectedSignature = `sha256=${hmac.digest("hex")}`;
  
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch (e) {
    return false;
  }
}

router.post("/github", async (req: Request, res: Response) => {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (!verifySignature(req)) {
      console.error("Webhook signature verification failed");
      return res.status(401).send("Unauthorized");
    }
  }

  const event = req.headers["x-github-event"];
  const payload = req.body;

  console.log(`[Webhook] Received GitHub event: ${event}`);

  let repoName: string | null = null;
  
  if (payload.repository) {
    repoName = payload.repository.name;
  }

  if (repoName) {
    if (event === "repository" && payload.action === "publicized") {
      await createAlert(repoName, "repo_made_public", `Repository ${repoName} was made public.`, "critical");
    }

    if (event === "member" && payload.action === "added") {
      const userAdded = payload.member?.login;
      await createAlert(repoName, "admin_added", `User ${userAdded} was added to ${repoName}. Verify privileges.`, "medium");
    }

    if (event === "team" && payload.action === "added_to_repository") {
      await createAlert(repoName, "team_added", `Team ${payload.team?.name} was added to ${repoName}.`, "medium");
    }

    if (event === "team" && payload.action === "removed_from_repository") {
      await createAlert(repoName, "team_removed", `Team ${payload.team?.name} was removed from ${repoName}.`, "medium");
    }

    if (event === "team" && payload.action === "edited" && payload.changes?.repository?.permissions) {
      await createAlert(repoName, "team_permission_changed", `Team ${payload.team?.name} permissions were changed in ${repoName}.`, "high");
    }

    if (event === "branch_protection_rule") {
      if (payload.action === "deleted") {
        await createAlert(repoName, "protection_removed", `Branch protection was completely removed.`, "critical");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Branch protection rules were modified (drift detected).`, "high");
      }
    }

    if (event === "repository_ruleset") {
      if (payload.action === "deleted") {
        await createAlert(repoName, "ruleset_disabled", `A repository ruleset was deleted.`, "critical");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Repository ruleset was modified (drift detected).`, "high");
      }
    }
  }

  if (event === "repository" && (payload.action === "created" || payload.action === "unarchived")) {
    repoName = payload.repository.name;
  } else if (event === "branch_protection_rule" || event === "repository_ruleset" || event === "create" || event === "delete") {
    if (payload.repository) {
      repoName = payload.repository.name;
    }
  }

  res.status(202).send("Accepted");

  if (repoName) {
    console.log(`[Webhook] Scheduling compliance scan for repository: ${repoName}`);
    
    setTimeout(async () => {
      try {
        if (!SYSTEM_GITHUB_TOKEN) {
          console.warn("[Webhook] SYSTEM_GITHUB_TOKEN is not set. Cannot run automated background scan.");
          return;
        }

        const octokit = new Octokit({ auth: SYSTEM_GITHUB_TOKEN });
        
        const scanners = await listScanners();
        const relevantScanners = scanners.filter(s => 
          s.targetRepos === "all" || 
          (Array.isArray(s.targetRepos) && s.targetRepos.includes(repoName!)) ||
          s.includeFutureRepos
        );

        for (const scanner of relevantScanners) {
          console.log(`[Webhook] Running scanner '${scanner.name}' against repo '${repoName}'`);
          await runScan(octokit, scanner.id, [repoName]); 
        }

      } catch (err) {
        console.error(`[Webhook] Error executing background scan for ${repoName}:`, err);
      }
    }, 1000);
  }
});

export default router;
