/**
 * A burst of events must not become a burst of emails.
 *
 * Three real shapes, which want three different groupings:
 *
 *   a team added to 100 repositories   one action, 100 webhooks, 100 emails
 *   an advisory across 100 repositories one CVE, 300 alerts, 100 emails
 *   Dependabot switched on for one repo one repository, 30 alerts, 1 email
 *
 * The first two were blasts. The third was already right. A fixed grouping key
 * can only fix one of them, which is why the axis is chosen per burst.
 *
 * Run:  npx tsx repro-grouping.ts   from github-control-hub/backend
 */
import { chooseAxis, groupBurst, nameAndCount, describeBurst, NAMED_LIMIT } from "./src/alarms/grouping";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const row = (repo: string, subject: string, actor?: string) => ({ repo, subject, actor });

(async () => {
  // ── one advisory, many repositories ─────────────────────────────────
  {
    const rows = Array.from({ length: 100 }, (_, i) => row(`repo-${i}`, "left-pad"));
    const { axis, groups } = groupBurst(rows);
    check("one advisory across a hundred repositories groups by the advisory",
      axis === "subject" && groups.length === 1, { axis, groups: groups.length });
    check("  which is one email rather than a hundred", groups.length === 1);
    check("  and its subject names the advisory and the scale",
      describeBurst(rows, axis, groups[0].key) === "left-pad across 100 repositories",
      describeBurst(rows, axis, groups[0].key));
  }

  // ── three advisories, a hundred repositories each ────────────────────
  {
    const rows = ["left-pad", "lodash", "axios"].flatMap(pkg =>
      Array.from({ length: 100 }, (_, i) => row(`repo-${i}`, pkg)));
    const { axis, groups } = groupBurst(rows);
    check("three advisories across the same hundred repositories is three emails",
      axis === "subject" && groups.length === 3,
      { axis, groups: groups.length, rows: rows.length });
    check("  not three hundred", groups.length === 3);
    check("  and each names its own advisory",
      groups.every(g => describeBurst(g.rows, axis, g.key).endsWith("across 100 repositories")));
  }

  // ── one repository, many advisories ──────────────────────────────────
  {
    const rows = Array.from({ length: 30 }, (_, i) => row("api-service", `cve-${i}`));
    const { axis, groups } = groupBurst(rows);
    check("thirty advisories on one repository groups by the repository",
      axis === "repo" && groups.length === 1,
      "grouping by advisory here would be thirty emails about one repository");
    check("  and says so",
      describeBurst(rows, axis, groups[0].key) === "30 findings on api-service",
      describeBurst(rows, axis, groups[0].key));
  }

  // ── one action, many repositories ────────────────────────────────────
  {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(`repo-${i}`, "Team platform added", "alice"));
    const { axis, groups } = groupBurst(rows);
    check("a team added to a hundred repositories is one email",
      axis === "subject" && groups.length === 1);
    check("  reading as the thing somebody did",
      describeBurst(rows, axis, groups[0].key) === "Team platform added across 100 repositories",
      describeBurst(rows, axis, groups[0].key));
  }

  // ── the ordinary single event ────────────────────────────────────────
  {
    const rows = [row("api-service", "left-pad")];
    const { axis, groups } = groupBurst(rows);
    check("a single event still produces one group", groups.length === 1);
    check("  described by what it was, not by where it was",
      describeBurst(rows, axis, groups[0].key) === "left-pad on api-service",
      "a tie goes to the subject: the repository is already in front of the reader");
  }

  // ── largest first ────────────────────────────────────────────────────
  {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`a-${i}`, "small")),
      ...Array.from({ length: 40 }, (_, i) => row(`b-${i}`, "large")),
    ];
    const { groups } = groupBurst(rows);
    check("the group that affected most is first",
      groups[0].key === "large" && groups[0].rows.length === 40,
      groups.map(g => `${g.key}:${g.rows.length}`));
  }

  // ── naming, and not naming everything ────────────────────────────────
  {
    const few = ["b", "a", "c"];
    check("a short list is named in full and sorted",
      nameAndCount(few) === "a, b, c", nameAndCount(few));

    const many = Array.from({ length: 100 }, (_, i) => `repo-${String(i).padStart(3, "0")}`);
    const out = nameAndCount(many);
    check("  a long one names some and counts the rest",
      out.endsWith(`and ${100 - NAMED_LIMIT} more`), out.slice(-30));
    check("  naming exactly the limit, no more",
      out.split(", ").length === NAMED_LIMIT,
      "a digest listing a hundred names is a wall, and SNS has a size limit besides");

    check("  duplicates are collapsed before counting",
      nameAndCount(["a", "a", "b"]) === "a, b",
      "the same repository twice is one repository");
  }

  // ── critical still goes out at once ─────────────────────────────────
  //
  // Grouping is for volume, not for urgency. A repository going public should
  // not wait for a flush window because forty routine alerts arrived with it.
  {
    const fs = await import("node:fs");
    const notify = fs.readFileSync(`${__dirname}/src/alarms/securityNotify.ts`, "utf8");
    const alerts = fs.readFileSync(`${__dirname}/src/services/alertService.ts`, "utf8");
    const { sendsImmediately } = await import("./src/alarms/securityNotify");

    check("critical publishes immediately", sendsImmediately("critical"));
    check("  whatever its casing", sendsImmediately("CRITICAL"));
    check("  and everything below it is grouped",
      !sendsImmediately("high") && !sendsImmediately("medium") && !sendsImmediately("low"));
    check("  an unrecognised severity is grouped rather than blasted",
      !sendsImmediately("") && !sendsImmediately("unknown"),
      "an unknown severity is not evidence of urgency");

    check("the buffered path is taken only below critical",
      /if \(!sendsImmediately\(alert\.severity\) && deps\.buffer\)/.test(notify));
    check("  and the severity floor is applied before either",
      notify.indexOf("meetsMinimumSeverity") < notify.indexOf("sendsImmediately(alert.severity)"),
      "buffering something the floor would have dropped is work for a message nobody asked for");
    check("  alertService actually supplies the buffer",
      /buffer: async \(row\) =>/.test(alerts) && /bufferNotification\("security"/.test(alerts),
      "without it every alert falls through to the immediate path");
  }

  // ── a customised email survives being grouped ───────────────────────
  //
  // The subject used to be overwritten outright on any group of two or more, so
  // anybody who had set one to carry a ticket prefix or a mail-filter keyword
  // lost it exactly when the email mattered most. And `{repo}` was rendered
  // from whichever row happened to be first, which on a digest spanning a
  // hundred repositories is arbitrary and reads as a fact.
  {
    const fs = await import("node:fs");
    const feed = fs.readFileSync(`${__dirname}/src/alarms/feedNotify.ts`, "utf8");
    const msg = fs.readFileSync(`${__dirname}/src/alarms/message.ts`, "utf8");
    const { buildDigest } = await import("./src/alarms/feedNotify");

    check("the customised subject is used, not discarded",
      /rendered\.subject \? `\[\$\{n\}\] \$\{rendered\.subject\}`/.test(feed),
      "losing it on a group is losing it when it counts");
    check("  with the count in front, so a digest does not read as one event",
      /`\[\$\{n\}\]/.test(feed));

    check("a multi-repository group does not claim one repository",
      /repos\.length === 1 \? repos\[0\] : `\$\{repos\.length\} repositories`/.test(feed),
      "rendering the first row's repo is arbitrary and reads as a fact");
    check("  and group-level variables are offered",
      ["count", "repos", "what"].every(v => new RegExp(`name: "${v}"`).test(msg)),
      "a template can only describe a group if it has the group's values");

    // The single-event path is untouched: one alert still renders exactly as
    // the template says, with no count prefix and no digest scaffolding.
    const rendered = { subject: "custom subject", body: "custom body" };
    const one = buildDigest([{ item: { package: "a" }, occurredAt: "t" }],
      rendered, { singular: "alert", plural: "alerts" }, "a on r");
    check("one event is still exactly what the template rendered",
      one === rendered, one);
  }

  // ── the shipped defaults read correctly in both shapes ──────────────
  //
  // The defaults were written when every email covered one alert. They now
  // render a digest of two hundred as well, and a default that reads as a lie
  // on the common path is worse than no default.
  {
    const m = await import("./src/alarms/message");
    const { worstSeverity } = await import("./src/alarms/grouping");

    for (const [name, subject] of [
      ["dependabot", m.DEFAULT_DEPENDABOT_SUBJECT],
      ["security", m.DEFAULT_SECURITY_SUBJECT],
    ] as const) {
      check(`the ${name} subject does not open with a bracket`,
        !subject.trimStart().startsWith("["),
        "a digest prefixes its own [12], and [12] [critical] stops being scannable");
    }

    // The single path keeps its link; the digest path has no gap where the
    // link was, because the line goes rather than blanking.
    const withUrl = m.render(m.DEFAULT_DEPENDABOT_BODY,
      { url: "https://example.test/1", advisory: "x", package: "p", repo: "r", severity: "high", org: "o", time: "t" });
    const noUrl = m.render(m.DEFAULT_DEPENDABOT_BODY,
      { package: "3 packages", repo: "r", severity: "high", org: "o", time: "t" });
    check("a single alert still leads with the link",
      withUrl.startsWith("https://example.test/1"), withUrl.slice(0, 30));
    check("  and a digest drops the line rather than leaving a gap",
      !noUrl.startsWith("\n") && !/\n\n\n/.test(noUrl), JSON.stringify(noUrl.slice(0, 24)));
    check("  while a label somebody wrote is never dropped",
      noUrl.includes("Package: 3 packages"),
      "only a line that was nothing but empty variables goes");

    // Deliberately blank lines are the author's, not the renderer's to remove.
    check("a blank line in a template stays a blank line",
      m.render("a\n\nb", {}) === "a\n\nb", JSON.stringify(m.render("a\n\nb", {})));

    check("the worst severity wins, never the first",
      worstSeverity(["low", "critical", "medium"]) === "critical");
    check("  because rounding a critical down to a low is the one unsafe direction",
      worstSeverity(["low", "low"]) === "low" && worstSeverity([undefined, undefined]) === undefined);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
