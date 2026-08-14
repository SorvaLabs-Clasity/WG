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
import { isConsequential, normalise, parseNdjson, toTimestamp, describe, allowList } from "./src/audit/events";

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
  check("  epoch seconds are recognised and not read as 1970",
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

// ── normalising into an activity row ──────────────────────────────────
{
  const n = normalise({ action: "protected_branch.destroy", actor: "alice", created_at: 1786680000000, repo: "Org/api" });
  check("the audit action lands in target, which is what tells rows apart",
    n.target === "protected_branch.destroy", n.target);
  check("  the actor is carried through", n.actor === "alice", n.actor);
  check("  and the repository", n.repo === "Org/api", n.repo);

  const orgScoped = normalise({ action: "org.add_member", actor: "bob", created_at: 1786680000000 });
  check("an organization-scoped event has an empty repo, not the word undefined",
    orgScoped.repo === "", orgScoped.repo);

  const anon = normalise({ action: "repo.create", created_at: 1786680000000 });
  check("a missing actor reads as unknown rather than undefined", anon.actor === "unknown", anon.actor);

  check("the summary names who did what",
    describe({ action: "repo.access", actor: "carol", repo: "api" }).includes("carol")
      && describe({ action: "repo.access", actor: "carol", repo: "api" }).includes("repo.access"),
    describe({ action: "repo.access", actor: "carol", repo: "api" }));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
