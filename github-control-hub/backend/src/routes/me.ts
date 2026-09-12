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
import {
  getDevAlerts, putDevAlerts, badTeamsAddress, nextDigestRecord, readDevEventSeen,
  type DevAlerts,
} from "../services/devAlertService";
import { buildDigest } from "../services/devAlertContent";
import { sendToPerson } from "../services/teamsClient";
import { getOrgConfig } from "../services/orgConfigService";
import {
  readView, saveView, isViewDue, refreshViewIfDue, isViewRefreshing,
} from "../services/viewSnapshot";

/**
 * The app, pointed at whoever is reading it.
 *
 * Everything else here answers a question about the organization. These answer
 * questions about you, out of the same data, which is the whole reason they
 * can exist at all. Nothing below reads GitHub.
 */
/**
 * An IANA zone name the runtime actually recognises, or null.
 *
 * `Intl` is the authority rather than a list kept here, which would go stale
 * every time a government moves its clocks.
 */
function knownZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

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
      /**
       * Where this person can actually write, by name.
       *
       * For screens that offer an action GitHub would refuse: a control that is
       * visibly unavailable, with the reason attached, beats one that looks
       * live and returns a 403 when pressed.
       *
       * Paired with `unknown` on purpose. When the graph has not been built
       * this list is empty, and an empty list read as "writes nowhere" would
       * disable every control for everybody. A caller must treat `unknown` as
       * "do not narrow anything" rather than as an answer.
       */
      writableRepos: writable.map(r => r.repo).sort(),
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
      raw = await getProtection(createOctokit(req.user!.accessToken, "Why can't I push?"), repo, branch);
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
/**
 * What one person shipped, stored per person.
 *
 * The activity search behind this cannot be shared the way the pull request
 * walk is: it pages the table two hundred rows at a time and filters in
 * memory until it has four hundred of *this* person's, so on a busy
 * organization it is many round trips for an answer that is true of nobody
 * else. Hence a row per person and window rather than one for the account.
 *
 * Served from that row without waiting, and refreshed behind the reader at
 * most every half hour. The window is read from the stored timestamp rather
 * than from anything this process remembers, so closing the app and reopening
 * it does not start the work again.
 *
 * Exported for the scheduled pass, which warms the rows that already exist so
 * that the first open after launching the app is a single read rather than the
 * paging. Same function on both paths deliberately: a warm-up that computes
 * something slightly different from what the route computes stores an answer
 * the route then has to redo.
 */
export function shippedKey(login: string, days: number): string {
  // Lower-cased, because GitHub logins are compared without case and two rows
  // for one person would each be half as warm as one.
  return `shipped#${login.toLowerCase()}#${days}`;
}

export async function buildShipped(login: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // `q` matches actor, action and details, so the actor is re-checked exactly
  // afterwards: a free-text hit on somebody's name inside a details string is
  // not the same as them having done it.
  //
  // `since` goes to the search rather than being applied to what comes back.
  // It is a bound on the sort key, so seven days reads seven days; applied
  // afterwards, as it was, seven days read the same three thousand rows of
  // organization-wide history that ninety did, and threw most of them away.
  //
  // Started together with the logging flag, because neither answer depends on
  // the other and the walk is the long one.
  const [detailed, page] = await Promise.all([
    getDetailedLogging().catch(() => ({ enabled: false } as any)),
    searchActivity({ q: login, category: "github", since }, 400),
  ]);

  const shipped = page.entries.filter(e =>
    e.actor?.toLowerCase() === login.toLowerCase()
    && (e.action === "github.pr_merged" || e.action === "github.push"));

  return {
    login, days,
    merged: shipped.filter(e => e.action === "github.pr_merged"),
    pushes: shipped.filter(e => e.action === "github.push").length,
    // The two ways this list can be short for reasons that are not "you did
    // not ship anything".
    detailedLogging: !!detailed.enabled,
    exhausted: page.exhausted,
  };
}

router.get("/ship", async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const login = String(req.query.login || req.user!.login);

    // Checked before it becomes part of a storage key. GitHub logins are
    // letters, digits and hyphens; anything else is either a typo or an attempt
    // to write a row under a name that is not a person's, and the key's own
    // separator is the character that would do it.
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
      return res.status(400).json({ error: "That is not a GitHub username." });
    }

    // Keyed on the person and the window, because both change the answer.
    const key = shippedKey(login, days);

    const stored = await readView<any>(key);
    if (stored) {
      res.json({ ...stored.data, computedAt: stored.computedAt, refreshing: isViewRefreshing(key) });
      if (isViewDue(key, stored)) {
        void refreshViewIfDue(key, async () => saveView(key, await buildShipped(login, days)));
      }
      return;
    }

    const fresh = await buildShipped(login, days);
    await saveView(key, fresh);
    res.json({ ...fresh, computedAt: new Date().toISOString(), refreshing: false });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "me") });
  }
});

