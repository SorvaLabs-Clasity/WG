import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity } from "../services/activityService";
import { listTemplates, applyTemplate } from "../services/templateService";
import { listExclusions, getExclusion } from "../services/exclusionService";
import { refreshRepo } from "../services/complianceCacheService";
import { addBranchEdge, removeBranchEdge, updateBranchProtection, addCollaboratorEdge, removeCollaboratorEdge, addRepoEdges } from "../services/graphEdgeService";

const router = Router();

function getWebhookSecret(): string {
  return process.env.GITHUB_WEBHOOK_SECRET || "";
}

function getSystemToken(): string {
  return process.env.SYSTEM_GITHUB_TOKEN || "";
}

// Verify webhook signature against raw body bytes (set by express.json verify callback in server.ts)
function verifySignature(req: Request): boolean {
  const secret = getWebhookSecret();
  if (!secret) return false;

  const signature = req.headers["x-hub-signature-256"] as string;
  if (!signature) return false;

  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) return false;

  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Replay protection: track recent delivery IDs to reject duplicates
const DELIVERY_TTL_MS = 5 * 60 * 1000;
const processedDeliveries = new Map<string, number>();

function isDuplicateDelivery(deliveryId: string): boolean {
  const now = Date.now();
  // Prune expired entries when map gets large
  if (processedDeliveries.size > 1000) {
    for (const [id, ts] of processedDeliveries) {
      if (now - ts > DELIVERY_TTL_MS) processedDeliveries.delete(id);
    }
  }
  if (processedDeliveries.has(deliveryId)) return true;
  processedDeliveries.set(deliveryId, now);
  return false;
}

