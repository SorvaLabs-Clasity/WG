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
  defaults, badWebhook, digestDue, localNow, keyFor, KEY_PREFIX, type DevAlerts,
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
  webhookUrl: "https://acme.webhook.office.com/webhookb2/abc",
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
    const p = prefs({ digest: { ...defaults("alice").digest, enabled: true, hour: 9, timeZone: "America/New_York", days: [] } });
    check("a digest is due in its own hour", digestDue(p, NOW));
    check("  and not an hour later", !digestDue(p, NOW + 3_600_000));

    // Twelve ticks fall inside any chosen hour.
    const sent = { ...p, lastDigestAt: new Date(NOW).toISOString() };
    check("  once sent, the rest of the hour is quiet",
      !digestDue(sent, NOW + 5 * 60_000) && !digestDue(sent, NOW + 55 * 60_000),
      "the pass ticks every five minutes and would send twelve copies");
    check("  but tomorrow it is due again", digestDue(sent, NOW + DAY));
  }

  // ── the reader's morning, not the server's ──────────────────────────
  {
    // 13:30 UTC is 09:30 in New York and 14:30 in London. A digest set for 9
    // must arrive at 9 for both of them, from the same tick.
    check("nine in New York is not nine in UTC",
      localNow(NOW, "America/New_York").hour === 9 && localNow(NOW, "UTC").hour === 13,
      localNow(NOW, "America/New_York"));
    check("  so two people on different clocks get different answers",
      digestDue(prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, timeZone: "America/New_York", days: [] } }), NOW)
      && !digestDue(prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, timeZone: "Europe/London", days: [] } }), NOW));

    check("  midnight is hour zero, not hour twenty-four",
      localNow(Date.parse("2026-08-27T04:30:00Z"), "America/New_York").hour === 0,
      "reading it as 24 means a digest set for midnight never fires");

    // A bad zone should send at an odd hour, not stop sending.
    check("  an unknown timezone falls back rather than throwing",
      localNow(NOW, "Not/AZone").hour === 13);

    const weekdays = prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, timeZone: "America/New_York", days: [1, 2, 3, 4, 5] } });
    check("weekdays-only skips the weekend",
      digestDue(weekdays, NOW) && !digestDue(weekdays, NOW + 2 * DAY),
      localNow(NOW + 2 * DAY, "America/New_York"));
    check("  and an empty day list means every day",
      digestDue(prefs({ digest: { ...defaults("a").digest, enabled: true, hour: 9, timeZone: "America/New_York", days: [] } }), NOW + 2 * DAY));

    check("nothing is due without a webhook",
      !digestDue({ ...weekdays, webhookUrl: undefined }, NOW),
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
    const body = text(ready.card);
    check("  a ready pull request is listed once, not twice",
      (body.match(/web#3/g) ?? []).length === 1, body.match(/web#3/g));
  }

  // ── where the app will POST ─────────────────────────────────────────
  //
  // A Lambda posts to whatever is stored, with no further checks.
  {
    check("a Teams webhook is accepted",
      badWebhook("https://acme.webhook.office.com/webhookb2/x") === null);
    check("  as is a Logic Apps one",
      badWebhook("https://prod-12.westus.logic.azure.com/workflows/x") === null);
    // The one that was wrongly refused: current Power Platform environments
    // issue this host, and a list naming only the older two rejects a URL that
    // came straight out of the Workflows connector.
    check("  as is a current Power Platform one",
      badWebhook("https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x") === null,
      "the feature has moved twice and all three hosts are in use at once");
    check("  and a Power Automate flow host",
      badWebhook("https://emea.flow.microsoft.com/workflows/x") === null);
    for (const [label, url] of [
      ["plain http", "http://acme.webhook.office.com/x"],
      ["somebody else's host", "https://evil.example.com/hook"],
      ["a host that merely contains the words", "https://webhook.office.com.evil.example.com/x"],
      ["a lookalike on the new host too", "https://powerplatform.com.evil.example.com/x"],
      ["nonsense", "not a url"],
      ["a file URL", "file:///etc/passwd"],
    ] as [string, string][]) {
      check(`  ${label} is refused`, badWebhook(url) !== null, url);
    }
    check("  and the refusal says where to get a real one",
      /Workflows connector/.test(badWebhook("https://evil.example.com/x") ?? ""));
    // Somebody holding a legitimate URL on a host nobody thought of needs to be
    // able to tell that apart from having pasted the wrong thing.
    check("    names the hosts it accepts, and the one you gave",
      /powerplatform\.com/.test(badWebhook("https://evil.example.com/x") ?? "")
      && /evil\.example\.com/.test(badWebhook("https://evil.example.com/x") ?? ""),
      badWebhook("https://evil.example.com/x"));
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
    check("  an approval does not, since nothing is being asked of anybody",
      recipientsFor("pull_request_review", {
        action: "submitted", sender: { login: "bob" }, review: { state: "approved" },
        pull_request: { number: 5, title: "t", html_url: "u", user: { login: "alice" } },
      }).length === 0);

    check("an event nobody opted into is not sent",
      !wants({ ...prefs(), events: { reviewRequested: false, changesRequested: true } }, "reviewRequested"));
    check("  nor is anything at all without a webhook",
      !wants({ ...prefs(), webhookUrl: undefined }, "reviewRequested"));
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

    check("the card is the Workflows shape, not a retired connector card",
      text(buildCard("a", "b", [])).includes("application/vnd.microsoft.card.adaptive"),
      "MessageCard works today and stops when Office 365 connectors go");

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

  // ── the wiring ──────────────────────────────────────────────────────
  {
    const route = fs.readFileSync("./src/routes/me.ts", "utf8");
    check("the webhook URL is never returned to the browser",
      /const \{ webhookUrl, \.\.\.rest \} = a;/.test(route) && /webhookConfigured/.test(route),
      "anyone who reads it can post into that channel forever");
    check("  and settings are always the caller's own",
      !/req\.query\.login/.test(route.slice(route.indexOf('router.get("/alerts"'))),
      "reading somebody else's would be a way to send messages as them");
    check("a test send exists, and uses real data",
      /router\.post\("\/alerts\/test"/.test(route) && /skipWhenEmpty: false/.test(route),
      "a wrong URL otherwise fails silently until somebody notices they hear nothing");

    const digest = fs.readFileSync("./src/alarms/devDigest.ts", "utf8");
    check("the digest reads the stored snapshot, not GitHub",
      /readPrSnapshot/.test(digest) && !/fetchOpenPrs/.test(digest),
      "otherwise the feature gets more expensive the more people use it");
    check("  a failed send still marks the day done",
      /lastDigestAt: stamp,\s*\n\s*lastError/.test(digest),
      "retrying a broken webhook every five minutes is twelve failures instead of one");
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
