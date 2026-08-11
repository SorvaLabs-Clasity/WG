/**
 * Tests for what may be undone.
 *
 * The failure this guards against is quiet: an undo that changes nothing but
 * still reports success and still flags the row. In an app whose job is the
 * audit trail, a log that disagrees with reality is the whole product broken,
 * so the rules live in one module and are pinned here.
 */
import {
  undoBlockedReason, isReversible, needsRepoWrite, reposNeedingWrite,
  ALLOWED_UNDO_ACTIONS,
} from "./src/services/undoPolicy";
import type { ActivityEntry } from "./src/services/activityService";

let failures = 0;

function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const at = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: "a1", source: "app", action: "branch.protect", actor: "someone",
  repo: "acme-api", target: "main", timestamp: new Date().toISOString(), ...over,
} as ActivityEntry);

(async () => {
// ── code history is refused, whatever else is true ────────────────────
{
  for (const action of ["github.push", "github.pr_merged", "github.pr_opened", "github.pr_closed"]) {
    const reason = undoBlockedReason(at({ action: action as any, source: "github" }));
    check(`${action} cannot be undone`, !!reason && reason.includes("git operation"), reason);
  }

  // A payload arriving on one of these — a bug, or a tampered row — must not
  // buy its way past the rule.
  const forged = at({
    action: "github.push" as any, source: "github",
    undoPayload: { action: "delete_branch", params: { branch: "main" } },
  });
  check("a push carrying an undo payload is still refused",
    !!undoBlockedReason(forged), undoBlockedReason(forged));

  // Nor may a child smuggle one in.
  const withChild = undoBlockedReason(
    at({ action: "github.push" as any, source: "github" }),
    [at({ id: "c", undoPayload: { action: "delete_branch", params: {} } })],
  );
  check("a push with an undoable child is still refused", !!withChild, withChild);
}

// ── observations of GitHub are refused ────────────────────────────────
{
  const r = undoBlockedReason(at({ action: "branch.create", source: "github" }));
  check("a branch created directly in GitHub is not the app's to undo",
    !!r && r.includes("directly in GitHub"), r);
}

// ── what the app did, it can undo ─────────────────────────────────────
{
  const ok = at({ undoPayload: { action: "delete_protection", params: { branch: "main" } } });
  check("an app action with a known payload is undoable", undoBlockedReason(ok) === null, undoBlockedReason(ok));

  const parent = at({ action: "template.apply", undoPayload: undefined });
  const kids = [at({ id: "c1", undoPayload: { action: "delete_branch", params: {} } })];
  check("a parent with no payload is undoable through its children",
    undoBlockedReason(parent, kids) === null, undoBlockedReason(parent, kids));
  check("  but not when the children have nothing either",
    undoBlockedReason(parent, [at({ id: "c1" })]) !== null);
}

// ── unimplemented operations fail loudly ──────────────────────────────
{
  // The AWS guardrail Lambda writes undo payloads this route has no handler
  // for. Before, they hit `default: break` and reported success.
  const aws = at({ action: "aws.guardrail" as any, repo: "/aws/lambda/thing",
    undoPayload: { action: "logs_restore_retention", params: { days: 1 } } });
  check("an operation with no handler is refused, not silently skipped",
    (undoBlockedReason(aws) ?? "").includes("not supported"), undoBlockedReason(aws));
  check("  and is not counted as reversible", !isReversible(aws));
}

// ── permission scope keys on the operation, not the repo field ────────
{
  // AWS rows put a log group name in `repo`; checking GitHub for it would ask
  // about a repository that does not exist.
  const aws = at({ repo: "/aws/lambda/thing", undoPayload: { action: "revert_widget", params: {} } });
  check("a non-repo operation needs no GitHub write check", !needsRepoWrite(aws));

  const branch = at({ repo: "acme-api", undoPayload: { action: "delete_branch", params: {} } });
  check("a branch operation needs write on its repo", needsRepoWrite(branch));

  const repos = reposNeedingWrite([
    branch,
    at({ id: "b", repo: "acme-web", undoPayload: { action: "restore_protection", params: {} } }),
    at({ id: "c", repo: "acme-api", undoPayload: { action: "delete_ruleset", params: {} } }),
    aws,
    at({ id: "d", repo: "acme-docs", undoPayload: { action: "delete_template", params: {} } }),
  ]);
  check("every repo an undo would write to is collected, once",
    repos.sort().join() === "acme-api,acme-web", repos);
}

// ── the allow-list and the handlers must not drift ────────────────────
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "src/routes/activity.ts"), "utf8");
  const undoFn = src.slice(src.indexOf("async function executeUndo"));
  const handled = new Set(
    [...undoFn.slice(0, undoFn.indexOf("\n}")).matchAll(/case "([a-z_]+)"/g)].map((m: any) => m[1])
  );
  const missing = [...ALLOWED_UNDO_ACTIONS].filter(a => !handled.has(a));
  check("every allowed operation has a handler", missing.length === 0, missing);
  const extra = [...handled].filter(a => !ALLOWED_UNDO_ACTIONS.has(a));
  check("every handler is on the allow-list", extra.length === 0, extra);
}

