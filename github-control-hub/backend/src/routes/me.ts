import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { readPrSnapshot } from "../services/alarmService";
import { myWork } from "../services/developerService";
import { accessForUser, accessForRepo } from "../services/accessMapService";
import { createOctokit } from "../github/client";
import { getProtection } from "../services/branchService";
import { fromClassic, explainPush } from "../services/pushExplainer";
import { searchActivity } from "../services/activitySearch";
import { getDetailedLogging } from "../services/orgConfigService";
import { readPrSnapshot as prSnapshot } from "../services/alarmService";
import {
  getDevAlerts, putDevAlerts, badTeamsAddress, type DevAlerts,
} from "../services/devAlertService";
import { buildDigest } from "../services/devAlertContent";
import { sendToPerson } from "../services/teamsClient";
import { getOrgConfig } from "../services/orgConfigService";

/**
 * The app, pointed at whoever is reading it.
 *
 * Everything else here answers a question about the organization. These answer
 * questions about you, out of the same data, which is the whole reason they
 * can exist at all. Nothing below reads GitHub.
 */
const router = Router();

/**
 * What to do next, out of every open pull request.
 *
 * Served from the pull request snapshot the PR tab already keeps, so opening
 * this costs no GitHub requests at all. That matters more here than there: this
 * is meant to be the first tab somebody opens in the morning, and a screen that
 * spends a hundred API calls to say "nothing is waiting on you" is a screen
 * people stop opening.
 *
 * No live fallback on purpose. If the snapshot has never been written the
 * honest answer is that we do not know yet, not a slow one produced by a walk
 * this route should not be paying for, and the PR tab, which owns that walk,
 * is one click away.
 */
