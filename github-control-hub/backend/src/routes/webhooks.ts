import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg, getSystemToken } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity, updateActivityOutcome } from "../services/activityService";
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

  // Nothing about the code itself is recorded here.
  //
  // push, pull_request and issues are subscribed because other parts of this
  // file react to them, but they describe what developers are building, not
  // what the Control Hub or anyone else did to the org's configuration. Mixing
  // the two buries a branch-protection change under a hundred commits.
  //
  // Branch creation is deliberately not recorded either. GitHub fires `create`
  // for every branch anyone makes, including the ones this app made a moment
  // earlier — which is where the duplicate rows came from. The app logs the
  // branches it creates itself, with the undo payload attached, and those are
  // the only branch creations worth a row.
  //
  // Undo does not depend on any of this. It asks GitHub for the branch's
  // current state at the moment it runs, so it still sees commits, merges,
  // squashes and rebases that were never written here.

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

/*
 * Auto-apply of templates to newly created repositories was removed here.
 *
 * It was the only GitHub *write* in the webhook path — createRef,
 * createOrUpdateFileContents, updateBranchProtection and createRepoRuleset all
 * lived inside it — along with a five-second provisioning wait and up to four
 * retries. What remains is the compliance refresh, the graph edges and the
 * scanner runs below, none of which write to GitHub.
 */

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
