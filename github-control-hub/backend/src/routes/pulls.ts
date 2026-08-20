import { Router, Request, Response } from "express";

import { createOctokit, getSystemToken } from "../github/client";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { sanitizeError } from "../utils/errorSanitizer";
import { logSync } from "../services/activityService";
import {
  getPrState, listPrStates, setPrPause, recordNudge,
  getPrSettings, savePrSettings, getPrMutes, setPrMute,
} from "../services/alarmService";
import {
  fetchOpenPrs, sortByStaleness, daysSinceLastCommit, isStale,
  pendingReviewers, nudgeTargets, runNudgePass, staleSeconds,
} from "../services/prNudgeService";

const router = Router();

const org = () => process.env.GITHUB_ORG || "";

/**
 * Read as the caller, not as the app.
 *
 * The list names people and repositories, and an installation token can see
 * every private repository in the organization. Using it would show somebody
 * pull requests they cannot open on github.com. GitHub already knows what each
 * person may read, so the token decides it.
 */
function graphqlFor(token: string) {
  const octokit = createOctokit(token);
  return async (query: string, variables: Record<string, unknown>) =>
    (octokit as any).graphql(query, variables);
}

router.get("/", async (req: Request, res: Response) => {
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });

  try {
    const settings = await getPrSettings();

    // Returned before the query, not after. Switching monitoring off has to
    // stop the work, not hide its result — otherwise "off" still spends a
    // GraphQL sweep every time somebody opens the page.
    if (!settings.monitoringEnabled) {
      return res.json({
        monitoringEnabled: false, remindersEnabled: settings.remindersEnabled,
        staleSeconds: staleSeconds(), truncated: false, open: 0, stale: 0, pulls: [],
      });
    }

    const [{ prs, truncated }, states, mutes] = await Promise.all([
      fetchOpenPrs(graphqlFor(token), org()),
      listPrStates(),
      getPrMutes(),
    ]);
    const byId = new Map(states.map(s => [`${s.repo}#${s.number}`, s]));

    const rows = sortByStaleness(prs).map(pr => {
      const state = byId.get(`${pr.repo}#${pr.number}`);
      const { reason, targets, muted } = nudgeTargets(pr, {
        prPaused: state?.paused,
        prLogins: state?.pausedLogins,
        repoLogins: mutes.byRepo[pr.repo],
        globalLogins: mutes.global,
      });
      return {
        ...pr,
        idleDays: Math.floor(daysSinceLastCommit(pr)),
        stale: isStale(pr),
        blockReason: reason,
        pendingReviewers: pendingReviewers(pr),
        // Who the next reminder would name. Shown so the effect of a pause is
        // visible before it is tested by a reminder going out.
        wouldNudge: targets,
        // Named with their reason, so a pull request reminding nobody explains
        // itself rather than looking like the feature has stopped working.
        muted,
        paused: !!state?.paused,
        pausedLogins: state?.pausedLogins ?? [],
        lastNudgedAt: state?.lastNudgedAt ?? null,
        nudgeCount: state?.nudgeCount ?? 0,
      };
    });

    res.json({
      monitoringEnabled: true,
      remindersEnabled: settings.remindersEnabled,
      staleSeconds: staleSeconds(),
      truncated,
      open: rows.length,
      stale: rows.filter(r => r.stale).length,
      pulls: rows,
      mutes,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

/**
 * Pausing, admin only.
 *
 * The repository is in the body rather than the path because it contains a
 * slash — `org/repo` in a path segment is two segments, and encoding it is a
 * trap the next person maintaining this would fall into.
 */
router.put("/pause", async (req: Request, res: Response) => {
  const login = req.user!.login;
  if (!(await isControlHubAdmin(login, req.user!.accessToken).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can pause `
        + `reminders. Pausing silences a reminder for everyone, so it is not scoped to what you `
        + `personally can reach.`,
    });
  }

  const { repo, number, paused, pausedLogins } = req.body ?? {};
  if (typeof repo !== "string" || !repo.includes("/")) {
    return res.status(400).json({ error: "A repository is required, as owner/name" });
  }
  if (!Number.isInteger(number) || number <= 0) {
    return res.status(400).json({ error: "A pull request number is required" });
  }
  if (paused !== undefined && typeof paused !== "boolean") {
    return res.status(400).json({ error: "paused must be true or false" });
  }
  if (pausedLogins !== undefined) {
    if (!Array.isArray(pausedLogins) || pausedLogins.some(l => typeof l !== "string")) {
      return res.status(400).json({ error: "pausedLogins must be a list of logins" });
    }
    if (pausedLogins.length > 100) {
      return res.status(400).json({ error: "That is too many logins" });
    }
  }

  try {
    const updated = await setPrPause(repo, number, { paused, pausedLogins }, login);
    res.json({
      repo: updated.repo, number: updated.number,
      paused: !!updated.paused, pausedLogins: updated.pausedLogins ?? [],
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

/**
 * Run the reminder pass now, rather than waiting for the next tick.
 *
 * The scheduled pass runs every five minutes, which is a long time to sit and
 * watch when checking whether this works at all. It also gives an admin a way
 * to act immediately rather than waiting, which is worth having regardless.
 *
 * Posts as the app, not as the caller. The reminder has to come from the same
 * account every time or the next cycle cannot recognise its own comment to
 * replace it — and a reminder appearing to come from whoever pressed the button
 * would be misleading about who is chasing whom.
 */
router.post("/run", async (req: Request, res: Response) => {
  const login = req.user!.login;
  if (!(await isControlHubAdmin(login, req.user!.accessToken).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can send `
        + `reminders.`,
    });
  }

  const settings = await getPrSettings();
  if (!settings.monitoringEnabled || !settings.remindersEnabled) {
    return res.status(409).json({
      error: settings.monitoringEnabled
        ? "Reminders are switched off for this organization"
        : "Pull request monitoring is switched off for this organization",
    });
  }

  const appToken = getSystemToken();
  if (!appToken) {
    return res.status(503).json({
      error: "No app token available, so a reminder would have no account to post from",
    });
  }
  const octokit = createOctokit(appToken);
  const split = (repo: string) => { const [owner, name] = repo.split("/"); return { owner, repo: name }; };

  const startedAt = Date.now();
  try {
    const summary = await runNudgePass({
      listPrs: () => fetchOpenPrs(
        (query, variables) => (octokit as any).graphql(query, variables), org()),
      getState: (repo, number) => getPrState(repo, number),
      recordNudge,
      listComments: async (repo, number) => {
        const { data } = await (octokit as any).rest.issues.listComments({
          ...split(repo), issue_number: number, per_page: 100,
        });
        return data.map((c: any) => ({
          id: c.id, body: c.body ?? "", authorIsApp: c.user?.type === "Bot",
        }));
      },
      deleteComment: async (repo, id) =>
        void await (octokit as any).rest.issues.deleteComment({ ...split(repo), comment_id: id }),
      postComment: async (repo, number, body) => {
        const { data } = await (octokit as any).rest.issues.createComment({
          ...split(repo), issue_number: number, body,
        });
        return data?.id;
      },
    });
    await logSync("reminders", login, {
      details: `${summary.considered} open pull requests, ${summary.due} due, `
        + `${summary.posted} reminded`
        + (summary.skippedPaused ? `, ${summary.skippedPaused} paused` : "")
        + (summary.failed ? `, ${summary.failed} failed` : ""),
      // Partly failed, not failed: reminders that went out did go out, and
      // marking the whole row as a failure would hide that from anyone
      // wondering why people were messaged.
      failed: summary.failed > 0 && summary.posted === 0,
      startedAt,
    });
    res.json(summary);
  } catch (error: any) {
    await logSync("reminders", login, {
      details: "Reminder pass failed", failed: true,
      error: error?.message ?? String(error), startedAt,
    });
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

/**
 * Mute or unmute one person at one scope.
 *
 * Per-pull-request mutes stay on /pause, which owns that pull request's row.
 * These are the wider two, which live in one shared record.
 */
router.put("/mute", async (req: Request, res: Response) => {
  const login = req.user!.login;
  if (!(await isControlHubAdmin(login, req.user!.accessToken).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can mute `
        + `people from reminders.`,
    });
  }
  const { scope, repo, target, muted } = req.body ?? {};
  if (scope !== "global" && scope !== "repo") {
    return res.status(400).json({ error: "scope must be global or repo" });
  }
  if (scope === "repo" && (typeof repo !== "string" || !repo.includes("/"))) {
    return res.status(400).json({ error: "A repository is required, as owner/name" });
  }
  if (typeof target !== "string" || !target.trim() || target.length > 100) {
    return res.status(400).json({ error: "A GitHub login is required" });
  }
  if (typeof muted !== "boolean") {
    return res.status(400).json({ error: "muted must be true or false" });
  }

  // Checked when adding, never when removing.
  //
  // A mute on somebody outside the organization is not dangerous, it is inert —
  // and inert is the problem: it looks set, so the person actually being chased
  // goes on being reminded. Removal skips the check because a login that is no
  // longer a member is exactly the one that most needs clearing out.
  if (muted) {
    try {
      const { listOrgMembers, depsFromOctokit, isOrgMember } =
        await import("../services/orgMembersService");
      const members = await listOrgMembers(
        depsFromOctokit(createOctokit(req.user!.accessToken)), org());
      if (!isOrgMember(target, members)) {
        return res.status(400).json({
          error: `"${target}" is not a member of this organization, so muting them would `
            + `have no effect. Pick somebody from the list.`,
        });
      }
    } catch (error: any) {
      // Refused rather than waved through: allowing the write when the check
      // could not run is the same silent no-op by another route.
      return res.status(503).json({
        error: "Could not check organization membership, so the mute was not saved",
      });
    }
  }

  try {
    res.json(await setPrMute(
      scope === "global" ? { kind: "global" } : { kind: "repo", repo },
      target, muted, login));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

router.get("/mutes", async (_req: Request, res: Response) => {
  try {
    res.json(await getPrMutes());
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

router.get("/settings", async (_req: Request, res: Response) => {
  try {
    res.json(await getPrSettings());
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

router.put("/settings", async (req: Request, res: Response) => {
  const login = req.user!.login;
  if (!(await isControlHubAdmin(login, req.user!.accessToken).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can switch `
        + `pull request monitoring or reminders on and off.`,
    });
  }
  const { monitoringEnabled, remindersEnabled } = req.body ?? {};
  for (const [name, v] of [["monitoringEnabled", monitoringEnabled], ["remindersEnabled", remindersEnabled]]) {
    if (v !== undefined && typeof v !== "boolean") {
      return res.status(400).json({ error: `${name} must be true or false` });
    }
  }
  try {
    res.json(await savePrSettings({ monitoringEnabled, remindersEnabled }, login));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

router.get("/state", async (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? "");
  const number = Number(req.query.number);
  if (!repo || !Number.isInteger(number)) {
    return res.status(400).json({ error: "repo and number are required" });
  }
  try {
    const state = await getPrState(repo, number);
    res.json(state ?? { repo, number, paused: false, pausedLogins: [] });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "pull requests") });
  }
});

export default router;
