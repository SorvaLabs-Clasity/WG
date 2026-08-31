import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity } from "../services/activityService";
import {
  addBranchEdge, removeBranchEdge, updateBranchProtection, removeAllRepoEdges,
  addCollaboratorEdge, removeCollaboratorEdge, addRepoEdges,
  patchRepoMeta, addTeamRepoEdge, removeTeamRepoEdge,
  addTeamMemberEdge, removeTeamMemberEdge,
  addVulnerableDependencyEdge, removeVulnerableDependencyEdge,
} from "../services/graphEdgeService";

export interface Delivery {
  event: string;
  deliveryId: string;
  payload: any;
  /**
   * Resolved once per invocation by the worker rather than read from the
   * module singleton. Lambda freezes containers between invocations, so the
   * refresh timer behind the synchronous getSystemToken() does not fire on
   * schedule, a warm container would serve a cached token until it expired
   * and then have no token at all, stopping GitHub work with
   * "No GitHub token available" on some containers and not others.
   */
  token: string;
  /**
   * When the receiver took the delivery from GitHub.
   *
   * Used as the alert's timestamp instead of the worker's own clock. GitHub
   * delivers within a second or so of the event, whereas the worker runs
   * whenever the queue reaches it, later after a retry, and much later for a
   * redelivery of an old event. A redelivery still reads as "now", because the
   * payload carries no original timestamp to recover; it is at least honest
   * about when the event was learned of.
   */
  receivedAt?: string;
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
 * would redeliver, and the delivery would be reprocessed, writing a second set
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
      console.warn(`[Webhook] Background work exceeded ${ceilingMs}ms. Abandoning it so the delivery can be marked done`);
      resolve();
    }, ceilingMs);
  });

  try {
    await Promise.race([Promise.allSettled(tasks).then(() => undefined), ceiling]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function processDelivery({ event, payload, token, receivedAt }: Delivery): Promise<void> {
  console.log(`[Webhook] Received GitHub event: ${event}`);

  let repoName: string | null = null;

  if (payload.repository) {
    repoName = sanitizeField(payload.repository.name, 100) || null;
  }

  // One timestamp for every alert this delivery produces, taken from when
  // GitHub handed it over rather than from whenever each write happens.
  const occurredAt = receivedAt || new Date().toISOString();

  // Note that GitHub reached us, before anything else can fail. Throttled to
  // one write every five minutes inside the service, and swallowed: the health
  // stamp is diagnostic, and losing it must never cost the delivery its real
  // effects.
  await import("../services/orgConfigService")
    .then(m => m.recordWebhookSeen(occurredAt))
    .catch(err => console.warn("[Webhook] Could not record delivery time:", err?.message ?? err));

  const actor = sanitizeField(payload.sender?.login || payload.installation?.account?.login, 64) || "github";

  if (repoName) {
    if (event === "repository" && payload.action === "publicized") {
      await createAlert(repoName, "repo_made_public",
        `Repository ${repoName} was made public.`, "critical", { occurredAt, actor });
      await logActivity("repo.publicized", actor, repoName, repoName, "Repository was made public", undefined, "github");
    }

    if (event === "repository" && (payload.action === "created" || payload.action === "unarchived")) {
      await logActivity("repo.created", actor, repoName, repoName, payload.action === "created" ? "Repository created" : "Repository unarchived", undefined, "github");
    }

    if (event === "member" && payload.action === "added") {
      const userAdded = sanitizeField(payload.member?.login, 64);
      await createAlert(repoName, "admin_added",
        `User ${userAdded} was added to ${repoName} by ${actor}. Verify privileges.`,
        "medium", { occurredAt, actor, subject: userAdded });
    }

    if (event === "team" && payload.action === "added_to_repository") {
      await createAlert(repoName, "team_added",
        `Team ${sanitizeField(payload.team?.name, 100)} was added to ${repoName}.`,
        "medium", { occurredAt, actor, subject: sanitizeField(payload.team?.name, 100) });
    }

    if (event === "team" && payload.action === "removed_from_repository") {
      await createAlert(repoName, "team_removed",
        `Team ${sanitizeField(payload.team?.name, 100)} was removed from ${repoName}.`,
        "medium", { occurredAt, actor, subject: sanitizeField(payload.team?.name, 100) });
    }

    if (event === "team" && payload.action === "edited" && payload.changes?.repository?.permissions) {
      await createAlert(repoName, "team_permission_changed",
        `Team ${sanitizeField(payload.team?.name, 100)} permissions were changed in ${repoName}.`,
        "high", { occurredAt, actor, subject: sanitizeField(payload.team?.name, 100) });
    }

    if (event === "repository" && payload.action === "privatized") {
      await autoResolveAlerts(repoName, "repo_made_public");
    }

    // A repository that is gone, or that is gone under this name.
    //
    // Without this every edge survived and every check kept naming it until
    // the next full rebuild cleared the table, which is up to six hours of a
    // widget reporting something already deleted. A rename is the same
    // problem wearing a different hat: the old name's edges are as stale as a
    // deleted one's, and the new name arrives on the next pass.
    if (event === "repository"
        && (payload.action === "deleted" || payload.action === "renamed")) {
      const goneAs = payload.action === "renamed"
        ? sanitizeField(payload.changes?.repository?.name?.from, 100)
        : repoName;
      if (goneAs) {
        await logActivity(
          payload.action === "deleted" ? "repo.deleted" : "repo.renamed",
          actor, goneAs, goneAs,
          payload.action === "deleted"
            ? "Repository deleted on GitHub"
            : `Repository renamed to ${repoName}`,
          undefined, "github");
        await removeAllRepoEdges(goneAs);
      }
    }

    if (event === "branch_protection_rule") {
      // The branch pattern the rule covers, which GitHub sends on every action
      // for this event. `changes.name.from` was used on the delete, and
      // `changes` is only populated on an *edit*, so the deletion recorded its
      // target as the literal word "branch".
      const branch = sanitizeField(payload.rule?.name, 100);

      if (payload.action === "deleted") {
        await createAlert(repoName, "protection_removed",
          branch
            ? `Branch protection on ${branch} was completely removed.`
            : `Branch protection was completely removed.`,
          "critical", { occurredAt, actor, subject: branch });
        await logActivity("branch.unprotect", actor, repoName, branch || "branch", "Branch protection removed via GitHub", undefined, "github");
      } else if (payload.action === "created") {
        // Only the branch that came back. Restoring protection on `main` used
        // to mark every branch in the repository as protected again.
        await autoResolveAlerts(repoName, "protection_removed", branch);
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift",
          branch
            ? `Branch protection rules on ${branch} were modified (drift detected).`
            : `Branch protection rules were modified (drift detected).`,
          "high", { occurredAt, actor, subject: branch });
        await logActivity("github.branch_protection_edited", actor, repoName, branch || "branch", "Branch protection rules modified", undefined, "github");
      }
    }

    if (event === "repository_ruleset") {
      // The name, deliberately, not the id. A ruleset that is deleted and
      // recreated comes back with a new id, so an id would never match its own
      // reversal. Names are what people keep stable.
      const ruleset = sanitizeField(payload.ruleset?.name, 100);

      if (payload.action === "deleted") {
        await createAlert(repoName, "ruleset_disabled",
          ruleset
            ? `Repository ruleset ${ruleset} was deleted.`
            : `A repository ruleset was deleted.`,
          "critical", { occurredAt, actor, subject: ruleset });
        await logActivity("repo.ruleset.delete", actor, repoName, ruleset || sanitizeField(String(payload.ruleset?.id || ""), 64), "Ruleset deleted via GitHub", undefined, "github");
      } else if (payload.action === "created") {
        await autoResolveAlerts(repoName, "ruleset_disabled", ruleset);
      } else if (payload.action === "edited") {
        await createAlert(repoName, "protection_drift",
          ruleset
            ? `Repository ruleset ${ruleset} was modified (drift detected).`
            : `Repository ruleset was modified (drift detected).`,
          "high", { occurredAt, actor, subject: ruleset });
        await logActivity("github.ruleset_edited", actor, repoName, ruleset || "ruleset", "Repository ruleset modified", undefined, "github");
      }
    }

    if (event === "member" && payload.action === "removed") {
      // Only this member's alert. Removing one of two people added to a
      // repository used to mark both as undone, which the Security tab now
      // states out loud, and for the second person it was untrue.
      await autoResolveAlerts(repoName, "admin_added", sanitizeField(payload.member?.login, 64));
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
  // earlier, which is where the duplicate rows came from. The app logs the
  // branches it creates itself, with the undo payload attached, and those are
  // the only branch creations worth a row.
  //
  // Undo does not depend on any of this. It asks GitHub for the branch's
  // current state at the moment it runs, so it still sees commits, merges,
  // squashes and rebases that were never written here.

  // ── the two Vulnerabilities-tab feeds ────────────────────────────────
  //
  // Outside the repository-scoped block above, which is for events producing
  // activity rows and alerts. These produce neither. They email and nothing
  // else, so they do not depend on the repository being one this app tracks.
  //
  // Both are wrapped and swallowed for the reason the security notify is: a
  // throw here fails the whole delivery, the worker releases its claim, and
  // every other effect of that delivery runs again so SNS can be retried.
  // The developers' own immediate notifications. Wrapped and swallowed for the
  // same reason as everything else out here: a throw fails the delivery, the
  // worker releases its claim, and every other effect of this event runs again.
  if (event === "pull_request" || event === "pull_request_review") {
    try {
      const { notifyDevEvents } = await import("./devEvents");
      await notifyDevEvents(event, payload);
    } catch (err: any) {
      console.warn("[DevEvent] Notification pass failed:", err?.message ?? err);
    }
  }

  if (event === "pull_request" && payload.action === "opened" && payload.pull_request) {
    try {
      const { notifyRenovatePr, isConfiguredBot } = await import("../alarms/feedNotify");
      const { getFeedSettings, getGroup, getSecuritySettings, bufferNotification } =
        await import("../services/alarmService");
      const { getOrgConfig } = await import("../services/orgConfigService");
      const { publish } = await import("../services/notifyService");
      const settings = await getFeedSettings("renovate-pr");
      const bot = (await getOrgConfig()).renovateBot;
      let buffered = false;

      // Grouped feeds buffer instead of publishing. The filters that decide
      // whether this event matters at all are applied here rather than at flush
      // time, so a buffer only ever holds things that would have been sent.
      if (settings.enabled && settings.grouping === "per-repository"
          && isConfiguredBot(sanitizeField(payload.pull_request.user?.login, 64), bot)) {
        await bufferNotification("renovate-pr",
          sanitizeField(payload.repository?.full_name || payload.repository?.name, 140),
          {
            repo: sanitizeField(payload.repository?.full_name || payload.repository?.name, 140),
            title: sanitizeField(payload.pull_request.title, 200),
            url: sanitizeField(payload.pull_request.html_url, 300),
            number: String(Number(payload.pull_request.number) || 0),
          },
          sanitizeField(payload.pull_request.created_at, 40) || occurredAt);
        console.log(`[Notify] Renovate PR buffered: ${payload.repository?.name}#${payload.pull_request.number}`);
        buffered = true;
      }

      const outcome = buffered ? "buffered" as const : await notifyRenovatePr(
        {
          repo: sanitizeField(payload.repository?.full_name || payload.repository?.name, 140),
          number: Number(payload.pull_request.number) || 0,
          title: sanitizeField(payload.pull_request.title, 200),
          url: sanitizeField(payload.pull_request.html_url, 300),
          author: sanitizeField(payload.pull_request.user?.login, 64),
          openedAt: sanitizeField(payload.pull_request.created_at, 40) || occurredAt,
        },
        (await getOrgConfig()).renovateBot,
        {
          settings: () => getFeedSettings("renovate-pr"),
          topicArnFor: async (id: string) => (await getGroup(id))?.topicArn,
          publish,
          timezone: async () => (await getSecuritySettings()).timezone,
          org: process.env.GITHUB_ORG || "",
        },
      );
      if (outcome === "sent") console.log(`[Notify] Renovate PR emailed: ${payload.repository?.name}#${payload.pull_request.number}`);
      else if (outcome === "no-group") console.error("[Notify] Renovate emails are on but no email group is set");
      else if (outcome === "publish-failed") console.error("[Notify] Renovate PR email failed");
    } catch (err) {
      console.error("[Notify] Renovate PR notification failed:", (err as Error).message);
    }
  }

  if (event === "dependabot_alert" && payload.action === "created" && payload.alert) {
    try {
      const { notifyDependabotAlert } = await import("../alarms/feedNotify");
      const { getFeedSettings, getGroup, getSecuritySettings, bufferNotification } =
        await import("../services/alarmService");
      const { meetsMinimumSeverity } = await import("../alarms/evaluate");
      const { publish } = await import("../services/notifyService");
      const a = payload.alert;
      const { normalizeSeverity } = await import("../alarms/feedNotify");
      const severity = normalizeSeverity(sanitizeField(a.security_advisory?.severity, 20));
      const settings = await getFeedSettings("dependabot-alert");
      let buffered = false;

      if (settings.enabled && settings.grouping === "per-repository"
          && (!settings.minSeverity || meetsMinimumSeverity(severity, settings.minSeverity))) {
        await bufferNotification("dependabot-alert",
          sanitizeField(payload.repository?.full_name || payload.repository?.name, 140),
          {
            repo: sanitizeField(payload.repository?.full_name || payload.repository?.name, 140),
            package: sanitizeField(a.dependency?.package?.name, 140) || "unknown package",
            advisory: sanitizeField(a.security_advisory?.summary, 300) || "No summary provided",
            severity,
            url: sanitizeField(a.html_url, 300),
          },
          sanitizeField(a.created_at, 40) || occurredAt);
        console.log(`[Notify] Dependabot alert buffered: ${payload.repository?.name}`);
        buffered = true;
      }

      const outcome = buffered ? "buffered" as const : await notifyDependabotAlert(
        {
          repo: sanitizeField(payload.repository?.full_name || payload.repository?.name, 140),
          package: sanitizeField(a.dependency?.package?.name, 140) || "unknown package",
          summary: sanitizeField(a.security_advisory?.summary, 300) || "No summary provided",
          severity,
          url: sanitizeField(a.html_url, 300),
          createdAt: sanitizeField(a.created_at, 40) || occurredAt,
        },
        {
          settings: () => getFeedSettings("dependabot-alert"),
          topicArnFor: async (id: string) => (await getGroup(id))?.topicArn,
          publish,
          timezone: async () => (await getSecuritySettings()).timezone,
          org: process.env.GITHUB_ORG || "",
        },
      );
      if (outcome === "sent") console.log(`[Notify] Dependabot alert emailed: ${payload.repository?.name}`);
      else if (outcome === "no-group") console.error("[Notify] Dependabot emails are on but no email group is set");
      else if (outcome === "publish-failed") console.error("[Notify] Dependabot alert email failed");
    } catch (err) {
      console.error("[Notify] Dependabot alert notification failed:", (err as Error).message);
    }
  }

  // ── detailed logging: the routine traffic, behind the toggle ─────────
  //
  // Branches, tags, pushes, pull requests. None of this changes structure or
  // access, so none of it is recorded unless an admin has turned detailed
  // logging on, and each kind can be unchecked individually. The toggle
  // governs collection only: rows written while it was on stay in the feed
  // for their full retention after it goes off.
  //
  // Deletions made *through this app* are recorded unconditionally, in
  // routes/branches.ts, because those carry the undo payload that can put the
  // branch back. This block only sees what happened on github.com.
  try {
    const { shouldLogDetailed } = await import("./detailedLogging");
    const dRepo = sanitizeField(payload.repository?.name, 100);
    const dActor = sanitizeField(payload.sender?.login, 64) || "github";
    const detail = { detailed: true } as const;

    if ((event === "create" || event === "delete") && dRepo && payload.ref) {
      const refType = payload.ref_type === "tag" ? "tag" : "branch";
      const kind = `${refType}-${event === "create" ? "created" : "deleted"}`;
      if (await shouldLogDetailed(kind)) {
        // A branch name can legally hold < > " ' &. Git's ref rules forbid
        // spaces and ~^:?*[\ but not those, so it is sanitized like every
        // other payload field.
        const ref = sanitizeField(payload.ref, 100) || refType;
        const action = (refType === "tag"
          ? (event === "create" ? "tag.create" : "tag.delete")
          : (event === "create" ? "branch.create" : "branch.delete")) as any;
        await logActivity(action, dActor, dRepo, ref,
          `${refType === "tag" ? "Tag" : "Branch"} ${event === "create" ? "created" : "deleted"} via GitHub`,
          undefined, "github", undefined, undefined, detail);
      }
    }

    // Pushes to tags arrive as `create`, handled above; `push` for a deleted
    // branch has no commits worth a row.
    if (event === "push" && dRepo && !payload.deleted
        && String(payload.ref ?? "").startsWith("refs/heads/")
        && await shouldLogDetailed("push")) {
      const branch = sanitizeField(String(payload.ref).replace("refs/heads/", ""), 100) || "branch";
      const n = Array.isArray(payload.commits) ? payload.commits.length : 0;
      if (n > 0) {
        await logActivity("github.push", dActor, dRepo, branch,
          `${n} commit${n === 1 ? "" : "s"} pushed to ${branch}`,
          undefined, "github", undefined,
          sanitizeField(payload.after, 40) || undefined, detail);
      }
    }

    if (event === "pull_request" && payload.pull_request && dRepo) {
      const pr = payload.pull_request;
      const prNumber = typeof pr.number === "number" ? pr.number : undefined;
      const title = sanitizeField(pr.title, 140) || `#${prNumber ?? "?"}`;
      const a = payload.action;
      const kind = (a === "opened" || a === "reopened") ? "pr-opened"
        : a === "closed" && pr.merged ? "pr-merged"
        : a === "closed" ? "pr-closed"
        : null;
      if (kind && await shouldLogDetailed(kind)) {
        const action = kind === "pr-opened" ? "github.pr_opened"
          : kind === "pr-merged" ? "github.pr_merged" : "github.pr_closed";
        const said = kind === "pr-opened" ? (a === "reopened" ? "reopened" : "opened")
          : kind === "pr-merged" ? "merged" : "closed without merging";
        await logActivity(action, dActor, dRepo, title,
          `Pull request #${prNumber ?? "?"} ${said}`,
          undefined, "github", prNumber, undefined, detail);
      }
    }
  } catch (err: any) {
    // Additive telemetry must not fail the delivery: a throw here would re-run
    // every other effect of this event so a feed row could be retried.
    console.warn("[Webhook] Detailed logging failed:", err?.message ?? err);
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
 * It was the only GitHub *write* in the webhook path, createRef,
 * createOrUpdateFileContents, updateBranchProtection and createRepoRuleset all
 * lived inside it, along with a five-second provisioning wait and up to four
 * retries. What remains is the compliance refresh, the graph edges and the
 * scanner runs below, none of which write to GitHub.
 */

  // Work that used to outlive the HTTP response.
  //
  // In Lambda the container freezes when this function resolves, so an
  // unawaited promise may never settle and a one-second timer may never fire.
  // These are collected rather than awaited in place so that one failing does
  // not prevent the others from running, which is what the bare .catch()
  // handlers gave us before.
  const background: Promise<unknown>[] = [];

  // Incremental graph edge updates
  const org = getOrg();
  try {
    // Sanitized before it is stored, like every other payload string. A graph
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

    // ── the facts the rebuild would otherwise be the only source of ──────
    //
    // Everything below arrives on an event this handler already receives and
    // acts on. Raising the alert without touching the graph means the Security
    // tab knows a repository went public within seconds while the widget
    // counting public repositories shows the old number for up to six hours.
    //
    // The six checks reading these edges: public-repos,
    // archived-repos-with-access, stale-repos, unowned-repos, empty-teams and
    // repos-dependent-on.

    // Visibility and archival. `repo_meta` carries a dozen fields the rebuild
    // collected, so this merges rather than replaces, see patchRepoMeta.
    if (event === "repository" && repoName) {
      const visibility =
        payload.action === "publicized" ? "public" :
        payload.action === "privatized" ? "private" : null;
      const archived =
        payload.action === "archived" ? true :
        payload.action === "unarchived" ? false : null;

      if (visibility !== null || archived !== null) {
        console.log(`[Webhook] Updating repo_meta for ${repoName}: ${payload.action}`);
        await patchRepoMeta(repoName, {
          ...(visibility !== null ? { visibility } : {}),
          ...(archived !== null ? { archived } : {}),
        });
      }
    }

    // Last activity, which is the whole of what `stale-repos` reads. Taken from
    // the event rather than from a clock: a delivery handled late still records
    // when the push happened.
    if (event === "push" && repoName) {
      const pushedAt = payload.repository?.pushed_at;
      const iso = typeof pushedAt === "number"
        ? new Date(pushedAt * 1000).toISOString()
        : typeof pushedAt === "string" ? pushedAt : new Date().toISOString();
      await patchRepoMeta(repoName, { pushedAt: iso });
    }

    // A team gaining or losing a repository. The alert for this was already
    // being raised above; only the edge was missing.
    if (event === "team" && repoName && payload.team?.slug) {
      const team = payload.team.slug;
      if (payload.action === "added_to_repository") {
        const permission = payload.team?.permission || "pull";
        console.log(`[Webhook] Adding graph edge: team "${team}" owns ${repoName}`);
        await addTeamRepoEdge(team, repoName, permission);
      } else if (payload.action === "removed_from_repository") {
        console.log(`[Webhook] Removing graph edge: team "${team}" from ${repoName}`);
        await removeTeamRepoEdge(team, repoName);
      }
    }

    // Team membership. `membership` was not handled at all before this, which
    // is why `empty-teams` could only ever be as fresh as the last rebuild.
    if (event === "membership" && payload.team?.slug && payload.member?.login) {
      const team = payload.team.slug;
      const user = payload.member.login;
      if (payload.action === "added") {
        console.log(`[Webhook] Adding graph edge: "${user}" is a member of ${team}`);
        await addTeamMemberEdge(team, user);
      } else if (payload.action === "removed") {
        console.log(`[Webhook] Removing graph edge: "${user}" from team ${team}`);
        await removeTeamMemberEdge(team, user);
      }
    }

    // Vulnerable dependencies, keyed on the package as the rebuild keys them.
    if (event === "dependabot_alert" && repoName && payload.alert) {
      const dep = payload.alert.dependency?.package?.name
        || payload.alert.security_vulnerability?.package?.name;
      if (dep) {
        const open = payload.action === "created" || payload.action === "reopened";
        if (open) {
          const severity = payload.alert.security_vulnerability?.severity
            || payload.alert.security_advisory?.severity || "low";
          await addVulnerableDependencyEdge(repoName, dep, severity, payload.alert.number);
        } else if (["fixed", "dismissed", "auto_dismissed"].includes(payload.action)) {
          // The edge only ever represents an *open* advisory, so a resolved one
          // is removed rather than marked, the rebuild would not have written
          // it either, since it lists alerts with state=open.
          await removeVulnerableDependencyEdge(repoName, dep);
        }
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
