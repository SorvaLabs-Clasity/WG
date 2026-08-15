/**
 * Per-event emails for Renovate pull requests and Dependabot alerts.
 *
 * These fire once and never resolve, so every failure mode here is silent in
 * one of two directions and neither announces itself:
 *
 *   - not sending. A bot login that does not match, a severity floor rejecting
 *     everything, a feed left off. The tab still fills in, so the only symptom
 *     is mail that never arrives, which reads as "nothing happened".
 *   - sending too much. The same event emailed twice, or a floor that filters
 *     nothing because it was stored on a feed that has no severity.
 */
import fs from "fs";
import path from "path";
import {
  notifyRenovatePr, notifyDependabotAlert, isConfiguredBot, buildDigest, flushPending,
  normalizeSeverity,
  type FeedNotifyDeps, type PendingRow,
} from "./src/alarms/feedNotify";
import { SUBJECT_MAX } from "./src/alarms/message";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const PR = {
  repo: "Acme-Org/api", number: 42, title: "Update lodash to 4.17.21",
  url: "https://github.com/Acme-Org/api/pull/42",
  author: "acme-renovate[bot]", openedAt: "2026-08-15T10:00:00Z",
};

const ALERT = {
  repo: "Acme-Org/api", package: "lodash", summary: "Prototype pollution in lodash",
  severity: "high", url: "https://github.com/Acme-Org/api/security/dependabot/1",
  createdAt: "2026-08-15T10:00:00Z",
};

function deps(over: Partial<{
  enabled: boolean; groupId?: string; minSeverity?: string;
  subject: string; body: string; topic?: string;
}> = {}) {
  const sent: { subject: string; body: string }[] = [];
  const d: FeedNotifyDeps = {
    settings: async () => ({
      enabled: over.enabled ?? true,
      groupId: "groupId" in over ? over.groupId : "g1",
      minSeverity: over.minSeverity,
      subjectTemplate: over.subject ?? "{{repo}} {{title}}{{package}}",
      bodyTemplate: over.body ?? "{{url}} {{severity}} {{number}} {{advisory}} {{time}}",
    }),
    topicArnFor: async () => ("topic" in over ? over.topic : "arn:aws:sns:::t"),
    publish: async (_t, subject, body) => { sent.push({ subject, body }); return true; },
    timezone: async () => "UTC",
    org: "Acme-Org",
  };
  return { d, sent };
}

