import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity, updateActivityOutcome } from "../services/activityService";
import { listTemplates, applyTemplate } from "../services/templateService";
import { resolveExcludedReposFromIds } from "../services/exclusionService";
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
 * would redeliver, and the delivery would be reprocessed — re-applying
 * templates and writing a second set of template.apply rows, up to five times.
 * Promise.allSettled is what prevents that, so it is not interchangeable with
 * Promise.all however much tidier that looks.
 *
 * The ceiling prevents the same outcome arriving as a timeout instead: work
 * that runs long carries the invocation past its limit, Lambda kills it,
 * completeDelivery never runs, the lease expires and SQS redelivers.
 *
 * Abandoning a scan costs a stale compliance cache until the next event for
 * that repository. Abandoning an invocation costs a repository having its
 * templates applied twice.
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
  // earlier from a template — which is where the duplicate rows came from. The
  // app logs its own template branches directly, with the undo payload
  // attached, and those are the only branch creations worth a row.
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

  // Auto-apply templates to newly created repos (runs after response to avoid webhook timeouts)
  if (event === "repository" && payload.action === "created" && repoName) {
    if (token) {
      const octokit = new Octokit({ auth: token });
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

          // These entries are written before the work runs so that child entries
          // logged inside applyTemplate have a parent to hang off. They therefore
          // describe intent, not outcome — both are rewritten below once the
          // result is known, so a failed apply never reads as a success.
          const parentEntry = await logActivity(
            "template.apply",
            "system (auto-apply)",
            repoName,
            tmpl.name,
            `Applying template "${tmpl.name}" to new repo "${repoName}"…`
          );

          // Create repo-level child activity entry
          const repoEntry = await logActivity(
            "template.apply.repo" as any,
            "system (auto-apply)",
            repoName,
            tmpl.name,
            `Applying template "${tmpl.name}" to ${repoName}…`,
            undefined, "app", undefined, undefined,
            { parentId: parentEntry.id }
          );

          // A partial failure (errors returned rather than thrown) is still a
          // failure — retry it, otherwise a half-applied repo is never revisited.
          let failureMessage: string | null = null;
          for (let attempt = 1; attempt <= 4; attempt++) {
            failureMessage = null;
            try {
              const result = await applyTemplate(octokit, tmpl.id, repoName, "system (auto-apply)", repoEntry.id);
              console.log(`[Webhook] Template "${tmpl.name}" applied to "${repoName}": created=${result.created.join(",")}, protected=${result.protected.join(",")}, errors=${result.errors.length}`);
              if (result.errors.length > 0) {
                failureMessage = result.errors.join("; ");
                console.warn(`[Webhook] Auto-apply attempt ${attempt}/4 incomplete for "${tmpl.name}" on "${repoName}":`, result.errors);
              }
            } catch (applyErr) {
              failureMessage = (applyErr as Error).message;
              console.warn(`[Webhook] Auto-apply attempt ${attempt}/4 failed for "${tmpl.name}" on "${repoName}":`, failureMessage);
            }
            if (!failureMessage) break;
            if (attempt < 4) {
              await new Promise(r => setTimeout(r, attempt * 4000));
            }
          }

          if (failureMessage) {
            console.error(`[Webhook] All attempts to auto-apply template "${tmpl.name}" to "${repoName}" failed.`);
            const failDetails = `Failed to auto-apply template "${tmpl.name}" to "${repoName}"`;
            await updateActivityOutcome(parentEntry.id, { details: failDetails, failed: true, errorMessage: failureMessage });
            await updateActivityOutcome(repoEntry.id, { details: failDetails, failed: true, errorMessage: failureMessage });
          } else {
            await updateActivityOutcome(parentEntry.id, { details: `Auto-applied template "${tmpl.name}" to new repo "${repoName}"`, failed: false });
            await updateActivityOutcome(repoEntry.id, { details: `Auto-applied template "${tmpl.name}" to ${repoName}`, failed: false });
          }
        }
      } catch (err) {
        console.error(`[Webhook] Error fetching templates for auto-apply:`, err);
      }
    } else {
      console.warn("[Webhook] No GitHub token available. Cannot auto-apply templates.");
    }
  }

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
    if (event === "create" && payload.ref_type === "branch" && repoName && payload.ref) {
      console.log(`[Webhook] Adding graph edge: branch "${payload.ref}" in ${repoName}`);
      await addBranchEdge(repoName, payload.ref, false);
    }

    if (event === "delete" && payload.ref_type === "branch" && repoName && payload.ref) {
      console.log(`[Webhook] Removing graph edge: branch "${payload.ref}" from ${repoName}`);
      await removeBranchEdge(repoName, payload.ref);
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
