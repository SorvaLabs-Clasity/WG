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
  notifyRenovatePr, notifyDependabotAlert, isConfiguredBot,
  type FeedNotifyDeps,
} from "./src/alarms/feedNotify";

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
    check("  GitHub's \"moderate\" is translated at the boundary",
      /severity === "moderate"\s*\?\s*"medium"/.test(code),
      "a moderate alert would rank below low and never clear any floor");

    // A throw here fails the whole delivery: the worker releases its claim and
    // every other effect of that delivery runs again on retry.
    const prBlock = src.slice(src.indexOf('event === "pull_request"'));
    check("  a notify failure cannot fail the delivery",
      /try \{/.test(prBlock.slice(0, 200)) && /catch \(err\)/.test(prBlock.slice(0, 2600)),
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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