router.get("/work", async (req: Request, res: Response) => {
  try {
    const snapshot = await readPrSnapshot().catch(() => null);
    if (!snapshot) {
      // 200, not an error: nothing is wrong, the walk has simply not run. The
      // client needs to say "not collected yet" rather than "you have nothing
      // to do", which are opposite messages built from the same empty list.
      return res.json({
        mine: [], toReview: [], mergeable: 0, onYou: 0,
        collected: false, cachedAt: null,
      });
    }
    res.json({
      ...myWork(snapshot.prs, req.user!.login),
      collected: true,
      cachedAt: snapshot.cachedAt,
      // The snapshot stops at a page limit on a large organization, and a queue
      // that quietly omits the tail is worse than one that says it did.
      truncated: !!snapshot.truncated,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

/**
 * What you can reach, and how you got it.
 *
 * The access map already answers this about anybody; it is an auditor's screen
 * pointed at somebody else. Pointed at yourself it answers a question most
 * people cannot answer about their own account, which teams grant what, and
 * whether anything is granted to them directly rather than through a team.
 *
 * Direct grants are called out because they are the ones that outlive the
 * reason for them. A team membership goes when you change teams; a
 * collaborator row added for one afternoon three years ago does not.
 */
router.get("/access", async (req: Request, res: Response) => {
  try {
    const me = await accessForUser(req.user!.login);
    const direct = me.repos.filter(r => r.paths.some(p => p.via === "direct"));
    // `role` is the strongest of all their paths, which is what they can
    // actually do, not what any one team happens to grant.
    const writable = me.repos.filter(r => r.role === "write" || r.role === "admin" || r.role === "maintain");
    res.json({
      login: me.login,
      orgRole: me.orgRole,
      unknown: !!me.unknown,
      teams: me.teams,
      totals: {
        repos: me.repos.length,
        writable: writable.length,
        admin: me.repos.filter(r => r.role === "admin").length,
        direct: direct.length,
      },
      // Named, not counted. "Two direct grants" is a number nobody can act on;
      // the two repository names are a thing somebody can go and check.
      directRepos: direct.map(r => ({ repo: r.repo, role: r.role })),
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

/**
 * Why a push or a merge into this branch will be refused.
 *
 * A question people currently answer by trying it. The rules are already on
 * screen elsewhere as a settings form, which is the right shape for changing
 * them and the wrong one for "what happens if I try", so this says the same
 * facts as sentences about the person reading them.
 *
 * Read with the caller's own token. Protection is only visible to somebody with
 * admin on the repository, and using the app's token would answer for people
 * GitHub would not have answered.
 */
router.get("/push-check", async (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? "").trim();
  const branch = String(req.query.branch ?? "").trim();
  if (!repo || !branch) {
    return res.status(400).json({ error: "repo and branch are both required" });
  }
  try {
    const me = await accessForUser(req.user!.login);
    const mine = me.repos.find(r => r.repo === repo);
    // Said outright rather than answered with an empty rule list, which reads
    // as "nothing is stopping you", the opposite of the truth.
    if (!mine && me.orgRole !== "owner") {
      return res.json({
        repo, branch, reachable: false,
        message: `You have no access to ${repo}, so nothing you push there would be accepted.`,
      });
    }

    let raw: Record<string, unknown> | null = null;
    let unreadable = false;
    try {
      raw = await getProtection(createOctokit(req.user!.accessToken), repo, branch);
    } catch {
      // Reading protection needs admin. Not being allowed to read the rules is
      // not the same as there being none, and reporting it as none would tell
      // somebody they can push straight to a protected branch.
      unreadable = true;
    }

    if (unreadable) {
      return res.json({
        repo, branch, reachable: true, unreadable: true,
        message: "Only an administrator of this repository can read its protection rules, "
          + "so the app cannot say what will happen. It does not mean there are none.",
      });
    }

    res.json({
      reachable: true,
      ...explainPush(repo, branch, fromClassic(raw), 
        { login: me.login, role: mine?.role ?? (me.orgRole === "owner" ? "admin" : "read") },
        me.teams.map(t => t.slug)),
      // Who to ask. A rule you cannot satisfy on your own is only actionable
      // with a name attached, and the graph already knows who has write here.
      //
      // Admins are marked rather than listed separately: they are the ones who
      // can change the rule as well as satisfy it, which is a different favour
      // to ask for and worth being able to tell apart.
      approvers: (await accessForRepo(repo)).people
        .filter(person => person.login.toLowerCase() !== me.login.toLowerCase()
          && (person.role === "admin" || person.role === "maintain" || person.role === "write"))
        .sort((a, b) => (a.role === "admin" ? -1 : 1) - (b.role === "admin" ? -1 : 1))
        .slice(0, 12)
        .map(person => ({ login: person.login, role: person.role })),
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

/**
 * What went out, and what is still waiting.
 *
 * Two halves from two sources, because they are two different facts. What
 * shipped comes from the activity log, which only carries merges when detailed
 * logging is on, so when it is off this says so rather than showing an empty
 * week, which would read as having shipped nothing.
 */
router.get("/ship", async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = Date.now() - days * 86_400_000;
    const login = String(req.query.login || req.user!.login);

    const detailed = await getDetailedLogging().catch(() => ({ enabled: false } as any));

    // `q` matches actor, action and details, so the actor is re-checked exactly
    // afterwards: a free-text hit on somebody's name inside a details string is
    // not the same as them having done it.
    const page = await searchActivity({ q: login, category: "github" }, 400);
    const shipped = page.entries.filter(e =>
      e.actor?.toLowerCase() === login.toLowerCase()
      && Date.parse(e.timestamp) >= since
      && (e.action === "github.pr_merged" || e.action === "github.push"));

    const snap = await prSnapshot().catch(() => null);
    const waiting = (snap?.prs ?? [])
      .filter(pr => pr.author?.toLowerCase() === login.toLowerCase() && !pr.isDraft)
      .map(pr => ({ repo: pr.repo, number: pr.number, title: pr.title, url: pr.url }));

    res.json({
      login, days,
      merged: shipped.filter(e => e.action === "github.pr_merged"),
      pushes: shipped.filter(e => e.action === "github.push").length,
      waiting,
      // The two ways this list can be short for reasons that are not "you did
      // not ship anything".
      detailedLogging: !!detailed.enabled,
      exhausted: page.exhausted,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

/**
 * A person's own notification settings.
 *
 * Always their own. There is no login parameter and there deliberately is not
 * one: this holds a webhook that posts into somebody's Teams, and being able to
 * read or set another person's would be a way to send messages as them.
 */
router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const a = await getDevAlerts(req.user!.login);
    // The address is the person's own and is shown back: unlike a webhook it is
    // not a credential, and being unable to see what you typed is how a typo
    // survives. What they cannot see for themselves is whether an administrator
    // has set the shared flow up, so that travels with it.
    const flow = (await getOrgConfig().catch(() => null))?.teamsFlow;
    res.json({ ...a, teamsReady: !!flow?.url });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

router.put("/alerts", async (req: Request, res: Response) => {
  try {
    const current = await getDevAlerts(req.user!.login);
    const body = req.body ?? {};

    // An empty string clears it; an absent field leaves it alone. Those are
    // different intentions and collapsing them would make the field impossible
    // to clear.
    let teamsAddress = current.teamsAddress;
    if (typeof body.teamsAddress === "string") {
      const trimmed = body.teamsAddress.trim();
      if (trimmed === "") {
        teamsAddress = undefined;
      } else {
        const bad = badTeamsAddress(trimmed);
        if (bad) { res.status(400).json({ error: bad }); return; }
        teamsAddress = trimmed;
      }
    }

    const next: DevAlerts = {
      ...current,
      teamsAddress,
      events: { ...current.events, ...(body.events ?? {}) },
      digest: {
        ...current.digest,
        ...(body.digest ?? {}),
        include: { ...current.digest.include, ...(body.digest?.include ?? {}) },
        // Clamped rather than trusted: an hour of 25 would simply never match,
        // which looks identical to the digest being broken.
        hour: Math.min(23, Math.max(0, Number(body.digest?.hour ?? current.digest.hour) || 0)),
        minute: Math.min(59, Math.max(0, Number(body.digest?.minute ?? current.digest.minute) || 0)),
        days: Array.isArray(body.digest?.days)
          ? body.digest.days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
          : current.digest.days,
      },
      // Cleared on save: a failure from the old URL said nothing about the new
      // one, and leaving it makes a fixed setting still look broken.
      lastError: typeof body.teamsAddress === "string" ? undefined : current.lastError,
      lastErrorAt: typeof body.teamsAddress === "string" ? undefined : current.lastErrorAt,
    };

    const saved = await putDevAlerts(next);
    const flow = (await getOrgConfig().catch(() => null))?.teamsFlow;
    res.json({ ...saved, teamsReady: !!flow?.url });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

/**
 * Send one now, so a wrong URL is found in ten seconds rather than in a week.
 *
 * A pasted webhook that is subtly wrong fails silently and forever, and the
 * only person who would notice is the one who stops being told things. This is
 * the difference between a setting somebody trusts and one they do not.
 */
router.post("/alerts/test", async (req: Request, res: Response) => {
  try {
    const a = await getDevAlerts(req.user!.login);
    if (!a.teamsAddress) {
      res.status(400).json({ error: "No Teams address is set yet." });
      return;
    }
    // Two different things can be missing, and telling somebody to check their
    // own settings when an administrator has not set the flow up sends them
    // somewhere they cannot fix it.
    const flowUrl = (await getOrgConfig().catch(() => null))?.teamsFlow?.url;
    if (!flowUrl) {
      res.status(400).json({
        error: "Teams delivery is not set up for this organization yet. An administrator "
          + "sets it up once, in Alarms, and then this works for everybody.",
      });
      return;
    }
    const snap = await prSnapshot().catch(() => null);
    // Built from real data, not a fixed "hello". Somebody testing this wants to
    // see what their digest will actually look like, including whether the
    // sections they chose have anything in them.
    const digest = buildDigest({ ...a, digest: { ...a.digest, skipWhenEmpty: false } },
      snap?.prs ?? []);
    const result = await sendToPerson(flowUrl, a.teamsAddress, digest.card);
    const now = new Date().toISOString();
    await putDevAlerts(result.ok
      ? { ...a, lastSentAt: now, lastError: undefined, lastErrorAt: undefined }
      : { ...a, lastError: result.error, lastErrorAt: now });
    if (!result.ok) { res.status(502).json({ error: result.error }); return; }
    // `queued` travels so the screen can stop claiming delivery it cannot see.
    res.json({ sent: true, queued: !!result.queued, counts: digest.counts, usedSnapshot: !!snap });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

export default router;
