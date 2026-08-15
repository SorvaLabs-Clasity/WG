/**
 * Enterprise audit log ingestion.
 *
 * GitHub streams the audit log to S3 as gzipped newline-delimited JSON. This
 * covers the parsing and filtering, which is where the quiet failures live:
 *
 *   - one malformed line must not discard the rest of the file. A partial
 *     batch is worth more than none, and dropping the object loses events with
 *     nothing to show for it.
 *   - created_at arrives as epoch milliseconds, sometimes seconds, sometimes a
 *     string. A misread timestamp sorts to the wrong end of the feed and
 *     expires on the wrong schedule.
 *   - the allow-list decides what is kept forever and what is only ever in S3.
 *     Getting it wrong silently drops the events an auditor came for.
 */
import fs from "fs";
import path from "path";
import { isConsequential, normalize, parseNdjson, toTimestamp, describe, allowList, actorOf, SYSTEM_ACTOR } from "./src/audit/events";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

// ── the filter keeps what an auditor asks about ───────────────────────
{
  const keep = [
    "org.add_member", "org.remove_member", "org.update_member",
    "team.add_repository", "team.remove_member",
    "repo.access", "repo.destroy", "repo.transfer", "repo.create",
    "protected_branch.destroy", "protected_branch.update_require_signed_commits",
    "repository_ruleset.destroy",
    "personal_access_token.access_granted",
    "org.oauth_app_access_approved",
    "secret_scanning_alert.create",
    "hook.destroy",
    "integration_installation.repositories_added",
    "org.disable_two_factor_requirement",
  ];
  const missed = keep.filter(a => !isConsequential(a));
  check(`all ${keep.length} consequential events are kept`, missed.length === 0, missed);
}

// ── and drops the volume ──────────────────────────────────────────────
{
  const drop = ["git.clone", "git.fetch", "git.push", "repo.download_zip",
                "org.runner_group_updated", "workflows.completed_workflow_run"];
  const kept = drop.filter(a => isConsequential(a));
  check("high-volume noise is not indexed", kept.length === 0, kept);
  check("  and an empty action is not indexed", !isConsequential(""));
}

// ── prefixes must not over-match ──────────────────────────────────────
{
  // "repo.create" is an exact entry; "repo.download_zip" must not ride in on it.
  check("an exact entry does not behave as a prefix",
    isConsequential("repo.create") && !isConsequential("repo.create_something_else"),
    [isConsequential("repo.create"), isConsequential("repo.create_something_else")]);
  check("a prefix entry does match its children",
    isConsequential("protected_branch.anything_at_all"));
}

// ── the allow-list is configurable, but not accidentally empty ────────
{
  const original = process.env.AUDIT_EVENT_ALLOWLIST;
  process.env.AUDIT_EVENT_ALLOWLIST = "custom.thing,other.";
  check("an override replaces the defaults",
    isConsequential("custom.thing", allowList()) && !isConsequential("org.add_member", allowList()),
    allowList());
  process.env.AUDIT_EVENT_ALLOWLIST = "   ";
  check("  but whitespace falls back rather than indexing nothing",
    isConsequential("org.add_member", allowList()), allowList().length);
  if (original === undefined) delete process.env.AUDIT_EVENT_ALLOWLIST;
  else process.env.AUDIT_EVENT_ALLOWLIST = original;
}

// ── one bad line does not lose the file ───────────────────────────────
{
  const body = [
    '{"action":"org.add_member","actor":"alice","created_at":1786680000000}',
    '{"action":"git.clone","actor":"ci"',                       // truncated
    'not json at all',
    '',
    '{"action":"repo.access","actor":"bob","created_at":1786680001000,"repo":"api"}',
  ].join("\n");
  const { events, skipped } = parseNdjson(body);
  check("valid lines survive a malformed neighbour", events.length === 2, events.length);
  check("  and the bad ones are counted, not hidden", skipped === 2, skipped);
  check("  blank lines are not counted as failures", skipped === 2, skipped);

  const empty = parseNdjson("");
  check("an empty object yields nothing and no error",
    empty.events.length === 0 && empty.skipped === 0, empty);
}

