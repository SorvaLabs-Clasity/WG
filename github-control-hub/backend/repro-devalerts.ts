/**
 * Notifications a developer sets for themselves.
 *
 * The first thing in this app that somebody configures for their own benefit,
 * which changes what has to be right. Nobody is watching it on anybody's
 * behalf: a delivery that fails silently is a person who simply stops being
 * told, and never finds out.
 *
 * So the assertions cluster around four ways this could quietly be useless.
 *
 *   A schedule that fires twelve times, because the pass ticks every five
 *   minutes and the chosen hour matches all twelve.
 *
 *   A schedule that fires at the wrong time, because the pass runs in UTC and
 *   people do not.
 *
 *   A daily message with nothing in it, which is how a channel gets muted and
 *   the useful ones stop being read.
 *
 *   A webhook URL that goes somewhere it should not, since a Lambda posts to
 *   whatever is stored here with no further checks.
 *
 * Run:  npx tsx repro-devalerts.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import {
  defaults, badWebhook, badTeamsAddress, digestDue, whyNotDue, localNow, nextDigestRecord,
  keyFor, KEY_PREFIX, type DevAlerts,
} from "./src/services/devAlertService";
import { buildDigest, buildEventCard, wants } from "./src/services/devAlertContent";
import { buildCard, escapeMd } from "./src/services/teamsClient";
import { recipientsFor } from "./src/webhooks/devEvents";
import type { PullRequest } from "./src/services/prNudgeService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = Date.parse("2026-08-27T13:30:00Z");   // a Thursday, 09:30 in New York
const DAY = 86_400_000;

const prefs = (over: Partial<DevAlerts> = {}): DevAlerts => ({
  ...defaults("alice"),
  teamsAddress: "alice@example.com",
  ...over,
});

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "web", number: 1, title: "t", url: "u", author: "alice",
  headRef: "f", baseRef: "main",
  createdAt: new Date(NOW - 3 * DAY).toISOString(),
  lastCommitAt: new Date(NOW - DAY).toISOString(),
  isDraft: false, reviewDecision: null, mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", requestedReviewers: [], reviews: [],
  checksState: "SUCCESS",
  ...over,
} as PullRequest);

const text = (card: any) => JSON.stringify(card);

(async () => {
  // ── one message a day, not twelve ───────────────────────────────────
  {
    const p = prefs({ digest: { ...defaults("alice").digest, enabled: true, hour: 9, minute: 0, timeZone: "America/New_York", days: [] } });
    check("a digest is due at its time", digestDue(p, NOW));
    check("  and not an hour later", !digestDue(p, NOW + 3_600_000));
    check("  nor before it", !digestDue(p, NOW - 3_600_000));

    // The pass ticks every five minutes, so an exact match would mean a digest
    // set for 9:58 never fired: the ticks near it are 9:55 and 10:00.
    const late = prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, minute: 58, timeZone: "America/New_York", days: [] } });
    check("a time between ticks still fires, at the next one",
      !digestDue(late, NOW) && digestDue(late, NOW + 30 * 60_000),
      "an exact match means 9:58 never fires at all");
    // Bounded, so a morning outage does not deliver at eleven at night.
    check("  but not hours late",
      !digestDue(late, NOW + 4 * 3_600_000),
      "a digest arriving at bedtime is not the digest anybody asked for");

    // Twelve ticks fall inside any chosen hour.
    const sent = { ...p, lastDigestAt: new Date(NOW).toISOString() };
    check("  once sent, the rest of the hour is quiet",
      !digestDue(sent, NOW + 5 * 60_000) && !digestDue(sent, NOW + 55 * 60_000),
      "the pass ticks every five minutes and would send twelve copies");
    check("  but tomorrow it is due again", digestDue(sent, NOW + DAY));
  }

  // ── why a digest is not going out ───────────────────────────────────
  //
  // Silence in the log is indistinguishable from the pass not running, which is
  // exactly the state somebody is in when they ask why nothing arrived. Each of
  // these has been the real cause at least once.
  {
    const at9 = { ...defaults("a").digest, enabled: true, hour: 9, minute: 0,
      timeZone: "America/New_York", days: [] };
    const base = prefs({ digest: at9 });

    check("a due digest has no reason not to be",
      whyNotDue(base, NOW) === null, whyNotDue(base, NOW));
    check("  switched off says so",
      whyNotDue(prefs({ digest: { ...at9, enabled: false } }), NOW) === "disabled");
    check("  no address says so",
      whyNotDue({ ...base, teamsAddress: undefined }, NOW) === "no address");
    check("  before its time says so",
      whyNotDue(base, NOW - 3_600_000) === "not yet");
    check("  long after says so",
      whyNotDue(base, NOW + 4 * 3_600_000) === "window passed");
    check("  a day not chosen says so",
      whyNotDue(prefs({ digest: { ...at9, days: [1] } }), NOW + 2 * DAY) === "not a chosen day",
      whyNotDue(prefs({ digest: { ...at9, days: [1] } }), NOW + 2 * DAY));
    check("  and today's already gone says so",
      whyNotDue({ ...base, lastDigestAt: new Date(NOW).toISOString() }, NOW) === "already sent today");

    // Two rules that can disagree is how a log explains one thing while the
    // code does another.
    check("the decision is the absence of a reason, not a second rule",
      /return whyNotDue\(a, now\) === null;/.test(
        fs.readFileSync("./src/services/devAlertService.ts", "utf8")));

    const digest = fs.readFileSync("./src/alarms/devDigest.ts", "utf8");
    check("  and a tick with nobody due says why, per person",
      /enabled, none due/.test(digest) && /whyNotDue\(a, now\)/.test(digest));
    check("    but stays quiet where nobody asked for one",
      /if \(wanted\.length > 0\)/.test(digest),
      "a line every five minutes on a deployment nobody uses is noise");
  }

  // ── the reader's morning, not the server's ──────────────────────────
  {
    // 13:30 UTC is 09:30 in New York and 14:30 in London. A digest set for 9
    // must arrive at 9 for both of them, from the same tick.
    check("nine in New York is not nine in UTC",
      localNow(NOW, "America/New_York").hour === 9 && localNow(NOW, "UTC").hour === 13,
      localNow(NOW, "America/New_York"));
    check("  so two people on different clocks get different answers",
      digestDue(prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, minute: 0, timeZone: "America/New_York", days: [] } }), NOW)
      && !digestDue(prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, minute: 0, timeZone: "Europe/London", days: [] } }), NOW));

    check("  midnight is hour zero, not hour twenty-four",
      localNow(Date.parse("2026-08-27T04:30:00Z"), "America/New_York").hour === 0,
      "reading it as 24 means a digest set for midnight never fires");

    // A bad zone should send at an odd hour, not stop sending.
    check("  an unknown timezone falls back rather than throwing",
      localNow(NOW, "Not/AZone").hour === 13);

    const weekdays = prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, minute: 0, timeZone: "America/New_York", days: [1, 2, 3, 4, 5] } });
    check("weekdays-only skips the weekend",
      digestDue(weekdays, NOW) && !digestDue(weekdays, NOW + 2 * DAY),
      localNow(NOW + 2 * DAY, "America/New_York"));
    check("  and an empty day list means every day",
      digestDue(prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, minute: 0, timeZone: "America/New_York", days: [] } }), NOW + 2 * DAY));

    check("nothing is due without an address",
      !digestDue({ ...weekdays, teamsAddress: undefined }, NOW),
      "otherwise it is marked sent every day and nobody ever receives one");
  }

  // ── a daily message with nothing in it ──────────────────────────────
  {
    const p = prefs();
    const empty = buildDigest(p, [], NOW);
    check("an empty digest is not sent by default",
      empty.card === null && empty.skipped === "nothing to report",
      "a daily 'you have nothing' is how a channel gets muted");
    check("  unless somebody asks for the all-clear",
      buildDigest({ ...p, digest: { ...p.digest, skipWhenEmpty: false } }, [], NOW).card !== null);

    const busy = buildDigest(p, [
      pr({ number: 1, author: "bob", requestedReviewers: ["alice"], mergeStateStatus: "BLOCKED" }),
      pr({ number: 2, author: "alice", reviewDecision: "APPROVED" }),
    ], NOW);
    check("a digest leads with what other people are blocked on",
      /1 review waiting on you/.test(text(busy.card)),
      "it is the only section where somebody else cannot proceed");
    check("  and counts what it shows", busy.counts.toReview === 1, busy.counts);

    // A pull request in two sections makes the counts look wrong.
    const ready = buildDigest(p, [pr({ number: 3, author: "alice", reviewDecision: "APPROVED" })], NOW);
    // One rendering, not the envelope: every payload now carries the card and
    // the text form of the same content, so counting across both would find
    // everything twice by design.
    const body = String((ready.card as any).message);
    // The section people scan fastest is the one that was omitting it.
    check("  a ready pull request says how long it has been ready",
      /quiet 1 day|updated today/.test(text(buildDigest(p,
        [pr({ number: 4, author: "alice", reviewDecision: "APPROVED" })], NOW).card)),
      "ready and untouched for three weeks is a different thing from ready this morning");

    check("  a ready pull request is listed once, not twice",
      (body.match(/web#3/g) ?? []).length === 1, body.match(/web#3/g));

    // The age is fractional because the staleness threshold is compared in
    // seconds, so it has to be rounded where it is rendered. It was not, and a
    // card said "quiet 10.742989347923849 days".
    const odd = buildDigest(p, [pr({
      number: 9, author: "alice", reviewDecision: "APPROVED",
      lastCommitAt: new Date(NOW - Math.round(10.742989 * 86_400_000)).toISOString(),
    })], NOW);
    const oddText = text(odd.card);
    check("  and says it in whole days",
      // Scoped to the age itself: the card carries its own schema version,
      // so looking for any decimal anywhere finds "1.4".
      /quiet 10 days/.test(oddText) && !/quiet [\d.]*\.\d/.test(oddText),
      (oddText.match(/quiet [^<"]*/g) ?? []).join(" | "));

    // Floored, not rounded: 10.7 days is ten whole days elapsed, and eleven is
    // a day that has not happened.
    check("  rounding down, since a part-day is not a day",
      !/quiet 11 days/.test(oddText));

    // Below a day this used to need an exact zero to read as today, so
    // anything touched three hours ago fell through to the day count.
    const fresh = text(buildDigest(p, [pr({
      number: 10, author: "alice", reviewDecision: "APPROVED",
      lastCommitAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    })], NOW).card);
    check("  and anything touched today says so, rather than quiet 0 days",
      /updated today/.test(fresh) && !/quiet 0 days/.test(fresh));
  }

  // ── how far back each section reaches ───────────────────────────────
  //
  // Two hundred pull requests nobody has touched in a year push the three from
  // this week that matter into the middle of a list nobody reads to the end of.
  {
    const old7 = pr({ number: 1, author: "bob", requestedReviewers: ["alice"],
      mergeStateStatus: "BLOCKED", lastCommitAt: new Date(NOW - 200 * DAY).toISOString() });
    const fresh = pr({ number: 2, author: "bob", requestedReviewers: ["alice"],
      mergeStateStatus: "BLOCKED", lastCommitAt: new Date(NOW - 2 * DAY).toISOString() });

    const base = defaults("alice").digest;
    const limited = prefs({ digest: { ...base, skipWhenEmpty: false,
      maxAgeDays: { toReview: 7, mine: 0, mergeable: 0 } } });
    const body = text(buildDigest(limited, [old7, fresh], NOW).card);

    check("a section drops what is quieter than its limit",
      /web#2/.test(body) && !/web#1/.test(body), body.slice(0, 200));

    // A heading of twelve over a list of three is the sort of quiet
    // disagreement that makes somebody stop trusting the whole message.
    check("  and its heading counts what survived",
      /Waiting for your review \(1\)/.test(body), body.slice(0, 200));

    const unlimited = prefs({ digest: { ...base, skipWhenEmpty: false,
      maxAgeDays: { toReview: 0, mine: 0, mergeable: 0 } } });
    check("  zero means no limit, which is the default",
      /web#1/.test(text(buildDigest(unlimited, [old7, fresh], NOW).card)),
      "a summary that silently omits what nobody asked it to omit is worse than a long one");

    // Age is silence, not age: something touched this morning is not old.
    const oldButBusy = pr({ number: 3, author: "bob", requestedReviewers: ["alice"],
      mergeStateStatus: "BLOCKED",
      createdAt: new Date(NOW - 300 * DAY).toISOString(),
      lastCommitAt: new Date(NOW - 1 * DAY).toISOString() });
    check("  measured from the last commit, not from when it was opened",
      /web#3/.test(text(buildDigest(limited, [oldButBusy], NOW).card)),
      "a pull request touched this morning is not stale however long ago it started");

    check("  a limit applies only to the section it is set on",
      /web#1/.test(text(buildDigest(prefs({ digest: { ...base, skipWhenEmpty: false,
        maxAgeDays: { toReview: 0, mine: 7, mergeable: 7 } } }), [old7, fresh], NOW).card)),
      "the sections age differently, which is why the limit is per section");

    // Rows written before this existed have no value for it.
    const noField = { ...prefs(), digest: { ...base, skipWhenEmpty: false, maxAgeDays: undefined } } as any;
    check("  a row from before this existed behaves as it did",
      /web#1/.test(text(buildDigest(noField, [old7, fresh], NOW).card)));
  }

  // ── where the app will POST ─────────────────────────────────────────
  //
  // One URL for the whole organization now, set by an administrator, so the
  // allow-list guards one field rather than one per person. A Lambda still
  // posts to whatever is stored with no further checks.
  {
    check("a Teams webhook is accepted",
      badWebhook("https://acme.webhook.office.com/webhookb2/x") === null);
    check("  as is a Logic Apps one",
      badWebhook("https://prod-12.westus.logic.azure.com/workflows/x") === null);
    check("  as is a current Power Platform one",
      badWebhook("https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x") === null,
      "the feature has moved twice and all three hosts are in use at once");
    for (const [label, url] of [
      ["plain http", "http://acme.webhook.office.com/x"],
      ["somebody else's host", "https://evil.example.com/hook"],
      ["a host that merely contains the words", "https://webhook.office.com.evil.example.com/x"],
      ["a lookalike on the new host too", "https://powerplatform.com.evil.example.com/x"],
      ["nonsense", "not a url"],
    ] as [string, string][]) {
      check(`  ${label} is refused`, badWebhook(url) !== null, url);
    }
  }

  // ── what a person supplies is who they are ──────────────────────────
  //
  // An address, not infrastructure. Checked as an email and no further: which
  // addresses actually reach somebody in Teams is a question only the tenant
  // can answer, and a stricter pattern refuses valid ones while catching
  // nothing a typo produces.
  {
    check("a work address is accepted", badTeamsAddress("a-person@company.com") === null);
    for (const [label, value] of [
      ["an empty one", ""],
      ["no domain", "a-person"],
      ["no dot in the domain", "a-person@company"],
      ["a space in it", "a person@company.com"],
    ] as [string, string][]) {
      check(`  ${label} is refused`, badTeamsAddress(value) !== null, value);
    }
    check("  and the refusal says what to use",
      /work address/.test(badTeamsAddress("nope") ?? ""));
  }

  // ── who gets told, and who does not ─────────────────────────────────
  {
    const asked = recipientsFor("pull_request", {
      action: "review_requested",
      sender: { login: "bob" },
      requested_reviewer: { login: "alice" },
      pull_request: { number: 4, title: "t", html_url: "u", user: { login: "bob" } },
      repository: { name: "web" },
    });
    check("the person asked to review is told",
      asked.length === 1 && asked[0].login === "alice" && asked[0].kind === "reviewRequested");

    // Being told you did something you just did is the fastest way to make
    // somebody switch the whole thing off.
    check("  nobody is told about their own action",
      recipientsFor("pull_request", {
        action: "review_requested", sender: { login: "alice" },
        requested_reviewer: { login: "alice" },
        pull_request: { number: 4, title: "t", html_url: "u", user: { login: "alice" } },
      }).length === 0);

    // A team request names no individual, and guessing the members would
    // message people nobody asked.
    check("  a team request notifies nobody rather than everybody",
      recipientsFor("pull_request", {
        action: "review_requested", sender: { login: "bob" },
        requested_team: { slug: "platform" },
        pull_request: { number: 4, title: "t", html_url: "u", user: { login: "bob" } },
      }).length === 0);

    const changes = recipientsFor("pull_request_review", {
      action: "submitted", sender: { login: "bob" },
      review: { state: "changes_requested" },
      pull_request: { number: 5, title: "t", html_url: "u", user: { login: "alice" } },
    });
    check("changes requested reaches the author",
      changes.length === 1 && changes[0].login === "alice" && changes[0].kind === "changesRequested");

    /**
     * Approval reaches the author too, which reverses an earlier decision.
     *
     * It was left out on the reasoning that nothing is being asked of anybody,
     * so there is nothing to interrupt for. That reads the message as a request
     * and it is not one: it is the moment a thing somebody was blocked on
     * stopped being blocked, and it is the one notification here that lets them
     * go and merge. Asked for explicitly, and switched on by default alongside
     * the other two.
     */
    const approved = recipientsFor("pull_request_review", {
      action: "submitted", sender: { login: "bob" }, review: { state: "APPROVED" },
      pull_request: { number: 5, title: "t", html_url: "u", user: { login: "alice" } },
    });
    check("an approval reaches the author",
      approved.length === 1 && approved[0].login === "alice"
        && approved[0].kind === "approved" && approved[0].actor === "bob", approved);

    // GitHub sends the verdict in either case, and every other reader here
    // upper-cases it before comparing.
    check("  whatever case GitHub sends the verdict in",
      recipientsFor("pull_request_review", {
        action: "submitted", sender: { login: "bob" }, review: { state: "approved" },
        pull_request: { number: 5, title: "t", html_url: "u", user: { login: "alice" } },
      })[0]?.kind === "approved");

    /**
     * A review with no verdict is a conversation, not a decision, and it
     * arrives in the same shape as the two that are. Notifying on it would make
     * the approval message the one people learn to ignore.
     */
    check("  a comment-only review is not an approval",
      recipientsFor("pull_request_review", {
        action: "submitted", sender: { login: "bob" }, review: { state: "COMMENTED" },
        pull_request: { number: 5, title: "t", html_url: "u", user: { login: "alice" } },
      }).length === 0);

    // GitHub does not let somebody approve their own pull request, but an
    // integration acting as the author can.
    check("  and nobody is told they approved their own work",
      recipientsFor("pull_request_review", {
        action: "submitted", sender: { login: "alice" }, review: { state: "APPROVED" },
        pull_request: { number: 5, title: "t", html_url: "u", user: { login: "alice" } },
      }).length === 0);

    /**
     * No age limit, and none to add.
     *
     * The daily summary can be told to ignore pull requests older than N days,
     * because it is a pile somebody works through. An approval is not a pile,
     * and it is *most* worth knowing about on the pull request that has been
     * open longest, which is exactly the one an age limit would silence. So the
     * event path must carry no date arithmetic at all.
     */
    const years = new Date(Date.now() - 900 * 86_400_000).toISOString();
    check("  an approval on a very old pull request is still sent",
      recipientsFor("pull_request_review", {
        action: "submitted", sender: { login: "bob" }, review: { state: "APPROVED" },
        pull_request: {
          number: 5, title: "t", html_url: "u", user: { login: "alice" },
          created_at: years, updated_at: years,
        },
      }).length === 1, "the oldest pull request is the one this matters most on");

    const events = fs.readFileSync("./src/webhooks/devEvents.ts", "utf8");
    check("  because the event path has no age filter to acquire one",
      !/maxAgeDays|created_at|updated_at|86_?400/.test(events),
      "an age limit here would silence the case this exists for");

    check("an event nobody opted into is not sent",
      !wants({ ...prefs(), events: { reviewRequested: false, changesRequested: true, approved: true } },
        "reviewRequested"));
    check("  including a new one somebody has switched off",
      !wants({ ...prefs(), events: { reviewRequested: true, changesRequested: true, approved: false } },
        "approved"));
    check("  nor is anything at all without an address",
      !wants({ ...prefs(), teamsAddress: undefined }, "reviewRequested"));

    // Merged onto the defaults, so a row written before this preference
    // existed gets it rather than reading as switched off.
    check("somebody set up before this existed gets it",
      defaults("alice").events.approved === true);

    const card = buildEventCard({
      kind: "approved", repo: "web", number: 5, title: "Fix the thing",
      url: "https://e/5", actor: "bob",
    });
    check("  and the card names who approved it",
      text(card).includes("bob approved this."), text(card).slice(0, 200));
    check("  with the pull request in the first line",
      text(card).includes("Approved: web#5"), text(card).slice(0, 200));
  }

  // ── the card itself ─────────────────────────────────────────────────
  {
    // Titles containing brackets are common: "[WIP] Fix the thing".
    check("a bracketed title does not break its own link",
      escapeMd("[WIP] fix") === "\\[WIP\\] fix", escapeMd("[WIP] fix"));
    const card = buildCard("T", "S", [{ heading: "H", links: [{ title: "[WIP] x", url: "https://e/1" }] }]);
    check("  and the escaped form is what reaches Teams",
      /\\\\\[WIP\\\\\]/.test(JSON.stringify(card)) || text(card).includes("\\\\[WIP\\\\]"),
      text(card).slice(0, 300));

    // Teams builds a notification preview from the message body. A card has no
    // body, so the card action produces "sent a card" whatever it contains, and
    // nothing inside the card changes that.
    const both = buildCard("Review requested: web#7", "bob asked you", [
      { heading: "", links: [{ title: "Fix <b>things</b> & stuff", url: "https://e/1" }] },
    ]) as any;
    check("every message carries a text rendering as well as a card",
      typeof both.message === "string" && both.message.length > 0,
      "the flow decides which it reads, so switching is one field there and no deploy here");
    check("  which leads with the title, since that is all a toast shows",
      /^<b>Review requested: web#7<\/b>/.test(both.message), both.message.slice(0, 80));
    check("  and escapes what people wrote",
      /Fix &lt;b&gt;things&lt;\/b&gt; &amp; stuff/.test(both.message),
      "a pull request title is somebody else's text going into a chat message");
    check("  while the card is still there for a flow that reads it",
      Array.isArray(both.attachments) && both.attachments.length === 1,
      "a flow on the old action must keep working");

    check("the card is the Workflows shape, not a retired connector card",
      text(buildCard("a", "b", [])).includes("application/vnd.microsoft.card.adaptive"),
      "MessageCard works today and stops when Office 365 connectors go");

    // Teams shows "sent a card" without one, and a notification nobody can
    // triage from the toast is one people learn to swipe away.
    const preview = JSON.stringify(buildCard("Review requested", "bob asked you", []));
    // The first words decide whether somebody switches applications, so an
    // alarm leads with its state rather than burying it in brackets mid-line.
    const { previewTitle } = await import("./src/services/notifyService");
    check("an alarm leads with its state",
      previewTitle("[ALARM] Vuln repos: Critical is 5") === "ALARM - Vuln repos: Critical is 5",
      previewTitle("[ALARM] Vuln repos: Critical is 5"));
    check("  recovery too", previewTitle("[OK] x: y") === "OK - x: y");
    check("  and anything without a tag is left as its author wrote it",
      previewTitle("Renovate opened 3 pull requests") === "Renovate opened 3 pull requests",
      "rewriting the rest would be editing somebody's template");

    check("an event leads with what happened and which pull request",
      /"summary":"Review requested: web#7/.test(text(buildEventCard(
        { kind: "reviewRequested", repo: "web", number: 7, title: "x", url: "u", actor: "bob" }))),
      "a toast has room for one line and which pull request belongs in it");

    check("a card carries preview text for the notification",
      /"summary":"Review requested: bob asked you"/.test(preview), preview.slice(0, 130));
    check("  and the card's own spoken form too",
      /"speak":"Review requested\. bob asked you"/.test(preview));

    const e = buildEventCard({ kind: "reviewRequested", repo: "web", number: 7, title: "x", url: "u", actor: "bob" });
    check("an event card names who caused it", /bob asked you to review/.test(text(e)));
  }

  // ── storage cannot collide with the organization's own row ──────────
  {
    check("a person's row is prefixed", keyFor("Alice").startsWith(KEY_PREFIX));
    check("  and lower-cased, since GitHub logins are case-insensitive",
      keyFor("Alice") === keyFor("alice"),
      "two rows for one person means settings that half apply");
  }

  // ── what saving settings does to today's summary ────────────────────
  //
  // The bug this covers: setting a time that had already gone by sent a
  // summary within five minutes, and because the form saved on every change,
  // adjusting the time sent several.
  {
    const at = (hour: number, minute: number, over: Partial<DevAlerts["digest"]> = {}) =>
      prefs({ digest: { ...defaults("a").digest, enabled: true, hour, minute, timeZone: "UTC", days: [], ...over } });
    // 14:30 UTC, so 14:00 is behind us and 15:00 is ahead.
    const AFTERNOON = Date.parse("2026-03-04T14:30:00Z");

    check("a time still ahead today clears the record, so it can arrive today",
      nextDigestRecord(at(9, 0), at(15, 0), AFTERNOON) === undefined,
      "otherwise a schedule set this morning cannot be tested until tomorrow");

    check("a time already past today does not, so it waits for tomorrow",
      nextDigestRecord(at(9, 0), at(14, 0), AFTERNOON) !== undefined,
      "setting 12:45 at 12:48 means tomorrow, not in two minutes");

    check("  and the same minute counts as past, since that tick has run",
      nextDigestRecord(at(9, 0), at(14, 30), AFTERNOON) !== undefined,
      "a window that opened before the setting was saved was never for this setting");

    check("  so a past time is not due on the next tick",
      whyNotDue(
        { ...at(9, 0), lastDigestAt: nextDigestRecord(at(9, 0), at(14, 0), AFTERNOON), digest: at(14, 0).digest },
        AFTERNOON + 5 * 60_000) === "already sent today",
      "this is the repeat somebody actually received");

    check("changing only what is in the summary leaves the record alone",
      nextDigestRecord(
        { ...at(9, 0), lastDigestAt: "2026-03-04T09:00:00Z" },
        at(9, 0, {}), AFTERNOON) === "2026-03-04T09:00:00Z",
      "toggling a section at nine in the evening should not produce a second summary");

    check("turning it on is a reschedule, so a time still ahead arrives today",
      nextDigestRecord(
        { ...at(15, 0), digest: { ...at(15, 0).digest, enabled: false } },
        at(15, 0), AFTERNOON) === undefined,
      "switching it on and hearing nothing for a day reads as broken");

    // The zone is the frame every one of those comparisons is made in, so
    // getting it wrong moves the whole schedule rather than breaking it
    // visibly.
    // 14:30 UTC is 06:30 in Los Angeles, so 09:00 is behind in UTC and ahead
    // there. Reading it in the wrong frame does not fail visibly, it moves
    // everybody's summary by their offset.
    check("the time is read in the person's own zone, not the server's",
      nextDigestRecord(at(20, 0), at(9, 0, { timeZone: "America/Los_Angeles" }), AFTERNOON) === undefined
      && nextDigestRecord(at(20, 0), at(9, 0), AFTERNOON) !== undefined,
      "09:00 is still ahead in Los Angeles when it is 14:30 UTC, and behind in UTC");

    // The sequence that lost a day's summary, in the order somebody actually
    // does it: set the time, then notice the zone is wrong and correct it.
    //
    // 14:30 UTC. The old zone is UTC, where 14:10 has gone by; the new zone is
    // one hour behind, where it is only 13:30 and 14:10 is still to come.
    {
      const BEHIND = "Atlantic/Cape_Verde";   // UTC-1, no daylight saving
      const start = at(9, 0);

      // Step one: the time is saved while the zone is still the old one, so it
      // is judged against a clock where it has already passed.
      const afterTime = nextDigestRecord(start, at(14, 10), AFTERNOON);
      check("setting a time that has passed marks the day done",
        afterTime !== undefined,
        "which is correct on its own, and is what the next step has to undo");

      // Step two: the zone is corrected. In the new zone 14:10 is still ahead.
      const withZone = { ...at(14, 10), lastDigestAt: afterTime };
      const afterZone = nextDigestRecord(withZone, at(14, 10, { timeZone: BEHIND }), AFTERNOON);
      check("  and correcting the zone afterwards gives the day back",
        afterZone === undefined,
        "the zone moves the schedule, so it has to re-decide like the clock does");

      // The whole point: it is then actually due at the moment it names.
      const ready = { ...at(14, 10, { timeZone: BEHIND }), lastDigestAt: afterZone };
      check("  so the summary arrives at the time on screen",
        whyNotDue(ready, Date.parse("2026-03-04T15:10:00Z")) === null,
        whyNotDue(ready, Date.parse("2026-03-04T15:10:00Z")));

      // And the rule still holds in the other direction: a zone change that
      // leaves the time in the past must not fire a second summary.
      const AHEAD = "Asia/Tokyo";   // 23:30 there when it is 14:30 UTC
      check("  while a zone change that leaves the time behind does not resend",
        nextDigestRecord(start, at(14, 10, { timeZone: AHEAD }), AFTERNOON) !== undefined,
        "14:10 is long gone in Tokyo, so today's is done");
    }

    const route2 = fs.readFileSync("./src/routes/me.ts", "utf8");
    check("an unrecognised timezone is refused rather than stored",
      /timeZone: knownZone\(body\.digest\?\.timeZone\)/.test(route2),
      "it becomes UTC further down, and the only symptom is the wrong hour");
  }

  // ── the wiring ──────────────────────────────────────────────────────
  {
    const route = fs.readFileSync("./src/routes/me.ts", "utf8");
    check("the shared flow URL is never returned to the browser",
      /res\.json\(\{ configured: !!flow\?\.url/.test(fs.readFileSync("./src/routes/alarms.ts", "utf8")),
      "anybody holding it can post as the flow, to anyone");
    check("  but a person's own address is, since it is not a credential",
      /res\.json\(\{ \.\.\.a, teamsReady/.test(route),
      "being unable to see what you typed is how a typo survives");
    check("  and settings are always the caller's own",
      !/req\.query\.login/.test(route.slice(route.indexOf('router.get("/alerts"'))),
      "reading somebody else's would be a way to send messages as them");
    check("a test send exists, and uses real data",
      /router\.post\("\/alerts\/test"/.test(route) && /skipWhenEmpty: false/.test(route),
      "a wrong address otherwise fails silently until somebody notices they hear nothing");
    // Two different things can be missing and only one is the caller's to fix.
    // Without this, somebody who sets a time this afternoon waits until
    // tomorrow to learn whether it works, with nothing explaining the silence.
    check("saving settings decides the record through nextDigestRecord",
      /lastDigestAt: nextDigestRecord\(current, next\)/.test(route),
      "inline, the rule that stops a repeat cannot be tested");

    check("  and tells apart no address from no flow",
      /No Teams address is set yet/.test(route) && /not set up for this organization/.test(route),
      "telling somebody to check their own settings when an admin has not set up the flow sends them nowhere");

    const digest = fs.readFileSync("./src/alarms/devDigest.ts", "utf8");
    // The Teams trigger has a fixed schema with nowhere to declare extra
    // fields, so the body has to be the shape it already expects.
    const client = fs.readFileSync("./src/services/teamsClient.ts", "utf8");
    check("the recipient rides alongside the ordinary Teams envelope",
      /post\(flowUrl, \{ \.\.\.card, recipient \}, timeoutMs\)/.test(client),
      "a body the trigger does not recognise is a body it may refuse");
    check("  so the card binding the template wrote keeps working",
      !/card: JSON\.stringify/.test(client),
      "restringing the card would mean a third field for somebody to rebind by hand");

    // It used to run last, behind alarm evaluation, the widget snapshots, a
    // GraphQL walk of every open pull request and the reminder pass. A summary
    // asked for at 11:45 arriving at 11:48 reads as an approximate schedule.
    const handler = fs.readFileSync("./src/alarms/handler.ts", "utf8");
    // Compared on the call sites, not the imports: an import sits at the top of
    // the file whatever order the work runs in.
    // Matched on `evaluateAlarms({` rather than `await evaluateAlarms(`, because
    // the call is wrapped in withPinnedGraph and no longer has its own await.
    check("the digest runs before the slow work, not after it",
      handler.indexOf("await runDigestPass()") < handler.indexOf("evaluateAlarms({")
      && handler.indexOf("await runDigestPass()") < handler.indexOf("fetchOpenPrs(graphql"),
      "everything ahead of it is minutes on a real organization");
    check("  and still cannot take the alarms down with it",
      /try \{\s*\n\s*const \{ runDigestPass \}/.test(handler));

    check("one flow serves everybody",
      /sendToPerson\(flowUrl, person\.teamsAddress!/.test(digest),
      "a pipe per person is ten steps in Power Automate per person");
    check("  and a missing flow is said once, not once per person",
      /No Teams flow is configured/.test(digest));
    check("the digest reads the stored snapshot, not GitHub",
      /readPrSnapshot/.test(digest) && !/fetchOpenPrs/.test(digest),
      "otherwise the feature gets more expensive the more people use it");
    check("  a failed send still marks the day done",
      /recordSent\(\{ \.\.\.person, lastError: result\.error/.test(digest),
      "retrying a broken address every five minutes is twelve failures instead of one");
    // The only thing between one message a day and one every five minutes.
    check("  and a failure to record it is shouted about, not swallowed",
      /console\.error\([\s\S]{0,200}sent again on the next tick/.test(digest),
      "swallowed, every tick concludes the digest is still due and nothing says why");
    check("  and a missing snapshot does not mark it done",
      /skipped: due\.length/.test(digest),
      "the next tick in the same hour should try again rather than skip the day");

    const worker = fs.readFileSync("./src/webhooks/processDelivery.ts", "utf8");
    check("event delivery cannot fail the webhook it rides on",
      /notifyDevEvents[\s\S]{0,200}catch/.test(worker),
      "a throw releases the claim and re-runs every other effect of the event");

    const readme = fs.readFileSync("../README.md", "utf8");
    check("the extra subscription this needs is documented",
      /pull_request_review/.test(readme),
      "without it the changes-requested notification silently never fires");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