router.post("/github", async (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    console.error("Webhook signature verification failed");
    return res.status(401).send("Unauthorized");
  }

  // Reject replayed webhooks
  const deliveryId = req.headers["x-github-delivery"] as string;
  if (!deliveryId || isDuplicateDelivery(deliveryId)) {
    return res.status(200).send("Duplicate or missing delivery ID");
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

    if (event === "repository" && payload.action === "privatized") {
      await autoResolveAlerts(repoName, "repo_made_public");
    }

    if (event === "branch_protection_rule") {
      if (payload.action === "deleted") {
        await createAlert(repoName, "protection_removed", `Branch protection was completely removed.`, "critical");
        await logActivity("branch.unprotect", actor, repoName, payload.changes?.name?.from || "branch", "Branch protection removed via GitHub", undefined, "github");
      } else if (payload.action === "created") {
        await autoResolveAlerts(repoName, "protection_removed");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Branch protection rules were modified (drift detected).`, "high");
        await logActivity("github.branch_protection_edited", actor, repoName, payload.rule?.name || "branch", "Branch protection rules modified", undefined, "github");
      }
    }

    if (event === "repository_ruleset") {
      if (payload.action === "deleted") {
        await createAlert(repoName, "ruleset_disabled", `A repository ruleset was deleted.`, "critical");
        await logActivity("repo.ruleset.delete", actor, repoName, String(payload.ruleset?.id || ""), "Ruleset deleted via GitHub", undefined, "github");
      } else if (payload.action === "created") {
        await autoResolveAlerts(repoName, "ruleset_disabled");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Repository ruleset was modified (drift detected).`, "high");
        await logActivity("github.ruleset_edited", actor, repoName, payload.ruleset?.name || "ruleset", "Repository ruleset modified", undefined, "github");
      }
    }

    if (event === "member" && payload.action === "removed") {
      await autoResolveAlerts(repoName, "admin_added");
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

  // Auto-apply templates to newly created repos
  if (event === "repository" && payload.action === "created" && repoName) {
    if (getSystemToken()) {
      const octokit = new Octokit({ auth: getSystemToken() });
      try {
        const templates = await listTemplates();
        const autoApplyTemplates = templates.filter(t => t.autoApplyOnNewRepo);
        for (const tmpl of autoApplyTemplates) {
          // Check exclusion lists before applying
          const excludedRepos = new Set<string>();
          if (tmpl.exclusionLists && tmpl.exclusionLists.length > 0) {
            for (const listId of tmpl.exclusionLists) {
              const excl = await getExclusion(listId);
              if (excl) excl.repos.forEach(r => excludedRepos.add(r));
            }
          }
          if (excludedRepos.has(repoName)) {
            console.log(`[Webhook] Skipping auto-apply of "${tmpl.name}" — repo "${repoName}" is in exclusion list`);
            continue;
          }

          console.log(`[Webhook] Auto-applying template "${tmpl.name}" to new repo "${repoName}"`);

          let lastErr: unknown;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const result = await applyTemplate(octokit, tmpl.id, repoName, "system (auto-apply)");
              console.log(`[Webhook] Template "${tmpl.name}" applied to "${repoName}": created=${result.created.join(",")}, protected=${result.protected.join(",")}, errors=${result.errors.length}`);
              if (result.errors.length > 0) {
                console.warn(`[Webhook] Template "${tmpl.name}" errors:`, result.errors);
              }
              lastErr = null;
              break;
            } catch (applyErr) {
              lastErr = applyErr;
              console.warn(`[Webhook] Auto-apply attempt ${attempt}/3 failed for "${tmpl.name}" on "${repoName}":`, (applyErr as Error).message);
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, attempt * 3000));
              }
            }
          }
          if (lastErr) {
            console.error(`[Webhook] All attempts to auto-apply template "${tmpl.name}" to "${repoName}" failed.`);
          }
        }
      } catch (err) {
        console.error(`[Webhook] Error fetching templates for auto-apply:`, err);
      }
    } else {
      console.warn("[Webhook] SYSTEM_GITHUB_TOKEN is not set. Cannot auto-apply templates.");
    }
  }

  res.status(202).send("Accepted");

  const shouldRefreshCompliance =
    event === "branch_protection_rule" ||
    event === "repository_ruleset" ||
    event === "member" ||
    (event === "repository" && payload.action === "created") ||
    (event === "push" && payload.ref === `refs/heads/${payload.repository?.default_branch}`);

  if (repoName && getSystemToken() && shouldRefreshCompliance) {
    console.log(`[Webhook] Refreshing compliance cache for ${repoName}`);
    refreshRepo(getSystemToken(), repoName).catch((err) =>
      console.error(`[Webhook] Compliance refresh failed for ${repoName}:`, (err as Error).message)
    );
  }

  // Incremental graph edge updates
  const org = getOrg();
  try {
    if (event === "create" && payload.ref_type === "branch" && repoName && payload.ref) {
      console.log(`[Webhook] Adding graph edge: branch "${payload.ref}" in ${repoName}`);
      await addBranchEdge(repoName, payload.ref, false);
    }

    if (event === "delete" && payload.ref_type === "branch" && repoName && payload.ref) {
      console.log(`[Webhook] Removing graph edge: branch "${payload.ref}" from ${repoName}`);
      await removeBranchEdge(repoName, payload.ref);
    }

    if (event === "repository" && payload.action === "created" && repoName) {
      const token = getSystemToken() || (req as any).user?.accessToken;
      if (token) {
        console.log(`[Webhook] Adding all graph edges for new repo "${repoName}"`);
        addRepoEdges(token, org, repoName).catch((err) =>
          console.error(`[Webhook] Graph edge sync failed for new repo ${repoName}:`, (err as Error).message)
        );
      }
    }

    if (event === "member" && repoName && payload.member?.login) {
      const user = payload.member.login;
      if (payload.action === "added") {
        const role = payload.changes?.permission?.to || "read";
        console.log(`[Webhook] Adding graph edge: collaborator "${user}" on ${repoName}`);
        await addCollaboratorEdge(repoName, user, role);
      } else if (payload.action === "removed") {
        console.log(`[Webhook] Removing graph edge: collaborator "${user}" from ${repoName}`);
        await removeCollaboratorEdge(repoName, user);
      }
    }

    if (event === "branch_protection_rule" && repoName) {
      const branchName = payload.rule?.name;
      if (branchName) {
        const isProtected = payload.action !== "deleted";
        console.log(`[Webhook] Updating graph edge: branch "${branchName}" protection=${isProtected} in ${repoName}`);
        await updateBranchProtection(repoName, branchName, isProtected);
      }
    }
  } catch (graphErr) {
    console.error(`[Webhook] Graph edge update failed:`, (graphErr as Error).message);
  }

  // Background compliance scans
  if (repoName) {
    console.log(`[Webhook] Scheduling compliance scan for repository: ${repoName}`);
    
    setTimeout(async () => {
      try {
        if (!getSystemToken()) {
          console.warn("[Webhook] SYSTEM_GITHUB_TOKEN is not set. Cannot run automated background scan.");
          return;
        }

        const octokit = new Octokit({ auth: getSystemToken() });

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
        console.error(`[Webhook] Error executing background tasks for ${repoName}:`, err);
      }
    }, 1000);
  }
});

export default router;