// ── timestamps ────────────────────────────────────────────────────────
{
  check("epoch milliseconds are read correctly",
    toTimestamp(1786680000000).startsWith("2026-"), toTimestamp(1786680000000));
  check("  epoch seconds are recognized and not read as 1970",
    toTimestamp(1786680000).startsWith("2026-"), toTimestamp(1786680000));
  check("  an ISO string is accepted",
    toTimestamp("2026-08-14T04:00:00Z") === "2026-08-14T04:00:00.000Z", toTimestamp("2026-08-14T04:00:00Z"));

  // A row with no readable timestamp must not sort to 1970 and expire at once.
  const fallback = toTimestamp(undefined);
  check("an unreadable timestamp falls back to now, not to the epoch",
    new Date(fallback).getUTCFullYear() >= 2026, fallback);
  check("  including outright nonsense", new Date(toTimestamp("banana")).getUTCFullYear() >= 2026,
    toTimestamp("banana"));
}

// ── normalizing into an activity row ──────────────────────────────────
{
  const n = normalize({ action: "protected_branch.destroy", actor: "alice", created_at: 1786680000000, repo: "Org/api" });
  check("the audit action lands in target, which is what tells rows apart",
    n.target === "protected_branch.destroy", n.target);
  check("  the actor is carried through", n.actor === "alice", n.actor);
  check("  and the repository", n.repo === "Org/api", n.repo);

  const orgScoped = normalize({ action: "org.add_member", actor: "bob", created_at: 1786680000000 });
  check("an organization-scoped event has an empty repo, not the word undefined",
    orgScoped.repo === "", orgScoped.repo);

  // GitHub raises some events itself — repository_vulnerability_alert.create
  // has no actor field at all, because no person did it. Recording that as
  // "unknown" claims the actor could not be identified, which is a different
  // and more alarming statement than "there was none", and it drove the UI to
  // look up github.com/unknown.png — a real account, whose owner's photograph
  // then appeared beside changes they had nothing to do with.
  const anon = normalize({ action: "repo.create", created_at: 1786680000000 });
  check("an event with no actor is attributed to the system, not to nobody",
    anon.actor === SYSTEM_ACTOR, anon.actor);
  check("  and never to the literal string \"unknown\"",
    anon.actor !== "unknown",
    "github.com/unknown.png resolves to a real person's avatar");
  check("  an empty actor is treated the same as a missing one",
    actorOf({ action: "x", actor: "" }) === SYSTEM_ACTOR
      && actorOf({ action: "x", actor: "   " }) === SYSTEM_ACTOR,
    actorOf({ action: "x", actor: "" }));
  check("  while a real actor is passed through untouched",
    actorOf({ action: "x", actor: "alice" }) === "alice");

  check("the summary names who did what",
    describe({ action: "repo.access", actor: "carol", repo: "api" }).includes("carol")
      && describe({ action: "repo.access", actor: "carol", repo: "api" }).includes("repo.access"),
    describe({ action: "repo.access", actor: "carol", repo: "api" }));
}

// ── the shape GitHub actually sends, with invented values ─────────────
{
  // The field set here is modelled on an object GitHub delivered when a
  // repository was deleted, because every fixture invented from the
  // documentation passed while the real shape exposed two gaps: the repository
  // is not in `repo` at all, and the application's name was being dropped, so
  // two events describing different apps read identically.
  //
  // The shape is what found those. The values are made up and must stay made
  // up: a payload pasted from a live stream carries usernames, ids and an
  // organization with it, none of which belong in a repository.
  const real = {
    "@timestamp": 1786693698311,
    action: "integration_installation.repositories_removed",
    actor: "alice",
    actor_id: 1000001,
    application_client_id: "Iv1.0000000000000000",
    business: "acme-ent",
    created_at: 1786693698311,
    integration: "Acme Deploy Pipeline",
    name: "Acme Deploy Pipeline",
    operation_type: "remove",
    org: "Acme-Org",
    repositories_removed: [2000002],
    repositories_removed_names: ["Acme-Org/testing"],
    repository_selection: "all",
    topic: "github.repositories.v1.Deleted",
  };

  check("an integration event is indexed", isConsequential(String(real.action)));

  const n = normalize(real);
  check("the repository is found outside the `repo` field",
    n.repo === "Acme-Org/testing", n.repo);
  check("  and the application is named, so two apps do not read alike",
    n.details.includes("Acme Deploy Pipeline"), n.details);
  check("  with the actor and action intact",
    n.details.includes("alice") && n.details.includes("integration_installation.repositories_removed"),
    n.details);
  check("  and the timestamp read from epoch milliseconds",
    n.timestamp.startsWith("2026-08-14T07:48"), n.timestamp);

  // The same deletion produced a second event for the other installed app.
  const other = { ...real, integration: "Acme Control Hub", name: "Acme Control Hub" };
  check("two apps on one deletion produce distinguishable rows",
    normalize(other).details !== n.details,
    [n.details, normalize(other).details]);
}

