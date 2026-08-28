/**
 * Regression test: security changes that arrive without a webhook.
 *
 * Every security alert in this app is created by the webhook worker, and
 * nothing re-derives them. So a delivery lost past GitHub's retry window is an
 * event that silently never becomes an alert, and the Security tab is a record
 * of what the app was *told* rather than of what happened.
 *
 * The nightly rebuild is the only thing able to notice, because it re-reads
 * every repository and already loads the whole stored graph to work out what to
 * delete. The risk in adding it is the opposite failure: alerting on ordinary
 * churn, or on a first run, and burying the real ones. Most of what is below is
 * about not doing that.
 */
import * as fs from "node:fs";
import { findDrift, alreadyKnown, MAX_BELIEVABLE_DRIFT, type EdgeLike } from "./src/jobs/reconcileDrift";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const meta = (repo: string, visibility: string): EdgeLike =>
  ({ pk: `REPO#${repo}`, sk: "META#repo", type: "repo_meta", metadata: { visibility } });
const branch = (repo: string, name: string, prot: boolean): EdgeLike =>
  ({ pk: `REPO#${repo}`, sk: `BRANCH#${name}`, type: "has_branch", metadata: { protected: prot, default: name === "main" } });

(async () => {

  // ── the thing it exists to catch ────────────────────────────────────
  {
    console.log("\na change nobody was told about");

    const d = findDrift([meta("acme/api", "private")], [meta("acme/api", "public")]);
    check("a repository that went public between two walks is found",
      d.length === 1 && d[0].type === "repo_made_public" && d[0].repo === "acme/api", d);
    check("  and it says why it is being reported now",
      /No webhook reported the change/.test(d[0]?.message ?? ""), d[0]?.message);
    check("  at critical, like the webhook path",
      d[0]?.severity === "critical");

    const p = findDrift([branch("acme/api", "main", true)], [branch("acme/api", "main", false)]);
    check("a branch that lost its protection is found",
      p.length === 1 && p[0].type === "protection_removed", p);
    check("  naming the branch, so a later reversal can match it",
      p[0]?.subject === "main", p[0]?.subject);
  }

  // ── everything it must stay quiet about ─────────────────────────────
  {
    console.log("\nand the far larger set of things that are not drift");

    check("a repository seen for the first time is not drift",
      findDrift([], [meta("acme/new", "public")]).length === 0,
      "a new public repository is a repository, not a change");
    check("  which is what stops a first run alerting on the whole org",
      findDrift([], [meta("a", "public"), meta("b", "public"), meta("c", "public")]).length === 0);

    check("public and still public is not drift",
      findDrift([meta("acme/api", "public")], [meta("acme/api", "public")]).length === 0);
    check("a repository going private is not drift",
      findDrift([meta("acme/api", "public")], [meta("acme/api", "private")]).length === 0,
      "that is the reversal, and it is good news");
    check("internal is not public",
      findDrift([meta("acme/api", "internal")], [meta("acme/api", "internal")]).length === 0);

    check("protection appearing is not drift",
      findDrift([branch("acme/api", "main", false)], [branch("acme/api", "main", true)]).length === 0);
    check("an unprotected branch staying unprotected is not drift",
      findDrift([branch("acme/api", "dev", false)], [branch("acme/api", "dev", false)]).length === 0);

    // Deleting a protected branch is an ordinary thing to do, and the
    // protection going with it is not a security change: there is no longer a
    // branch to protect.
    check("a deleted branch is not a protection removal",
      findDrift([branch("acme/api", "old", true)], []).length === 0,
      "every deleted release branch would raise a critical otherwise");

    // The graph churns constantly for reasons that have nothing to do with
    // security. Only two edge types are compared at all.
    const noise: EdgeLike[] = [
      { pk: "REPO#acme/api", sk: "USER#alice", type: "collaborator", metadata: { level: "admin" } },
      { pk: "TEAM#core", sk: "REPO#acme/api", type: "team_repo", metadata: { level: "write" } },
    ];
    check("nothing else in the graph is compared",
      findDrift(noise, []).length === 0 && findDrift([], noise).length === 0,
      "collaborator and team churn is ordinary and would bury the real ones");
  }

  // ── the branch key ──────────────────────────────────────────────────
  {
    console.log("\none branch at a time");

    // Keying on the repository alone is the bug that made a reversal on `main`
    // mark every branch in the repository as restored.
    const before = [branch("acme/api", "main", true), branch("acme/api", "dev", true)];
    const after = [branch("acme/api", "main", true), branch("acme/api", "dev", false)];
    const d = findDrift(before, after);
    check("losing protection on one branch reports that branch only",
      d.length === 1 && d[0].subject === "dev", d.map(x => x.subject));

    check("  and the same branch name in another repository is separate",
      findDrift(
        [branch("a/one", "main", true), branch("b/two", "main", true)],
        [branch("a/one", "main", false), branch("b/two", "main", true)],
      ).map(x => x.repo).join() === "a/one");
  }

  // ── not saying the same thing twice ─────────────────────────────────
  {
    console.log("\nwhat the webhook already told us");

    const drift = { repo: "acme/api", type: "repo_made_public" as const, message: "", severity: "critical" as const };

    check("a webhook alert already on the record silences the drift check",
      alreadyKnown(drift, [{ repo: "acme/api", type: "repo_made_public" }]),
      "on a healthy install every change arrives as a webhook, so this writes nothing");

    // A repository that went public, was made private, and went public again is
    // a second event. The first alert now says the opposite of what is true.
    check("  but a reverted one does not",
      !alreadyKnown(drift, [{ repo: "acme/api", type: "repo_made_public", resolved: true }]));
    check("  nor does one about another repository",
      !alreadyKnown(drift, [{ repo: "other/repo", type: "repo_made_public" }]));
    check("  nor one of another kind",
      !alreadyKnown(drift, [{ repo: "acme/api", type: "protection_removed" }]));

    const branchDrift = { ...drift, type: "protection_removed" as const, subject: "dev" };
    check("a protection alert for a different branch does not silence this one",
      !alreadyKnown(branchDrift, [{ repo: "acme/api", type: "protection_removed", subject: "main" }]));
    check("  but one for the same branch does",
      alreadyKnown(branchDrift, [{ repo: "acme/api", type: "protection_removed", subject: "dev" }]));
    check("  and an old row with no subject counts as a match",
      alreadyKnown(branchDrift, [{ repo: "acme/api", type: "protection_removed" }]),
      "it could be about any branch, and a duplicate critical is worse than a quiet one here");
  }

  // ── the ceiling ─────────────────────────────────────────────────────
  {
    console.log("\nwhen the answer is too big to believe");

    const many = Array.from({ length: MAX_BELIEVABLE_DRIFT + 1 }, (_, i) => meta(`repo-${i}`, "private"));
    const now = many.map(e => ({ ...e, metadata: { visibility: "public" } }));
    check("more drift than is believable is still computed",
      findDrift(many, now).length > MAX_BELIEVABLE_DRIFT);

    const agg = fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8");
    check("  but the caller raises none of it",
      /if \(drifts\.length > MAX_BELIEVABLE_DRIFT\) \{[\s\S]{0,400}?return;/.test(agg),
      "a restored backup would otherwise raise a critical per repository");
    check("  and says so loudly rather than silently",
      /is more than is believable/.test(agg));
  }

  // ── how it is wired in ──────────────────────────────────────────────
  {
    console.log("\nwired so it cannot break the rebuild");

    const agg = fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8");
    const svc = fs.readFileSync(`${__dirname}/src/services/alertService.ts`, "utf8");

    check("the previous state is kept whole for this",
      /let previous: GraphEdge\[\] = \[\];/.test(agg) && /previous = oldItems;/.test(agg),
      "only fingerprints were kept, and a fingerprint cannot be compared field by field");
    check("  and it runs against both sides of the same walk",
      /raiseDriftAlerts\(previous, \[\.\.\.wanted\.values\(\)\]\)/.test(agg));
    check("  failing quietly, because the graph is what this job is for",
      /catch \(err: any\) \{[\s\S]{0,160}?Drift check failed/.test(agg),
      "a failure to notice drift must not become a failure to rebuild");

    // The timestamp is when it was noticed and the actor is unknown. Both are
    // the kind of unknown that reads as a fact if it is not labelled.
    check("an alert found this way says so",
      /source: "reconciliation"/.test(agg) && /source\?: "reconciliation"/.test(svc));
    check("  and invents neither an actor nor a time it happened",
      !/raiseDriftAlerts[\s\S]{0,1200}?actor:/.test(agg)
        && !/raiseDriftAlerts[\s\S]{0,1200}?occurredAt:/.test(agg),
      "all that is known is that it happened between two walks");
  }

  // ── the page is read, not the table ─────────────────────────────────
  //
  // `GET /alerts` returned every row on every poll, and the client polled it
  // every ten seconds with the comment "for demo" beside it. Fine at seventeen
  // rows; megabytes at ten thousand.
  {
    console.log("\nreading a window instead of the whole table");

    const svc = fs.readFileSync(`${__dirname}/src/services/alertService.ts`, "utf8");
    const route = fs.readFileSync(`${__dirname}/src/routes/alerts.ts`, "utf8");
    const setup = fs.readFileSync(`${__dirname}/../../scripts/setup-aws-account.sh`, "utf8");

    // A Scan returns items in hash order, so a Scan with a Limit hands back an
    // arbitrary subset. Presenting those as "the newest" would be untrue, which
    // is why this needs an index and not a smaller scan.
    check("the page is a query on a time index, not a scan",
      /IndexName: ALERT_FEED_INDEX/.test(svc) && /ScanIndexForward: false/.test(svc),
      "a scan with a Limit returns an arbitrary subset, not the newest ones");
    check("  and the index exists in the account setup",
      /IndexName=feed-index,KeySchema=\[\{AttributeName=feed,KeyType=HASH\},\{AttributeName=timestamp,KeyType=RANGE\}\]/.test(setup));

    // Asking for one more than wanted answers "is there another page" from the
    // same read, rather than a second one that could disagree with it.
    check("one extra row is read to know whether there is more",
      /Limit: limit \+ 1/.test(svc) && /const more = items\.length > limit/.test(svc));
    check("  and the extra row is not handed to the caller",
      /more \? items\.slice\(0, limit\) : items/.test(svc));

    // DynamoDB's own LastEvaluatedKey points past the extra row, so using it
    // would skip that row on the next page.
    check("the cursor is built from the last row returned",
      /cursor: more \? encode\(\{[\s\S]{0,200}?alerts\[alerts\.length - 1\]/.test(svc),
      "LastEvaluatedKey points past the extra row and would skip it");

    // A cursor from an older deploy is worse to throw an error page over than
    // to start from the top.
    check("an unreadable cursor starts from the top rather than failing",
      /catch \{[\s\S]{0,200}?return undefined;/.test(svc));

    check("the default window is the one the charts draw",
      /DEFAULT_WINDOW_WEEKS/.test(route) && /const weeks = DEFAULT_WINDOW_WEEKS;/.test(route));
    check("  and the response says whether it fitted",
      /complete/.test(svc) && /res\.json\(\{ \.\.\.page, since, windowWeeks: weeks \}\)/.test(route));

    // The nightly drift check has to know everything already on the record
    // before it raises anything, so it keeps the scanning read.
    check("the drift check still reads every alert",
      /export async function getAlerts\(\): Promise<SecurityAlert\[\]>/.test(svc)
        && /getAlerts\(\);/.test(fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8")),
      "a paged read would let it raise a duplicate of something it could not see");

    // Rows written before the index are invisible to it, which is a real gap
    // and needs a real script rather than a comment.
    check("a backfill exists for rows written before the index",
      fs.existsSync(`${__dirname}/../scripts/backfill-alert-feed.sh`));
    check("  writing only where the attribute is absent",
      /attribute_not_exists\(feed\)/.test(
        fs.readFileSync(`${__dirname}/../scripts/backfill-alert-feed.sh`, "utf8")));
  }

  // ── a fresh account gets all of this without being told ────────────
  //
  // Everything above is worthless on a new install if the setup script does not
  // provision it. Two of these have already been broken once by an edit
  // elsewhere in the same file.
  {
    console.log("\nsetting up a new account from nothing");

    const setup = fs.readFileSync(`${__dirname}/../../scripts/setup-aws-account.sh`, "utf8");

    check("the alerts table is created with its index",
      /create_table "\$\{PREFIX\}-alerts"[\s\S]{0,400}?IndexName=feed-index/.test(setup));

    // `alerts` left the TABLES array to get its own create_table call, and
    // quietly left the wait loop with it. The TTL step then ran against a table
    // still CREATING, could not read it, and skipped it: no expiry on the one
    // table expiry was added for.
    // Identified by what the loop *does*, not by what precedes it. Anchoring on
    // the echo above broke the moment a comment was written between them, and
    // anchoring on "the first loop mentioning TABLES" matched the create loop,
    // which says nothing about waiting.
    const wait = setup.match(/for t in ([^\n]*); do\n\s*\$AWS dynamodb wait table-exists/)?.[1] ?? "";
    check("  and is waited for before anything modifies it",
      /\balerts\b/.test(wait), wait);
    check("  which happens before expiry is enabled",
      setup.indexOf("Waiting for tables to become ACTIVE") < setup.indexOf("enable_ttl \"${PREFIX}-${t}\""),
      "update-time-to-live against a CREATING table fails");

    check("expiry is enabled on the alerts table",
      /for t in activity alerts alarms auth-codes; do[\s\S]{0,80}?enable_ttl/.test(setup));
    check("  and a skipped one is a warning, not a line to scroll past",
      /WARNING: could not read TTL/.test(setup),
      "silently not enabling expiry is how the table grew without bound before");

    // An account provisioned before the index existed skips create_table
    // entirely, and the tab reads *through* the index: without it the Security
    // tab shows nothing at all.
    check("an existing alerts table has the index added to it",
      /Checking alerts table index/.test(setup)
        && /global-secondary-index-updates[\s\S]{0,200}?feed-index/.test(setup));
    check("  waiting for it to go ACTIVE before moving on",
      /idx_status" = "ACTIVE" \] && break/.test(setup));
    // A bare `until ACTIVE` prints nothing, so a normal five-minute wait looks
    // identical to a creation that failed, and a failed one waits forever.
    check("    saying how long it has been, rather than looking frozen",
      /elapsed/.test(setup));
    check("    and giving up rather than waiting forever",
      /Gave up after 20 minutes/.test(setup));
    check("  and rows left outside the index are reported, not silently rewritten",
      /attribute_not_exists\(feed\)" --select COUNT/.test(setup)
        && /backfill-alert-feed\.sh --apply/.test(setup),
      "adding an index is a schema change; rewriting every row is the caller's call");
  }

  // ── a missing index says what to do about it ────────────────────────
  //
  // The tables are not created by CDK: the stack builds exactly one, and the
  // alerts table is not it. So somebody who deploys and finds the tab broken
  // will reach for another deploy, which cannot help. The message has to say
  // that, because nothing else will.
  {
    console.log("\nwhen the index is not there yet");

    const { sanitizeError } = await import("./src/utils/errorSanitizer");
    const err: any = new Error("The table does not have the specified index: feed-index");
    err.name = "ValidationException";
    const said = sanitizeError(err, "alerts");

    check("the message names the script that fixes it",
      /setup-aws-account\.sh/.test(said), said);
    check("  and says a deploy will not",
      /CDK stack will not/.test(said), said);
    check("  rather than falling through to \"an unexpected error\"",
      !/unexpected/i.test(said), said);

    // Not every ValidationException is a missing index.
    const other: any = new Error("One or more parameter values were invalid");
    other.name = "ValidationException";
    check("an unrelated validation error is untouched",
      !/setup-aws-account/.test(sanitizeError(other, "alerts")));

    // And the claim the message makes has to stay true.
    const stack = fs.readFileSync(`${__dirname}/../infra/cdk-stack.ts`, "utf8");
    check("the stack really does not create the alerts table",
      (stack.match(/new dynamodb\.Table\(/g) ?? []).length === 1
        && !/new dynamodb\.Table\([^)]*Alerts/.test(stack),
      "if CDK ever owns this table the message becomes wrong advice");
  }

  // ── security alerts are not issues ──────────────────────────────────
  {
    console.log("\na security alert is logged as one");

    const svc = fs.readFileSync(`${__dirname}/src/services/alertService.ts`, "utf8");
    const script = fs.readFileSync(
      `${__dirname}/../scripts/backfill-security-alert-action.sh`, "utf8");

    // It was `"github.issue_opened" as any`, and the cast is the tell: nothing
    // in createAlert opens an issue. The feed showed every security alert under
    // a green "Issue Opened" chip, which is the one row somebody scanning for a
    // security alert would skip past.
    check("the activity row carries its own action",
      /logActivity\(\s*\n\s*"security\.alert",/.test(svc));
    // Comments stripped first: the note above that call quotes the old cast to
    // explain it, and a guard that reads its own explanation as the bug is a
    // guard that can only be satisfied by deleting the explanation.
    const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("  and no cast is left behind",
      !/issue_opened/.test(code));

    // Rows written before that was fixed still say issue.
    check("a backfill exists for rows written before the fix",
      /security\.alert/.test(script) && /github\.issue_opened/.test(script));
    check("  matched on being a security alert, not just on the old action",
      /"#t":"target"/.test(script) && /security_alert/.test(script)
        && /startswith\("Security Alert \["\)/.test(script),
      "a genuine issue row arriving later must not be caught by a re-run");
    check("  and each write is conditional, so a second run is a no-op",
      /--condition-expression "#a = :old"/.test(script));
    check("  changing the action and nothing else",
      /--update-expression "SET #a = :new"/.test(script));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