// ── deleting a branch must not discard work, however it got there ─────
{
  const { inspectBranchWork, branchWasTouched } = require("./src/services/branchService");
  process.env.GITHUB_ORG = process.env.GITHUB_ORG || "test-org";

  const CREATED = "2026-01-01T00:00:00Z";

  /** Octokit stand-in answering only what inspectBranchWork asks. */
  const fake = (tip: string | null, aheadBy?: number, commitsSince = 0) => ({
    rest: {
      git: {
        getRef: async () => {
          if (tip === null) { const e: any = new Error("Not Found"); e.status = 404; throw e; }
          return { data: { object: { sha: tip } } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => {
          if (aheadBy === undefined) throw new Error("no base");
          return { data: { ahead_by: aheadBy } };
        },
        listCommits: async () => ({ data: Array.from({ length: commitsSince }, (_, i) => ({ sha: "c" + i })) }),
      },
    },
  }) as any;

  const look = (o: any, opts: any = {}) => inspectBranchWork(o, "acme-api", "dev",
    { createdFromSha: "abc123", baseBranch: "main", createdAt: CREATED, ...opts });

  const untouched = await look(fake("abc123", 0, 0));
  check("a branch still at its creation commit is deletable", !branchWasTouched(untouched), untouched);

  // Every way a branch can change moves the tip, so one signal covers them all.
  for (const [name, tip, ahead, since] of [
    ["a plain commit",        "def456", 1, 1],
    ["a merge into it",       "def456", 3, 2],
    ["a squash merge",        "def456", 1, 1],
    ["a rebase",              "def456", 2, 2],
    ["a force-push",          "def456", 0, 0],
  ] as [string, string, number, number][]) {
    const w = await look(fake(tip, ahead, since));
    check(`${name} blocks the undo`, branchWasTouched(w), w);
  }

  // Rows written before createdFromSha existed still have to be judged.
  const legacyRebased = await look(fake("def456", 0, 2), { createdFromSha: undefined });
  check("without a recorded SHA, commits landed since creation still block it",
    branchWasTouched(legacyRebased) && legacyRebased.commitsSince === 2, legacyRebased);

  const legacyUnmerged = await look(fake("def456", 3, 0), { createdFromSha: undefined });
  check("  as do unmerged commits", branchWasTouched(legacyUnmerged), legacyUnmerged);

  const legacyClean = await look(fake("abc123", 0, 0), { createdFromSha: undefined });
  check("  and an untouched legacy branch stays deletable", !branchWasTouched(legacyClean), legacyClean);

  // A branch whose work is already in the base loses nothing by being deleted,
  // but it still moved, so the SHA check must be the one that speaks.
  const merged = await look(fake("def456", 0, 0));
  check("a branch whose work was merged away still reports it moved",
    merged.movedSinceCreation && merged.unmergedCommits === 0, merged);

  const gone = await look(fake(null));
  check("an already-deleted branch is a no-op, not an error", gone === null, gone);

  const noBase = await look(fake("def456"), { baseBranch: undefined });
  check("an unusable base leaves the other signals working",
    branchWasTouched(noBase), noBase);

  const noTimestamp = await look(fake("abc123", 0, 9), { createdAt: undefined });
  check("without a creation time, commitsSince is not guessed",
    noTimestamp.commitsSince === 0 && !branchWasTouched(noTimestamp), noTimestamp);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
})();
