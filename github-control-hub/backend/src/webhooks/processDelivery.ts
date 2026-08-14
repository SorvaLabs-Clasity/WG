import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity } from "../services/activityService";
import { refreshRepo } from "../services/complianceCacheService";
import {
  addBranchEdge, removeBranchEdge, updateBranchProtection,
  addCollaboratorEdge, removeCollaboratorEdge, addRepoEdges,
} from "../services/graphEdgeService";

export interface Delivery {
  event: string;
  deliveryId: string;
  payload: any;
  /**
   * Resolved once per invocation by the worker rather than read from the
   * module singleton. Lambda freezes containers between invocations, so the
   * refresh timer behind the synchronous getSystemToken() does not fire on
   * schedule — a warm container would serve a cached token until it expired
   * and then fall back to SYSTEM_GITHUB_TOKEN, stopping auto-apply with
   * "No GitHub token available" on some containers and not others.
   */
  token: string;
}

/** Strip characters that could be used for XSS when reflected in the frontend. */
function sanitizeField(val: string | undefined, maxLen = 200): string {
  if (!val || typeof val !== "string") return "";
  return val.replace(/[<>"'&]/g, "").slice(0, maxLen);
}

/** How long the best-effort enrichment may take before it is abandoned. */
const BACKGROUND_CEILING_MS = 4 * 60 * 1000;

/**
 * Wait for the best-effort work, but never fail on it and never wait forever.
 *
 * Both halves matter, and both protect the same thing. If a rejecting task
 * could throw out of processDelivery, the worker would release its claim, SQS
 * would redeliver, and the delivery would be reprocessed — writing a second set
 * of alerts and activity rows, up to five times. Promise.allSettled is what
 * prevents that, so it is not interchangeable with Promise.all however much
 * tidier that looks.
 *
 * The ceiling prevents the same outcome arriving as a timeout instead: work
 * that runs long carries the invocation past its limit, Lambda kills it,
 * completeDelivery never runs, the lease expires and SQS redelivers.
 *
 * Abandoning a scan costs a stale compliance cache until the next event for
 * that repository. Abandoning an invocation costs a duplicated set of alerts
 * and activity rows.
 */
export async function awaitBackground(
  tasks: Promise<unknown>[],
  ceilingMs: number = BACKGROUND_CEILING_MS,
): Promise<void> {
  if (tasks.length === 0) return;

  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[Webhook] Background work exceeded ${ceilingMs}ms — abandoning it so the delivery can be marked done`);
      resolve();
    }, ceilingMs);
  });

  try {
    await Promise.race([Promise.allSettled(tasks).then(() => undefined), ceiling]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function processDelivery({ event, payload, token }: Delivery): Promise<void> {
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
        await logActivity("repo.ruleset.delete", actor, repoName, sanitizeField(String(payload.ruleset?.id || ""), 64), "Ruleset deleted via GitHub", undefined, "github");
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
    // Sanitised like every other field taken from a payload. A branch name is
    // the one string here that can legally hold < > " ' & — Git's ref rules
    // forbid spaces and ~^:?*[\ but not those — so this is the field most
    // able to carry markup, and it was the one going through raw.
    const repo = sanitizeField(payload.repository.name, 100);
    const actorLogin = sanitizeField(payload.sender?.login, 64) || "github";
    await logActivity("branch.delete", actorLogin, repo, sanitizeField(payload.ref, 100) || "branch", "Branch deleted via GitHub", undefined, "github");
  }

  if (event === "repository" && (payload.action === "created" || payload.action === "unarchived")) {
    repoName = sanitizeField(payload.repository.name, 100) || null;
  } else if (event === "branch_protection_rule" || event === "repository_ruleset" || event === "create" || event === "delete") {
    if (payload.repository) {
      repoName = sanitizeField(payload.repository.name, 100) || null;
    }
  }

/*
 * Auto-apply of templates to newly created repositories was removed here.
 *
 * It was the only GitHub *write* in the webhook path — createRef,
 * createOrUpdateFileContents, updateBranchProtection and createRepoRuleset all
 * lived inside it — along with a five-second provisioning wait and up to four
 * retries. What remains is the compliance refresh, the graph edges and the
 * scanner runs below, none of which write to GitHub.
 */

  // Work that used to outlive the HTTP response.
  //
  // In Lambda the container freezes when this function resolves, so an
  // unawaited promise may never settle and a one-second timer may never fire.
  // These are collected rather than awaited in place so that one failing does
  // not prevent the others from running — which is what the bare .catch()
  // handlers gave us before.
  const background: Promise<unknown>[] = [];

  const shouldRefreshCompliance =
    event === "branch_protection_rule" ||
    event === "repository_ruleset" ||
    event === "member" ||
    (event === "repository" && payload.action === "created") ||
    (event === "push" && payload.ref === `refs/heads/${payload.repository?.default_branch}`);

  if (repoName && token && shouldRefreshCompliance) {
    console.log(`[Webhook] Refreshing compliance cache for ${repoName}`);
    background.push(refreshRepo(token, repoName).catch((err) =>
      console.error(`[Webhook] Compliance refresh failed for ${repoName}:`, (err as Error).message)
    ));
  }

  // Incremental graph edge updates
  const org = getOrg();
  try {
    // Sanitised before it is stored, like every other payload string. A graph
    // edge is a row the UI renders, so the branch name reaching it raw was the
    // same gap as the activity log's.
    const branchRef = sanitizeField(payload.ref, 100);

    if (event === "create" && payload.ref_type === "branch" && repoName && branchRef) {
      console.log(`[Webhook] Adding graph edge: branch "${branchRef}" in ${repoName}`);
      await addBranchEdge(repoName, branchRef, false);
    }

    if (event === "delete" && payload.ref_type === "branch" && repoName && branchRef) {
      console.log(`[Webhook] Removing graph edge: branch "${branchRef}" from ${repoName}`);
      await removeBranchEdge(repoName, branchRef);
    }

    if (event === "repository" && payload.action === "created" && repoName && token) {
      console.log(`[Webhook] Adding all graph edges for new repo "${repoName}"`);
      background.push(addRepoEdges(token, org, repoName).catch((err) =>
        console.error(`[Webhook] Graph edge sync failed for new repo ${repoName}:`, (err as Error).message)
      ));
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

  // Background compliance scans.
  //
  // The one-second setTimeout this replaces existed to let the HTTP response
  // go out first. There is no response to get out of the way of here.
  if (repoName) {
    console.log(`[Webhook] Scheduling compliance scan for repository: ${repoName}`);
    background.push((async () => {
      try {
        if (!token) {
          console.warn("[Webhook] No GitHub token available. Cannot run automated background scan.");
          return;
        }
        const octokit = new Octokit({ auth: token });
        const scanners = await listScanners();
        const relevantScanners = scanners.filter(s =>
          s.targetRepos === "all" ||
          (Array.isArray(s.targetRepos) && s.targetRepos.includes(repoName!)) ||
          s.includeFutureRepos
        );
        for (const scanner of relevantScanners) {
          console.log(`[Webhook] Running scanner '${scanner.name}' against repo '${repoName}'`);
          await runScan(octokit, scanner.id, [repoName!]);
        }
      } catch (err) {
        console.error(`[Webhook] Error executing background tasks for ${repoName}:`, err);
      }
    })());
  }

  await awaitBackground(background);
}
