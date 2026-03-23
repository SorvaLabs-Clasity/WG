import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg, getSystemToken } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity } from "../services/activityService";
import { listTemplates, applyTemplate } from "../services/templateService";
import { listExclusions, getExclusion, resolveExcludedReposFromIds } from "../services/exclusionService";
import { refreshRepo } from "../services/complianceCacheService";
import { addBranchEdge, removeBranchEdge, updateBranchProtection, addCollaboratorEdge, removeCollaboratorEdge, addRepoEdges } from "../services/graphEdgeService";

const router = Router();

/** Strip characters that could be used for XSS when reflected in the frontend. */
function sanitizeField(val: string | undefined, maxLen = 200): string {
  if (!val || typeof val !== "string") return "";
  return val.replace(/[<>"'&]/g, "").slice(0, maxLen);
}

function getWebhookSecret(): string {
  return process.env.GITHUB_WEBHOOK_SECRET || "";
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
    repoName = sanitizeField(payload.repository.name, 100) || null;
  }

  const actor = sanitizeField(payload.sender?.login || payload.installation?.account?.login, 64) || "github";

  if (repoName) {
    if (event === "repository" && payload.action === "publicized") {
      await createAlert(repoName, "repo_made_public", `Repository ${repoName} was made public.`, "critical");
      await logActivity("repo.publicized", actor, repoName, repoName, "Repository was made public", undefined, "github");
    }

    if (event === "repository" && (payload.action === "created" || payload.action === "unarchived")) {
      await logActivity("repo.created", actor, repoName, repoName, payload.action === "created" ? "Repository created" : "Repository unarchived", undefined, "github");
    }

    if (event === "member" && payload.action === "added") {
      const userAdded = sanitizeField(payload.member?.login, 64);
      await createAlert(repoName, "admin_added", `User ${userAdded} was added to ${repoName}. Verify privileges.`, "medium");
    }

    if (event === "team" && payload.action === "added_to_repository") {
      await createAlert(repoName, "team_added", `Team ${sanitizeField(payload.team?.name, 100)} was added to ${repoName}.`, "medium");
    }

    if (event === "team" && payload.action === "removed_from_repository") {
      await createAlert(repoName, "team_removed", `Team ${sanitizeField(payload.team?.name, 100)} was removed from ${repoName}.`, "medium");
    }

    if (event === "team" && payload.action === "edited" && payload.changes?.repository?.permissions) {
      await createAlert(repoName, "team_permission_changed", `Team ${sanitizeField(payload.team?.name, 100)} permissions were changed in ${repoName}.`, "high");
    }

    if (event === "repository" && payload.action === "privatized") {
      await autoResolveAlerts(repoName, "repo_made_public");
    }

    if (event === "branch_protection_rule") {
      if (payload.action === "deleted") {
        await createAlert(repoName, "protection_removed", `Branch protection was completely removed.`, "critical");
        await logActivity("branch.unprotect", actor, repoName, sanitizeField(payload.changes?.name?.from, 100) || "branch", "Branch protection removed via GitHub", undefined, "github");
      } else if (payload.action === "created") {
        await autoResolveAlerts(repoName, "protection_removed");
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift", `Branch protection rules were modified (drift detected).`, "high");
        await logActivity("github.branch_protection_edited", actor, repoName, sanitizeField(payload.rule?.name, 100) || "branch", "Branch protection rules modified", undefined, "github");
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
        await logActivity("github.ruleset_edited", actor, repoName, sanitizeField(payload.ruleset?.name, 100) || "ruleset", "Repository ruleset modified", undefined, "github");
      }
    }

    if (event === "member" && payload.action === "removed") {
      await autoResolveAlerts(repoName, "admin_added");
    }
  }

  if (event === "push" && payload.repository?.name && !payload.created && !payload.deleted) {
    const repo = sanitizeField(payload.repository.name, 100);
    const ref = sanitizeField(payload.ref, 255);
    const branch = ref.replace("refs/heads/", "");
    const actorLogin = sanitizeField(payload.sender?.login, 64) || "github";
    await logActivity("github.push", actorLogin, repo, branch, sanitizeField(payload.head_commit?.message, 200) || "Push", undefined, "github", undefined, payload.after);
  }

  if (event === "pull_request" && payload.repository?.name) {
    const repo = sanitizeField(payload.repository.name, 100);
    const pr = payload.pull_request;
    const actorLogin = sanitizeField(payload.sender?.login || pr?.user?.login, 64) || "github";
    const branch = sanitizeField(pr?.head?.ref, 255);
    const prNum = pr?.number;
    if (payload.action === "opened") {
      await logActivity("github.pr_opened", actorLogin, repo, branch, sanitizeField(pr?.title, 200), undefined, "github", prNum);
    } else if (payload.action === "closed") {
      if (pr?.merged) {
        await logActivity("github.pr_merged", actorLogin, repo, branch, sanitizeField(pr?.title, 200), undefined, "github", prNum);
      } else {
        await logActivity("github.pr_closed", actorLogin, repo, branch, sanitizeField(pr?.title, 200), undefined, "github", prNum);
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

  // Auto-apply templates to newly created repos (runs after response to avoid webhook timeouts)
  if (event === "repository" && payload.action === "created" && repoName) {
    if (getSystemToken()) {
      const octokit = new Octokit({ auth: getSystemToken() });
      try {
        const templates = await listTemplates();
        const autoApplyTemplates = templates.filter(t => t.autoApplyOnNewRepo);

        // Wait for GitHub to fully provision the new repo before attempting API calls
        if (autoApplyTemplates.length > 0) {
          await new Promise(r => setTimeout(r, 5000));
        }

        const webhookCreator = payload.sender?.login;

        for (const tmpl of autoApplyTemplates) {
          // Check exclusion lists (explicit repos + patterns) before applying
          const excludedRepos: Set<string> = tmpl.exclusionLists?.length
            ? await resolveExcludedReposFromIds(tmpl.exclusionLists, octokit, { repoName, creator: webhookCreator })
            : new Set<string>();
          if (excludedRepos.has(repoName)) {
            console.log(`[Webhook] Skipping auto-apply of "${tmpl.name}" — repo "${repoName}" is in exclusion list`);
            continue;
          }

          console.log(`[Webhook] Auto-applying template "${tmpl.name}" to new repo "${repoName}"`);

          // Create parent activity entry (mirrors manual apply pattern)
          const parentEntry = await logActivity(
            "template.apply",
            "system (auto-apply)",
            repoName,
            tmpl.name,
            `Auto-applied template "${tmpl.name}" to new repo "${repoName}"`
          );

          // Create repo-level child activity entry
          const repoEntry = await logActivity(
            "template.apply.repo" as any,
            "system (auto-apply)",
            repoName,
            tmpl.name,
            `Auto-applied template "${tmpl.name}" to ${repoName}`,
            undefined, "app", undefined, undefined,
            { parentId: parentEntry.id }
          );

          let lastErr: unknown;
          for (let attempt = 1; attempt <= 4; attempt++) {
            try {
              const result = await applyTemplate(octokit, tmpl.id, repoName, "system (auto-apply)", repoEntry.id);
              console.log(`[Webhook] Template "${tmpl.name}" applied to "${repoName}": created=${result.created.join(",")}, protected=${result.protected.join(",")}, errors=${result.errors.length}`);
              if (result.errors.length > 0) {
                console.warn(`[Webhook] Template "${tmpl.name}" errors:`, result.errors);
              }
              lastErr = null;
              break;
            } catch (applyErr) {
              lastErr = applyErr;
              console.warn(`[Webhook] Auto-apply attempt ${attempt}/4 failed for "${tmpl.name}" on "${repoName}":`, (applyErr as Error).message);
              if (attempt < 4) {
                await new Promise(r => setTimeout(r, attempt * 4000));
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
      console.warn("[Webhook] No GitHub token available. Cannot auto-apply templates.");
    }
  }

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
          console.warn("[Webhook] No GitHub token available. Cannot run automated background scan.");
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