(async () => {
  // ── the bot login, which is where this silently does nothing ────────
  {
    // A GitHub App's deliveries carry the login with a [bot] suffix; the name
    // typed into settings is the one shown on the pull request, without it.
    // Comparing raw matches nothing and the feature looks simply switched off.
    check("the configured name matches the suffixed login GitHub sends",
      isConfiguredBot("acme-renovate[bot]", "acme-renovate"));
    check("  and the suffixed name matches the suffixed login",
      isConfiguredBot("acme-renovate[bot]", "acme-renovate[bot]"));
    check("  and an unsuffixed login matches either form",
      isConfiguredBot("acme-renovate", "acme-renovate[bot]")
        && isConfiguredBot("acme-renovate", "acme-renovate"));
    check("  case does not matter", isConfiguredBot("Acme-Renovate[bot]", "acme-renovate"));
    check("  nor does surrounding whitespace", isConfiguredBot("acme-renovate[bot]", "  acme-renovate  "));

    check("a different account does not match", !isConfiguredBot("dependabot[bot]", "acme-renovate"));
    check("  a partial name does not match",
      !isConfiguredBot("acme-renovate-staging[bot]", "acme-renovate"),
      "a substring match would email for a different bot's pull requests");

    // Both empty strips to both empty, which would otherwise match and email on
    // every pull request in the organization.
    check("an unset bot matches nothing",
      !isConfiguredBot("someone", undefined) && !isConfiguredBot("someone", "")
        && !isConfiguredBot("", ""),
      "an unconfigured bot would email for every pull request opened");
    check("  and a bare [bot] suffix is not a name",
      !isConfiguredBot("[bot]", "[bot]"));
  }

  // ── renovate: when it sends ─────────────────────────────────────────
  {
    const { d, sent } = deps();
    check("a matching pull request is emailed",
      await notifyRenovatePr(PR, "acme-renovate", d) === "sent" && sent.length === 1, sent);
    check("  the body carries the link, which is the point of the email",
      sent[0]?.body.includes(PR.url), sent[0]?.body);
    check("  and the number and title",
      sent[0]?.body.includes("42") && sent[0]?.subject.includes("Update lodash to 4.17.21"),
      sent[0]);

    const off = deps({ enabled: false });
    check("a feed that is off sends nothing",
      await notifyRenovatePr(PR, "acme-renovate", off.d) === "disabled" && off.sent.length === 0);

    const other = deps();
    check("another account's pull request is not emailed",
      await notifyRenovatePr({ ...PR, author: "a-human" }, "acme-renovate", other.d) === "not-the-bot"
        && other.sent.length === 0,
      "every pull request the team opens would be emailed");

    // Reported as itself rather than as a missing group, so whoever is
    // debugging is sent to the field that is actually wrong.
    const noBot = deps();
    check("  an unconfigured bot reports as the bot, not as a missing group",
      await notifyRenovatePr(PR, undefined, noBot.d) === "not-the-bot");

    const noGroup = deps({ groupId: undefined });
    check("no group selected sends nothing",
      await notifyRenovatePr(PR, "acme-renovate", noGroup.d) === "no-group" && noGroup.sent.length === 0);

    const deadGroup = deps({ topic: undefined });
    check("  a group whose topic has gone reports no-group rather than throwing",
      await notifyRenovatePr(PR, "acme-renovate", deadGroup.d) === "no-group");
  }

  // ── dependabot: the severity floor ──────────────────────────────────
  {
    const { d, sent } = deps({ minSeverity: "high" });
    check("an alert at the floor is emailed",
      await notifyDependabotAlert(ALERT, d) === "sent" && sent.length === 1);
    check("  the body carries the advisory link and the summary",
      sent[0]?.body.includes(ALERT.url) && sent[0]?.body.includes("Prototype pollution"), sent[0]?.body);
    check("  and the subject names the package",
      sent[0]?.subject.includes("lodash"), sent[0]?.subject);

    const above = deps({ minSeverity: "high" });
    check("above the floor is emailed",
      await notifyDependabotAlert({ ...ALERT, severity: "critical" }, above.d) === "sent");

    const below = deps({ minSeverity: "high" });
    check("below the floor is not",
      await notifyDependabotAlert({ ...ALERT, severity: "medium" }, below.d) === "below-threshold"
        && below.sent.length === 0);

    // Absent must mean no floor. Treating it as a floor of "critical" would
    // silently drop everything; treating it as "low" is the honest reading.
    const noFloor = deps({ minSeverity: undefined });
    check("no floor set means everything is emailed, not nothing",
      await notifyDependabotAlert({ ...ALERT, severity: "low" }, noFloor.d) === "sent",
      "an absent floor that filtered everything would look like a broken feed");

    // GitHub says "moderate"; the app says "medium". The webhook translates it
    // once, so an unmapped value here would sort below low and never send.
    const moderate = deps({ minSeverity: "medium" });
    check("a medium alert clears a medium floor",
      await notifyDependabotAlert({ ...ALERT, severity: "medium" }, moderate.d) === "sent");
  }

  // ── the webhook wiring ──────────────────────────────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, "src/webhooks/processDelivery.ts"), "utf8");

    check("the worker handles pull_request opened",
      /event === "pull_request" && payload\.action === "opened"/.test(src),
      "the delivery arrives and is dropped");
    check("  and dependabot_alert created",
      /event === "dependabot_alert" && payload\.action === "created"/.test(src));

    // Only "opened". Renovate force-pushes to its branches constantly, so
    // synchronize or reopened would email on every rebase. Scoped to the
    // pull_request condition itself: `action === "edited"` is legitimate a few
    // lines away, on team events, and matching the whole file catches that.
    const prCondition = /event === "pull_request"[^\n]*/.exec(src)?.[0] ?? "";
    check("  and only on opened, not on every update to the pull request",
      prCondition.includes('"opened"')
        && !/"(synchronize|reopened|edited)"/.test(prCondition),
      prCondition || "no pull_request condition found");

    // GitHub's "moderate" has to become "medium" before it reaches a threshold
    // written in the app's vocabulary, or a medium floor drops moderate alerts.
    //
    // Comments stripped first. The prose above names "moderate" in order to
    // explain the translation, so a loose match against the raw file passes on
    // the strength of the comment even after the code is deleted — which is
    // what it did until a mutation proved it.
    const code = src.split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .map(l => l.replace(/\s*\/\/.*$/, ""))
      .join("\n");
    // Exercised, not grepped. The pattern used to be asserted as text, which
    // passed while the buffered path — the default — had lost it, because an
    // identical copy still existed on the immediate path.
    check("  GitHub's \"moderate\" becomes this app's \"medium\"",
      normalizeSeverity("moderate") === "medium", normalizeSeverity("moderate"));
    for (const s of ["critical", "high", "medium", "low"]) {
      check(`  and "${s}" is passed through`, normalizeSeverity(s) === s);
    }
    check("  an absent severity reads as low rather than as empty",
      normalizeSeverity(undefined) === "low" && normalizeSeverity("") === "low");
    check("  and case is normalised, since GitHub is not consistent",
      normalizeSeverity("MODERATE") === "medium" && normalizeSeverity("High") === "high");

    // One implementation, so a path cannot lose it while another keeps it.
    check("  the translation exists once, not once per call site",
      (code.match(/=== "moderate" \? "medium"/g) || []).length === 0
        && /normalizeSeverity/.test(code),
      "two copies let a mutation break one while the test read the other");

    // A throw here fails the whole delivery: the worker releases its claim and
    // every other effect of that delivery runs again on retry.
    const prStart = src.indexOf('event === "pull_request"');
    const prBlock = src.slice(prStart, src.indexOf('event === "dependabot_alert"', prStart));
    check("  a notify failure cannot fail the delivery",
      /try \{/.test(prBlock) && /catch \(err\)/.test(prBlock),
      "SNS being briefly unavailable would duplicate every other effect of the delivery");
  }

  // ── the settings the routes accept ──────────────────────────────────
  {
    const routes = fs.readFileSync(path.join(__dirname, "src/routes/alarms.ts"), "utf8");

    // The same trap the security toggle has: enabling with no group stores a
    // feed that is on and silently sends nothing.
    check("enabling without a group is refused",
      /Choose an email group before turning this on/.test(routes));

    // Storing a floor on a feed with no severity shows a filter in the UI that
    // does nothing, which is worse than refusing it.
    check("  a severity floor on the Renovate feed is refused",
      /Renovate pull requests carry no severity/.test(routes),
      "a floor that filters nothing would read as one that does");

    // Registration order, not path shape, is what keeps /:id from swallowing
    // these — the same failure that made the security toggle 404.
    const feedsAt = routes.indexOf('router.get("/feeds/:feed"');
    const idAt = routes.indexOf('router.put("/:id"');
    check("  the feed routes are registered before /:id",
      feedsAt !== -1 && idAt !== -1 && feedsAt < idAt, { feedsAt, idAt });
  }

  // ── the stored shape ────────────────────────────────────────────────
  {
    const svc = fs.readFileSync(path.join(__dirname, "src/services/alarmService.ts"), "utf8");
    check("both feeds default to off",
      (svc.match(/enabled: false/g) || []).length >= 3,
      "a feed on by default emails whoever is in a group the moment one exists");
    check("  and the Renovate record cannot keep a severity",
      /if \(feed !== "dependabot-alert"\) delete updated\.minSeverity;/.test(svc));
  }

  // ── grouping, which exists because per-alert is a blast ─────────────
  {
    // Switching Dependabot on for one repository raises every alert it has at
    // once. One email each is what grouping was added to stop.
    const row = (repo: string, pkg: string, sev: string, at: string): PendingRow => ({
      id: `p-${repo}-${pkg}`, feed: "dependabot-alert", repo,
      item: { repo, package: pkg, severity: sev, url: `https://x/${pkg}`, advisory: "adv" },
      occurredAt: at,
    });

    const make = (pending: PendingRow[], over: Partial<{ enabled: boolean; grouping: string; groupId?: string }> = {}) => {
      const sent: { subject: string; body: string }[] = [];
      const marked: string[] = [];
      const deps = {
        listPending: async () => pending.filter(r => !marked.includes(r.id)),
        markSent: async (ids: string[]) => { marked.push(...ids); },
        settings: async () => ({
          enabled: over.enabled ?? true,
          grouping: over.grouping ?? "per-repository",
          groupId: "groupId" in over ? over.groupId : "g1",
          subjectTemplate: "{{repo}}: {{package}}",
          bodyTemplate: "{{url}} {{severity}}",
        }),
        topicArnFor: async () => "arn:aws:sns:::t",
        publish: async (_t: string, subject: string, body: string) => { sent.push({ subject, body }); return true; },
        timezone: async () => "UTC",
        org: "Acme-Org",
      };
      return { deps, sent, marked };
    };

    const many = [
      row("acme/api", "lodash", "critical", "2026-08-15T10:00:00Z"),
      row("acme/api", "minimist", "low", "2026-08-15T10:00:01Z"),
      row("acme/api", "axios", "high", "2026-08-15T10:00:02Z"),
      row("acme/web", "react", "medium", "2026-08-15T10:00:03Z"),
    ];

    const a = make(many);
    const res = await flushPending(a.deps as any);
    check("four alerts across two repositories send two emails, not four",
      a.sent.length === 2 && res.messages === 2, { sent: a.sent.length, res });
    check("  and every buffered row is marked, so none is sent twice",
      a.marked.length === 4, a.marked);

    const apiMail = a.sent.find(m => m.subject.includes("acme/api"))!;
    check("  the subject counts them rather than naming one",
      /\[3\]/.test(apiMail.subject) && /3 Dependabot alerts/.test(apiMail.subject), apiMail.subject);
    check("  the body lists all three",
      ["lodash", "minimist", "axios"].every(p => apiMail.body.includes(p)), apiMail.body);
    check("  worst severity first, so a critical is not buried",
      apiMail.body.indexOf("lodash") < apiMail.body.indexOf("axios")
        && apiMail.body.indexOf("axios") < apiMail.body.indexOf("minimist"),
      apiMail.body);

    // A single buffered event must read like a normal email, not a digest of one.
    const one = make([row("acme/api", "lodash", "critical", "2026-08-15T10:00:00Z")]);
    await flushPending(one.deps as any);
    check("a single event uses the template rather than a digest of one",
      one.sent[0].subject === "acme/api: lodash", one.sent[0].subject);

    // Nothing buffered must not publish an empty message.
    const none = make([]);
    const r2 = await flushPending(none.deps as any);
    check("an empty buffer sends nothing", none.sent.length === 0 && r2.messages === 0, r2);

    // Switched off, or back to per-alert, while events sat in the buffer.
    const off = make(many, { enabled: false });
    await flushPending(off.deps as any);
    check("a feed switched off while buffered sends nothing",
      off.sent.length === 0, off.sent.length);
    check("  but its rows are cleared, not left to be reconsidered forever",
      off.marked.length === 4, off.marked.length);

    const perAlert = make(many, { grouping: "per-alert" });
    await flushPending(perAlert.deps as any);
    check("  the same when switched back to per-alert", perAlert.sent.length === 0);

    // A failed publish must leave the rows pending so the next tick retries.
    const failing = {
      ...make(many).deps,
      publish: async () => false,
    };
    const markedOnFail: string[] = [];
    (failing as any).markSent = async (ids: string[]) => { markedOnFail.push(...ids); };
    const r3 = await flushPending(failing as any);
    check("a publish failure leaves the rows pending for the next tick",
      markedOnFail.length === 0 && r3.failures === 2 && r3.messages === 0,
      { marked: markedOnFail.length, r3 });

    // Two feeds for one repository are different subjects with different
    // templates; merging them would produce a message no template describes.
    const mixed: PendingRow[] = [
      row("acme/api", "lodash", "high", "2026-08-15T10:00:00Z"),
      { id: "pr1", feed: "renovate-pr", repo: "acme/api",
        item: { repo: "acme/api", title: "Bump lodash", url: "https://x/pr/1", number: "1" },
        occurredAt: "2026-08-15T10:00:01Z" },
    ];
    const m = make(mixed);
    await flushPending(m.deps as any);
    check("one repository with both feeds waiting gets one email per feed",
      m.sent.length === 2, m.sent.length);
  }

  // ── the digest itself ───────────────────────────────────────────────
  {
    const rendered = { subject: "one", body: "the single-item body" };
    const label = { singular: "alert", plural: "alerts" };

    check("a digest of one is left exactly as the template rendered it",
      buildDigest([{ item: { package: "a" }, occurredAt: "t" }], rendered, label, "r") === rendered);

    const d = buildDigest([
      { item: { package: "zzz-low-pkg", severity: "low", url: "u1" }, occurredAt: "t1" },
      { item: { package: "qqq-crit-pkg", severity: "critical", url: "u2" }, occurredAt: "t2" },
    ], rendered, label, "acme/api");
    check("  a digest of two names the repository and the count",
      d.subject.includes("acme/api") && d.subject.includes("2 alerts"), d.subject);
    check("  keeps the rendered single-item body below the list",
      d.body.includes("the single-item body"), d.body);
    check("  and still sorts critical above low",
      d.body.indexOf("qqq-crit-pkg") < d.body.indexOf("zzz-low-pkg"), d.body);
  }

  // ── what SNS will actually accept ──────────────────────────────────
  {
    // The digest builds its own subject instead of rendering a template, so it
    // bypassed the sanitiser every other subject goes through. SNS rejects a
    // subject over 99 characters outright, and a rejected publish leaves the
    // rows pending by design — so the effect is a digest retried every tick
    // forever and never delivered. Silent, and permanent.
    const label = { singular: "alert", plural: "alerts" };
    const rendered = { subject: "s", body: "b" };
    const items = Array.from({ length: 14 }, (_, i) => ({
      item: { package: `pkg-${i}`, severity: "high", url: "https://x" }, occurredAt: `t${i}`,
    }));

    // Long enough that the unsanitised subject is over the limit rather than
    // merely near it. The first version of this used a 79-character name and a
    // six-character label, which totalled 95 — under the cap, so it passed with
    // the sanitiser removed and proved nothing.
    const longRepo =
      "a-fairly-long-organization-name/an-unusually-long-repository-name-for-one-small-service";
    const rawLength = `[14] ${longRepo}: 14 ${label.plural}`.length;
    check("the fixture is actually over the limit before sanitising",
      rawLength > SUBJECT_MAX, { rawLength, max: SUBJECT_MAX });

    const d = buildDigest(items, rendered, label, longRepo);
    check("a long repository name cannot produce a subject SNS will refuse",
      d.subject.length <= SUBJECT_MAX,
      { length: d.subject.length, max: SUBJECT_MAX, subject: d.subject });
    check("  and the subject is still ASCII with no newlines",
      /^[\x20-\x7E]+$/.test(d.subject), d.subject);

    const weird = buildDigest(items, rendered, label, "org/repo\u2014name\nsecond line");
    check("  a repository name carrying newlines or non-ASCII is cleaned",
      /^[\x20-\x7E]+$/.test(weird.subject) && !weird.subject.includes("\n"),
      weird.subject);

    // A monorepo being switched on can raise hundreds at once. SNS refuses a
    // message over 256 KB, which is the same permanent failure by another route.
    const huge = Array.from({ length: 4000 }, (_, i) => ({
      item: {
        package: `some-fairly-long-package-name-${i}`,
        severity: "high",
        url: `https://github.com/org/repo/security/dependabot/${i}`,
      },
      occurredAt: `t${i}`,
    }));
    const big = buildDigest(huge, rendered, label, "org/repo");
    check("a very large digest stays inside the SNS message limit",
      Buffer.byteLength(big.body, "utf8") < 256_000,
      Buffer.byteLength(big.body, "utf8"));
    check("  and says how many it left out rather than silently dropping them",
      /and \d+ more/.test(big.body), big.body.slice(-200));
    check("  while still naming the true total at the top",
      big.body.startsWith("4000 alerts in org/repo"), big.body.slice(0, 40));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
