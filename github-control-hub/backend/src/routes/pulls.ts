import { Router, Request, Response } from "express";

import { createOctokit, getSystemToken } from "../github/client";
import { isAwsAdmin, AWS_ADMIN_TEAM } from "../services/authorizationService";
import { sanitizeError } from "../utils/errorSanitizer";
import { getPrState, listPrStates, setPrPause, recordNudge } from "../services/alarmService";
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
    const [{ prs, truncated }, states] = await Promise.all([
      fetchOpenPrs(graphqlFor(token), org()),
      listPrStates(),
    ]);
    const byId = new Map(states.map(s => [`${s.repo}#${s.number}`, s]));

    const rows = sortByStaleness(prs).map(pr => {
      const state = byId.get(`${pr.repo}#${pr.number}`);
      const paused = { pr: state?.paused, logins: state?.pausedLogins };
      const { reason, targets } = nudgeTargets(pr, paused);
      return {
        ...pr,
        idleDays: Math.floor(daysSinceLastCommit(pr)),
        stale: isStale(pr),
        blockReason: reason,
        pendingReviewers: pendingReviewers(pr),
        // Who the next reminder would name. Shown so the effect of a pause is
        // visible before it is tested by a reminder going out.
        wouldNudge: targets,
        paused: !!state?.paused,
        pausedLogins: state?.pausedLogins ?? [],
        lastNudgedAt: state?.lastNudgedAt ?? null,
        nudgeCount: state?.nudgeCount ?? 0,
      };
    });

    res.json({
      staleSeconds: staleSeconds(),
      truncated,
      open: rows.length,
      stale: rows.filter(r => r.stale).length,
      pulls: rows,
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
  if (!(await isAwsAdmin(login).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${AWS_ADMIN_TEAM}" team (or organization owners) can pause `
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
  if (!(await isAwsAdmin(login).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${AWS_ADMIN_TEAM}" team (or organization owners) can send `
        + `reminders.`,
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
    res.json(summary);
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
