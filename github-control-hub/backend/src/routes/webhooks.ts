import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert } from "../services/alertService";

const router = Router();

// Retrieve the webhook secret from env, or provide a dummy one for dev/demo if not configured
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "development_secret_only";

// GitHub Personal Access Token or App Token needs to be configured on the backend for webhook-driven scans.
// Since webhooks happen asynchronously in the background, there is no user token in the request.
// In a real scenario, this should be a machine user token or GitHub App installation token.
const SYSTEM_GITHUB_TOKEN = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

/**
 * Verify GitHub webhook signature
 */
function verifySignature(req: Request): boolean {
  const signature = req.headers["x-hub-signature-256"] as string;
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  // We need the raw body to verify the signature accurately.
  // Express.json() parses it, so we might need a custom middleware if verification fails.
  // Assuming basic verification for now; for production, use a raw-body parser for webhooks.
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
  // In a strict production environment, uncomment this to enforce signature validation:
  /*
  if (!verifySignature(req)) {
    console.error("Webhook signature verification failed");
    return res.status(401).send("Unauthorized");
  }
  */

  const event = req.headers["x-github-event"];
  const payload = req.body;

  console.log(`[Webhook] Received GitHub event: ${event}`);

  // Determine if this event is relevant to compliance scanning
  let repoName: string | null = null;
  
  if (payload.repository) {
    repoName = payload.repository.name;
  }

  // --- Check for Security Alerts ---
  if (repoName) {
    if (event === "repository" && payload.action === "publicized") {
      createAlert(
        repoName,
        "repo_made_public",
        `Repository ${repoName} was made public.`,
        "critical"
      );
    }

    if (event === "member" && payload.action === "added") {
      const userAdded = payload.member?.login;
      createAlert(
        repoName,
        "admin_added",
        `User ${userAdded} was added to ${repoName}. Verify privileges.`,
        "medium"
      );
    }

    if (event === "team" && payload.action === "added_to_repository") {
      createAlert(
        repoName,
        "team_added",
        `Team ${payload.team?.name} was added to ${repoName}.`,
        "medium"
      );
    }

    if (event === "team" && payload.action === "removed_from_repository") {
      createAlert(
        repoName,
        "team_removed",
        `Team ${payload.team?.name} was removed from ${repoName}.`,
        "medium"
      );
    }

    if (event === "team" && payload.action === "edited" && payload.changes?.repository?.permissions) {
      createAlert(
        repoName,
        "team_permission_changed",
        `Team ${payload.team?.name} permissions were changed in ${repoName}.`,
        "high"
      );
    }

    // This is mocked as a 'push' event check. In reality, we'd need to track push frequency across repos.
    if (event === "push") {
      // Mock tracking of suspicious activity
      const pusher = payload.pusher?.name || payload.sender?.login;
      if (pusher && Math.random() < 0.01) { // 1% chance to trigger for demo
        createAlert(
          repoName,
          "suspicious_activity",
          `User ${pusher} pushed to multiple repos rapidly. Possible compromised account.`,
          "critical"
        );
      }
    }

    if (event === "branch_protection_rule") {
      if (payload.action === "deleted") {
        createAlert(
          repoName,
          "protection_removed",
          `Branch protection was completely removed.`,
          "critical"
        );
      } else if (payload.action === "edited") {
        createAlert(
          repoName,
          "protection_drift",
          `Branch protection rules were modified (drift detected).`,
          "high"
        );
      }
    }

    if (event === "repository_ruleset") {
      if (payload.action === "deleted") {
        createAlert(
          repoName,
          "ruleset_disabled",
          `A repository ruleset was deleted.`,
          "critical"
        );
      } else if (payload.action === "edited") {
        createAlert(
          repoName,
          "protection_drift",
          `Repository ruleset was modified (drift detected).`,
          "high"
        );
      }
    }
  }
  // ---------------------------------

  if (event === "repository" && (payload.action === "created" || payload.action === "unarchived")) {
    repoName = payload.repository.name;
  } else if (event === "branch_protection_rule" || event === "repository_ruleset" || event === "create" || event === "delete") {
    // If a branch is created/deleted or a rule changes, we re-scan the repo
    if (payload.repository) {
      repoName = payload.repository.name;
    }
  }

  // Acknowledge receipt to GitHub quickly
  res.status(202).send("Accepted");

  if (repoName) {
    console.log(`[Webhook] Scheduling compliance scan for repository: ${repoName}`);
    
    // In background, run scan
    setTimeout(async () => {
      try {
        if (!SYSTEM_GITHUB_TOKEN) {
          console.warn("[Webhook] SYSTEM_GITHUB_TOKEN is not set. Cannot run automated background scan.");
          return;
        }

        const octokit = new Octokit({ auth: SYSTEM_GITHUB_TOKEN });
        
        // Find scanners that target this repo or "all"
        const scanners = listScanners();
        const relevantScanners = scanners.filter(s => 
          s.targetRepos === "all" || 
          (Array.isArray(s.targetRepos) && s.targetRepos.includes(repoName!)) ||
          s.includeFutureRepos
        );

        for (const scanner of relevantScanners) {
          console.log(`[Webhook] Running scanner '${scanner.name}' against repo '${repoName}'`);
          // Note: runScan currently expects to be able to scan multiple repos based on scanner config.
          // To make it efficient for just ONE repo, we could modify `runScan` to accept an optional `overrideRepoList` argument.
          // For now, if the scanner targets "all", it will rescan all, which is safe but less efficient.
          // In a real optimized system, we'd pass `[repoName]` to a `runScanOnRepos` function.
          await runScan(octokit, scanner.id, [repoName]); 
        }

      } catch (err) {
        console.error(`[Webhook] Error executing background scan for ${repoName}:`, err);
      }
    }, 1000); // Small delay to let GitHub's backend settle the event
  }
});

export default router;