router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const a = await getDevAlerts(req.user!.login);
    // The address is the person's own and is shown back: unlike a webhook it is
    // not a credential, and being unable to see what you typed is how a typo
    // survives. What they cannot see for themselves is whether an administrator
    // has set the shared flow up, so that travels with it.
    const flow = (await getOrgConfig().catch(() => null))?.teamsFlow;
    /**
     * And whether the worker has seen one of these events at all.
     *
     * This is deliberately the *only* thing reported about the delivery path,
     * and it is measured rather than inferred. An earlier version of this
     * screen asked the GitHub App which webhook events it was subscribed to
     * and named the unticked ones. That was the wrong source: this app is fed
     * by an **organization** webhook, configured under Organization → Settings
     * → Webhooks, and the App subscribes to nothing — so `GET /app` reports an
     * empty event list on a perfectly healthy install, and the screen accused
     * every deployment of a checkbox that was never the problem. The App has
     * no permission to read the org webhook either, so there is nothing
     * correct to ask.
     *
     * What the worker actually received is not a guess. It is written org-wide
     * before any decision is taken, so a recent value proves GitHub is
     * delivering and the worker is running, and its absence is the one honest
     * reason to go and look at the webhook's own event list.
     */
    const seen = await readDevEventSeen().catch(() => null);
    res.json({ ...a, teamsReady: !!flow?.url, lastWebhookSeen: seen });
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
      /**
       * Only the switches that exist, and only as booleans.
       *
       * A spread of whatever arrived would let a client write keys nothing
       * reads, which then sit in the row forever looking like settings. `wants`
       * refuses an unknown kind anyway, so this costs nothing and keeps the
       * stored row equal to the screen that writes it.
       */
      events: (["reviewRequested", "changesRequested", "approved"] as const)
        .reduce((acc, k) => {
          const sent = body.events?.[k];
          acc[k] = typeof sent === "boolean" ? sent : current.events[k];
          return acc;
        }, {} as DevAlerts["events"]),
      /**
       * The ceiling on how many reviewers a request may have.
       *
       * Null and zero both clear it, because "no limit" is a thing somebody
       * chooses and it needs a value to choose. Anything else is clamped into
       * a range a person could plausibly mean: a limit of 400 is not a limit,
       * and a negative one would withhold every request and read as the
       * notification being broken.
       */
      reviewerLimit: body.reviewerLimit === null || body.reviewerLimit === 0
        ? undefined
        : body.reviewerLimit === undefined
          ? current.reviewerLimit
          : Math.min(20, Math.max(1, Number(body.reviewerLimit) || 1)),
      digest: {
        ...current.digest,
        ...(body.digest ?? {}),
        include: { ...current.digest.include, ...(body.digest?.include ?? {}) },
        // Clamped to a year. A limit of 4000 days is not a limit, and a
        // negative one would filter everything away and read as "nothing to
        // report" for ever.
        maxAgeDays: Object.fromEntries(
          (["toReview", "mine", "mergeable"] as const).map(k => [k,
            Math.min(365, Math.max(0,
              Number(body.digest?.maxAgeDays?.[k] ?? current.digest.maxAgeDays?.[k]) || 0))])
        ) as { toReview: number; mine: number; mergeable: number },
        // Clamped rather than trusted: an hour of 25 would simply never match,
        // which looks identical to the digest being broken.
        hour: Math.min(23, Math.max(0, Number(body.digest?.hour ?? current.digest.hour) || 0)),
        minute: Math.min(59, Math.max(0, Number(body.digest?.minute ?? current.digest.minute) || 0)),
        // Checked here, because an unknown zone is not an error further
        // down: it quietly becomes UTC, and the only symptom is a summary
        // arriving at the wrong hour with nothing saying why.
        timeZone: knownZone(body.digest?.timeZone) ?? current.digest.timeZone,
        days: Array.isArray(body.digest?.days)
          ? body.digest.days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
          : current.digest.days,
      },
      // Cleared on save: a failure from the old URL said nothing about the new
      // one, and leaving it makes a fixed setting still look broken.
      lastError: typeof body.teamsAddress === "string" ? undefined : current.lastError,
      lastErrorAt: typeof body.teamsAddress === "string" ? undefined : current.lastErrorAt,
    };

    // Changing *when* it arrives re-decides whether today's is still owed.
    const saved = await putDevAlerts({ ...next, lastDigestAt: nextDigestRecord(current, next) });
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
    const snap = await readPrSnapshot().catch(() => null);
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