// ── member and team payloads, in the shape GitHub sends them ──────────
{
  // Field sets taken from real events, values invented. Reading only the first
  // of repo/team/user dropped the person whenever a repository or team was
  // present, which is most member events — a line saying somebody was added to
  // a repository without saying who.
  const cases: Array<[string, any, string[]]> = [
    ["repo.add_member names the person and the permission",
      { action: "repo.add_member", actor: "alice", org: "Acme-Org",
        repo: "Acme-Org/payments-api", user: "bob",
        permission: "maintain", visibility: "private" },
      ["Acme-Org/payments-api", "bob", "maintain"]],

    ["team.add_member names the team and the person",
      { action: "team.add_member", actor: "alice", org: "Acme-Org",
        team: "Acme-Org/aws-guardrail-admins", user: "bob" },
      ["aws-guardrail-admins", "bob"]],

    ["org.invite_member names the invitee, who has no username yet",
      { action: "org.invite_member", actor: "alice", org: "Acme-Org",
        email: "newhire@example.com", invitee_email: "newhire@example.com" },
      ["newhire@example.com"]],

    ["repo.update_member shows both sides of the permission change",
      { action: "repo.update_member", actor: "alice", org: "Acme-Org",
        repo: "Acme-Org/billing-service", user: "bob",
        old_repo_permission: "admin", new_repo_permission: "maintain", visibility: "private" },
      ["bob", "admin → maintain"]],

    ["org.add_member names the person and the role",
      { action: "org.add_member", actor: "alice", org: "Acme-Org",
        user: "bob", permission: "read" },
      ["bob", "read"]],
  ];

  for (const [name, event, expected] of cases) {
    const d = describe(event);
    const missing = expected.filter(x => !d.includes(x));
    check(name, missing.length === 0, { line: d, missing });
  }

  // team.create carries user === actor. Repeating the actor reads as an error.
  const selfActed = describe({ action: "team.create", actor: "alice", org: "Acme-Org",
    team: "Acme-Org/aws-guardrail-admins", user: "alice" });
  check("an actor acting on themselves is not named twice",
    (selfActed.match(/alice/g) || []).length === 1, selfActed);
}

// ── an arrow must mean "changed to" ───────────────────────────────────
{
  // repo.destroy carries `visibility` as context — what the repository was
  // when it went. Rendered with an arrow it read "repo.destroy … → private",
  // as though deleting it had made it private.
  const destroyed = describe({ action: "repo.destroy", actor: "alice", repo: "Org/testing", visibility: "private" });
  check("a non-change does not get an arrow", !destroyed.includes("→"), destroyed);
  check("  but the visibility is still shown as context", destroyed.includes("[private]"), destroyed);

  const changed = describe({ action: "repo.access", actor: "alice", repo: "Org/testing", visibility: "public" });
  check("an actual visibility change does get one", changed.includes("→ public"), changed);
}

// ── GitHub's endpoint probe is not a batch ────────────────────────────
{
  // Found the moment streaming was switched on for real: GitHub writes a
  // plain-text object called `_check` on every connection verification, and
  // repeatedly while streaming stays enabled. Parsing it as NDJSON yields one
  // unparseable line, so every check logged what looked like corruption —
  // which would bury a genuinely corrupted batch in routine noise.
  const { events, skipped } = parseNdjson("GitHub audit log streaming check");
  check("the check object contains no events", events.length === 0, events.length);
  check("  and would read as a parse failure, which is why it is skipped by name",
    skipped === 1, skipped);

  const src = fs.readFileSync(path.join(__dirname, "src/audit/ingest.ts"), "utf8");
  check("the handler skips _check before it tries to fetch or parse anything",
    /key === "_check"/.test(src)
      && src.indexOf('key === "_check"') < src.indexOf("GetObjectCommand({ Bucket: bucket"),
    "an endpoint check would be counted as corruption");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
