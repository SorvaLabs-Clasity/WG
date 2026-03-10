import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert } from "../services/alertService";
import { logActivity } from "../services/activityService";

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

  const actor = payload.sender?.login || payload.installation?.account?.login || "github";

  if (repoName) {
    if (event === "repository" && payload.action === "publicized") {
      await createAlert(repoName, "repo_made_public", `Repository ${repoName} was made public.`, "critical");
      await logActivity("repo.publicized", actor, repoName, repoName, "Repository was made public", undefined, "github");
    }

    if (event === "repository" && (payload.action === "created" || payload.action === "unarchived")) {
      await logActivity("repo.created", actor, repoName, repoName, payload.action === "created" ? "Repository created" : "Repository unarchived", undefined, "github");
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
        await logActivity("branch.unprotect", actor, repoName, payload.changes?.name?.from || "branch", "Branch protection removed via GitHub", undefined, "github");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Branch protection rules were modified (drift detected).`, "high");
        await logActivity("github.branch_protection_edited", actor, repoName, payload.rule?.name || "branch", "Branch protection rules modified", undefined, "github");
      }
    }

    if (event === "repository_ruleset") {
      if (payload.action === "deleted") {
        await createAlert(repoName, "ruleset_disabled", `A repository ruleset was deleted.`, "critical");
        await logActivity("repo.ruleset.delete", actor, repoName, String(payload.ruleset?.id || ""), "Ruleset deleted via GitHub", undefined, "github");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Repository ruleset was modified (drift detected).`, "high");
        await logActivity("github.ruleset_edited", actor, repoName, payload.ruleset?.name || "ruleset", "Repository ruleset modified", undefined, "github");
      }
    }
  }

  if (event === "push" && payload.repository?.name && !payload.created && !payload.deleted) {
    const repo = payload.repository.name;
    const ref = payload.ref || "";
    const branch = ref.replace("refs/heads/", "");
    const actorLogin = payload.sender?.login || "github";
    await logActivity("github.push", actorLogin, repo, branch, payload.head_commit?.message?.slice(0, 200) || "Push", undefined, "github", undefined, payload.after);
  }

  if (event === "pull_request" && payload.repository?.name) {
    const repo = payload.repository.name;
    const pr = payload.pull_request;
    const actorLogin = payload.sender?.login || pr?.user?.login || "github";
    const branch = pr?.head?.ref || "";
    const prNum = pr?.number;
    if (payload.action === "opened") {
      await logActivity("github.pr_opened", actorLogin, repo, branch, pr?.title?.slice(0, 200), undefined, "github", prNum);
    } else if (payload.action === "closed") {
      if (pr?.merged) {
        await logActivity("github.pr_merged", actorLogin, repo, branch, pr?.title?.slice(0, 200), undefined, "github", prNum);
      } else {
        await logActivity("github.pr_closed", actorLogin, repo, branch, pr?.title?.slice(0, 200), undefined, "github", prNum);
      }
    }
  }

  if (event === "issues" && payload.action === "opened" && payload.repository?.name) {
    const repo = payload.repository.name;
    const actorLogin = payload.sender?.login || payload.issue?.user?.login || "github";
    await logActivity("github.issue_opened", actorLogin, repo, String(payload.issue?.number || ""), payload.issue?.title?.slice(0, 200), undefined, "github");
  }

  if (event === "create" && payload.ref_type === "branch" && payload.repository?.name) {
    const repo = payload.repository.name;
    const actorLogin = payload.sender?.login || "github";
    await logActivity("branch.create", actorLogin, repo, payload.ref || "branch", "Branch created via GitHub", undefined, "github");
  }

  if (event === "delete" && payload.ref_type === "branch" && payload.repository?.name) {
    const repo = payload.repository.name;
    const actorLogin = payload.sender?.login || "github";
    await logActivity("branch.delete", actorLogin, repo, payload.ref || "branch", "Branch deleted via GitHub", undefined, "github");
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
