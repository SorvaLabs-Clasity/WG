/**
 * The six checks the rebuild used to be the only source for.
 *
 * `public-repos`, `archived-repos-with-access`, `stale-repos`, `unowned-repos`,
 * `empty-teams` and `repos-dependent-on` read edge types no webhook wrote. The
 * app was *told* the moment a repository went public — it raised a critical
 * security alert on that exact delivery — and then left the widget showing the
 * old number for up to six hours. That was a gap, not a decision.
 *
 * Two things close it, and both are asserted here:
 *
 *   - the webhook handler now patches those edges, on events it was already
 *     receiving and already acting on;
 *   - a light pass refreshes them every half hour as a backstop, because a
 *     delivery can be missed and nothing else would correct it.
 *
 * The light pass is the one worth guarding carefully. It must never clear the
 * table the way the full rebuild does, and it must never prune from a partial
 * read — a team whose members could not be listed looks exactly like a team
 * that lost all of them.
 *
 * Run:  npx tsx repro-freshedges.ts   from github-control-hub/backend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (p: string) => fs.readFileSync(`${__dirname}/${p}`, "utf8");

(async () => {
  // ── the webhook now writes what it already knew ─────────────────────
  {
    const wh = read("src/webhooks/processDelivery.ts");

    const cases: Array<[string, RegExp, string]> = [
      ["public-repos / archived-repos", /payload\.action === "publicized"[\s\S]{0,400}patchRepoMeta/, "repository visibility and archival"],
      ["stale-repos", /event === "push"[\s\S]{0,400}patchRepoMeta\(repoName, \{ pushedAt/, "last push time"],
      ["unowned-repos", /added_to_repository"[\s\S]{0,200}addTeamRepoEdge/, "team gaining a repository"],
      ["unowned-repos (removal)", /removed_from_repository"[\s\S]{0,200}removeTeamRepoEdge/, "team losing one"],
      ["empty-teams", /event === "membership"[\s\S]{0,400}addTeamMemberEdge/, "team membership"],
      ["repos-dependent-on", /event === "dependabot_alert"[\s\S]{0,600}addVulnerableDependencyEdge/, "a new advisory"],
    ];
    for (const [label, re, what] of cases) {
      check(`${label}: the graph is patched on ${what}`, re.test(wh));
    }

    check("  a resolved advisory removes its edge rather than marking it",
      /"fixed", "dismissed", "auto_dismissed"[\s\S]{0,450}removeVulnerableDependencyEdge/.test(wh),
      "the rebuild lists open alerts only, so a resolved one would not be there");

    check("  repo_meta is merged, not overwritten",
      /export async function patchRepoMeta/.test(read("src/services/graphEdgeService.ts"))
      && /\.\.\.\(existing\.Item\.metadata \?\? \{\}\), \.\.\.patch/.test(read("src/services/graphEdgeService.ts")),
      "a webhook knows one field; that edge carries a dozen");

    check("  and a repository the rebuild has never seen is not invented",
      /if \(!existing\?\.Item\) return;/.test(read("src/services/graphEdgeService.ts")),
      "a partial repo_meta reads as collected-and-empty rather than not-collected");
  }

  // ── the light pass, and what it must not do ─────────────────────────
  {
    const light = read("src/jobs/lightGraphRefresh.ts");

    check("the light pass never clears the table",
      !/clearGraph|DeleteTable|scanAll/.test(light)
      && !/deleteAll/.test(light),
      "clearing is the expensive rebuild's job, and doing it often is the expensive thing in disguise");

    check("  it reads only what is cheap",
      /repos\.listForOrg/.test(light) && /teams\.list/.test(light)
      && /listReposInOrg/.test(light) && /listMembersInOrg/.test(light),
      "repository metadata arrives with the listing; team composition is two calls each");

    check("  and nothing per-repository, which is where the cost is",
      !/listCollaborators|listRepoWorkflows|listAlertsForRepo|listBranches/.test(light),
      "four requests per repository is the twelve hundred this exists to avoid");

    check("  a failed repository listing writes nothing at all",
      /result\.errors\.push\(`repositories[\s\S]{0,120}return result;/.test(light),
      "half a picture is worse than none");

    check("  pruning only happens when the whole team was read",
      /if \(readTeam\) \{/.test(light),
      "a partial read is indistinguishable from a team that lost everything");

    check("  and both directions of an edge are removed together",
      /deletes\.push\(\{ pk: existing\.sk, sk: teamId \}\)/.test(light),
      "the graph is walked from either end; a half-removed edge answers one way and not the other");
  }

  // ── one function, two schedules ─────────────────────────────────────
  {
    const handler = read("src/jobs/aggregateHandler.ts");
    check("the handler takes a mode", /event\?: \{ mode\?: "light" \| "full" \}/.test(handler));
    check("  light returns before the full rebuild is reached",
      /if \(event\?\.mode === "light"\)[\s\S]{0,1400}return \{ ok: true \};/.test(handler));
    check("  and a quiet light pass is not logged",
      /r\.edgesWritten > 0 && \(r\.edgesRemoved > 0 \|\| r\.errors\.length > 0\)/.test(handler),
      "fifty rows a day saying nothing changed would bury the four that matter");

    const cdk = read("../infra/cdk-stack.ts");
    // Daily, because reconciliation is nearly all it still does: webhooks
    // patch access as it changes and the light pass carries repository facts,
    // so what is left is noticing a delivery that never arrived.
    check("the full rebuild runs nightly at 22:00 Eastern",
      /NightlyGraphRebuild[\s\S]{0,900}hour: "22"[\s\S]{0,200}AMERICA_NEW_YORK/.test(cdk),
      "a rate(1 day) fires 24h after the last deploy, so the hour drifts with deploys");
    check("  named as a zone, so it stays 10pm when the clocks change",
      !/NightlyGraphRebuild[\s\S]{0,900}Schedule\.rate\(/.test(cdk),
      "an events.Rule cron is UTC only, which is 10pm in winter and 11pm in summer");

    // The construct id must not go back to the one the old events.Rule used.
    // CloudFormation refuses to change the Type of a resource under an existing
    // logical id, so reusing it fails the whole changeset before it starts:
    // "Update of resource type is not permitted." Every account that ever
    // deployed the rule is stuck until the id differs.
    check("  under a construct id the old events.Rule never had",
      !/new scheduler\.Schedule\(this, "GraphAggregationSchedule"/.test(cdk),
      "reusing that id fails the changeset on every account that has the old rule");
    check("  the light pass every thirty minutes",
      /GraphLightRefreshSchedule[\s\S]{0,300}Duration\.minutes\(30\)/.test(cdk));
    check("  each says which mode it wants",
      /fromObject\(\{ mode: "full" \}\)/.test(cdk) && /fromObject\(\{ mode: "light" \}\)/.test(cdk),
      "an unlabelled invocation would run the expensive walk on the frequent schedule");

    // Exactly one, deliberately. Replacing a schedule by adding the new one and
    // leaving the old is how a rebuild ends up running twice a night, and
    // nothing about the app would look wrong: the walk is idempotent, so the
    // only symptom is double the GitHub traffic at an hour nobody watches.
    check("  and exactly one thing asks for a full rebuild",
      (cdk.match(/mode: "full"/g) ?? []).length === 1,
      "two schedules on the same walk doubles the org's GitHub traffic silently");
    check("  and exactly one thing asks for a light one",
      (cdk.match(/mode: "light"/g) ?? []).length === 1);
  }

  // ── the docs and the code agree about which events to subscribe ─────
  //
  // Three separate files tell somebody which boxes to tick, and the worker is
  // the only one that decides. A doc listing one fewer than the code handles
  // produces an installation that works except for the one feature nobody
  // thought to check — which is how `membership` would have been missed.
  {
    const wh = read("src/webhooks/processDelivery.ts");
    const handled = [...new Set([...wh.matchAll(/event === "([a-z_]+)"/g)].map(m => m[1]))].sort();

    check(`the worker handles ${handled.length} events`, handled.length === 11, handled);

    for (const [file, path] of [
      ["setup.md", "../../docs/operations/setup.md"],
      ["webhooks.md", "../../docs/github-api/webhooks.md"],
    ] as const) {
      const doc = fs.readFileSync(`${__dirname}/${path}`, "utf8");
      const missing = handled.filter(e => !doc.includes(`\`${e}\``));
      check(`  ${file} names every one of them`, missing.length === 0, missing);
    }

    // HOW-IT-WORKS describes them in prose rather than by API name, so the
    // count is the thing to hold it to.
    const how = fs.readFileSync(`${__dirname}/../../docs/HOW-IT-WORKS.md`, "utf8");
    check("  HOW-IT-WORKS states the right number",
      new RegExp(`(Eleven|${handled.length}) are subscribed`).test(how),
      "prose, so the count is what can be checked");
    check("  and calls out the one that must be ticked by hand",
      /`membership` is the newest/.test(how));

    check("  setup.md tells you how many boxes to tick",
      /tick these eleven/.test(fs.readFileSync(`${__dirname}/../../docs/operations/setup.md`, "utf8")),
      "somebody counting checkboxes against the table is the point of that line");
  }

  // ── who to ask about a stale repository ─────────────────────────────
  {
    const agg = read("src/jobs/graphAggregator.ts");
    const gs = read("src/services/graphService.ts");

    check("the top contributor is collected only for repositories no team owns",
      /if \(!ownedRepoNames\.has\(repo\.name\)\) \{[\s\S]{0,400}listContributors/.test(agg),
      "an owned repository already has an answer; asking anyway is a request per repo for nothing");
    // What went wrong: the call asked with `anon: "false"`, so GitHub filtered
    // out every author whose email is not attached to an account before the
    // aggregator ever saw them. In an organisation whose pushes come from CI or
    // from laptops signing with an unregistered address, that is *every*
    // contributor — 342 of 354 unowned repositories came back with an empty
    // list and the column read "No owner found" on repositories that plainly
    // had somebody pushing to them. The filtering has to happen here, where a
    // registered account can be preferred and an unregistered one still kept.
    // Scoped to the call itself. A guard over the whole file trips on the
    // comment above the call explaining what the old flag did, which is prose
    // worth keeping.
    const contribCall = agg.slice(agg.indexOf("listContributors({"),
                                  agg.indexOf("});", agg.indexOf("listContributors({")));
    check("anonymous authors are asked for rather than filtered away by the API",
      /anon: "1"/.test(contribCall) && !/anon: "false"/.test(contribCall),
      'the API filter returns nothing at all for a repo whose every commit is unlinked');
    check("  a registered account is still preferred over one",
      /const registered = rows\.find\(\(c: any\) => c\.type === "User" && c\.login\)/.test(agg),
      "an account is someone you can reach; a git name is not");
    check("  and the unregistered name is only the fallback",
      /} else if \(anonymous\?\.name\) {/.test(agg));
    check("  which is marked as having no account behind it",
      /unlinked: true/.test(agg),
      "otherwise a git name gets rendered as though it were a GitHub user");
    check("  the address that came with it is not stored",
      !/anonymous\.email/.test(agg),
      "a column about who to ask is not a place emails leak out of");
    check("  still one request per repository",
      (agg.match(/listContributors\(/g) ?? []).length === 1,
      "a second call for the repos that missed would be one per repo again");
    check("  a repository GitHub has no statistics for yet is not an error",
      /err\.status !== 202 && err\.status !== 204/.test(agg),
      "204 is empty, 202 is still computing — neither should cost the repo its other edges");

    // ── the rebuild writes where it was told to ───────────────────────
    //
    // What went wrong: the write branch asked `usesDynamo()`, which reports
    // whether ACTIVITY_TABLE is set. The aggregator's Lambda is never given
    // that variable — it gets GRAPH_EDGES_TABLE and ORG_CONFIG_TABLE — so the
    // answer was always no. Every scheduled run walked the whole organisation
    // for five minutes, generated the edges, then took the local-development
    // branch and died on `mkdir /data`. Not one edge was ever written by the
    // schedule. The table was never empty only because pressing Sync in the app
    // runs the same code in a process that does have ACTIVITY_TABLE, so the
    // graph moved whenever somebody pressed the button and never otherwise.
    check("the rebuild decides by the table it actually writes",
      /const edgesTable = process\.env\.GRAPH_EDGES_TABLE \?/.test(agg),
      "ACTIVITY_TABLE is a different table this job never touches");
    // Comments stripped: the note above the fix explains what the old call did,
    // and a guard that trips on its own explanation is a guard against writing
    // things down.
    const aggCode = agg.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    check("  and nothing here consults the unrelated flag",
      !/usesDynamo\(\)/.test(aggCode),
      "one global 'are we on Dynamo' answer cannot speak for every table");
    check("  the write branch is gated on that same table",
      /if \(edgesTable\) {/.test(agg));
    check("  and a rebuild with nowhere to put the result refuses to start",
      /AWS_LAMBDA_FUNCTION_NAME/.test(agg)
      && /Refusing to rebuild the /.test(agg),
      "writing to a JSON file is a local convenience; in Lambda it is a misconfiguration");

    // The light pass runs in that same Lambda and had the same defect: it
    // returned before doing anything, in about fifty milliseconds, every thirty
    // minutes. A pass that does nothing looks exactly like a pass with nothing
    // to do, which is why it went unnoticed for as long as the rebuild did.
    const lightSrc = read("src/jobs/lightGraphRefresh.ts");
    const lightCode = lightSrc.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    check("the light pass is gated on the table it writes",
      /if \(!process\.env\.GRAPH_EDGES_TABLE\)/.test(lightCode));
    check("  and does not consult the unrelated flag either",
      !/usesDynamo\(\)/.test(lightCode),
      "it runs in the aggregator's Lambda, which is never given ACTIVITY_TABLE");
    check("  refusing to run in Lambda with nowhere to write",
      /AWS_LAMBDA_FUNCTION_NAME/.test(lightCode) && /Refusing to refresh /.test(lightCode));

    // A raw NUL byte written into a template literal made the whole file read
    // as binary: grep reported nothing rather than no matches, which is a
    // silent hole under every source-scanning guard in this suite.
    check("no source file is binary to a line-oriented tool",
      !lightSrc.includes("\u0000") && !agg.includes("\u0000"),
      "grep says nothing at all for a binary file, and a guard that scans it passes vacuously");

    // The infrastructure side of the same fact: if a future edit routes this
    // job through a helper that wants ACTIVITY_TABLE, the variable still is not
    // there, and the failure looks like this one did.
    const stack = read("../infra/cdk-stack.ts");
    const aggBlock = stack.slice(stack.indexOf("-graph-aggregator`,"),
                                stack.indexOf("-graph-aggregator`,") + 1200);
    check("the aggregator's Lambda is given the edges table",
      /GRAPH_EDGES_TABLE:/.test(aggBlock));
    check("  and is not given the activity table it never writes",
      !/ACTIVITY_TABLE:/.test(aggBlock),
      "adding it would paper over the bug rather than fix it");

    // Three tiers, in order. The order is the meaning: a team answers "who is
    // responsible", a direct admin answers it less formally, and a committer
    // is only a lead. Getting them out of order would present a guess as an
    // assignment.
    check("stale-repos prefers the owning team",
      /teams\?\.length \? teams\.sort\(\)\.join\(", "\)/.test(gs));
    check("  then a direct admin",
      /: admins\?\.length \? admins\.sort\(\)\.join\(", "\)/.test(gs));
    check("  then the top committer",
      /: committer \?\? unlinked \?\? null/.test(gs));
    check("  and an unregistered committer last of all",
      /: unlinked \? "unlinked-committer"/.test(gs),
      "a name from git metadata is an answer, but the weakest one");
    check("  and reports which of the three it found",
      /ownerKind/.test(gs),
      "a team slug and a username are indistinguishable without it");

    check("an admin only counts when granted directly",
      /edge\.metadata\?\.source === "direct"/.test(gs),
      "organization owners hold admin everywhere; every unowned repo would name the same people");
    check("  and only at admin, not any permission",
      /edge\.metadata\?\.role === "admin"/.test(gs));
    check("several owning teams are all listed, sorted",
      /teams\.sort\(\)\.join\(", "\)/.test(gs),
      "a repository can be owned by more than one team");
  }

  // ── a deleted repository leaves nothing behind ──────────────────────
  //
  // It used to leave everything: repo_meta, collaborators, branches, the team
  // links pointing at it. Nothing removed them, so every check kept naming a
  // repository that no longer existed until the next full rebuild cleared the
  // table. Up to six hours, with a refresh button that could not help because
  // the rows it re-read were still there.
  //
  // The light pass does not cover it: it prunes inside teams it has just read,
  // and a vanished repository is under no team it reads.
  {
    const wh = read("src/webhooks/processDelivery.ts");
    const edges = read("src/services/graphEdgeService.ts");
    const whCode = wh.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");

    check("repository deletion is handled at all",
      /payload\.action === "deleted" \|\| payload\.action === "renamed"/.test(whCode),
      "the only `deleted` handlers were for branch protection and rulesets");
    check("  and it removes the repository's edges",
      /removeAllRepoEdges\(/.test(whCode));
    check("  a rename removes the old name, not the new one",
      /payload\.changes\?\.repository\?\.name\?\.from/.test(whCode),
      "the old name's edges are as stale as a deleted one's");
    check("  both are recorded in the activity feed",
      /"repo\.deleted"/.test(whCode) && /"repo\.renamed"/.test(whCode));

    check("the removal follows paging rather than one page",
      /LastEvaluatedKey/.test(edges),
      "a repository with many collaborators would be half-removed");
    check("  and clears the mirrored half as well",
      /e\.sk\.startsWith\("TEAM#"\) \|\| e\.sk\.startsWith\("USER#"\)/.test(edges),
      "an edge from a team to this repo lives under the team's key, not the repo's");
  }

  // ── the two writers of repo_meta cannot drift ───────────────────────
  //
  // Both write the row as a whole item, because a PutRequest in a batch write
  // replaces rather than merges. So a field one writes and the other does not
  // is erased on the other's next pass. `dependabotEnabled` was added to the
  // full rebuild alone and would have been wiped every thirty minutes, leaving
  // the vulnerable-package check unable to tell "alerts off" from "never
  // looked" for every repository between passes.
  {
    const agg = read("src/jobs/graphAggregator.ts");
    const light = read("src/jobs/lightGraphRefresh.ts");
    const { buildRepoMeta } = await import("./src/jobs/repoMeta");

    check("both writers build the row from one definition",
      /buildRepoMeta\(repo/.test(agg) && /buildRepoMeta\(repo/.test(light),
      "two hand-written field lists is the shape that lost the field");
    check("  and neither hand-rolls a second list",
      !/visibility: repo\.visibility/.test(agg) && !/visibility: repo\.visibility/.test(light));

    const repo = {
      name: "r", visibility: "private", archived: false, fork: false,
      pushed_at: "2026-01-01T00:00:00Z", created_at: "2025-01-01T00:00:00Z",
      default_branch: "main",
    };
    const bare = buildRepoMeta(repo);

    check("the row carries what every check reads",
      ["visibility", "archived", "fork", "pushedAt", "createdAt",
       "defaultBranch", "secretScanning", "pushProtection"].every(k => k in bare),
      Object.keys(bare));
    check("  an unread security setting is unknown, not disabled",
      bare.secretScanning === "unknown" && bare.pushProtection === "unknown");

    check("neither pass collects anything the other does not",
      /fetchRepoAlertStatus/.test(light) === /fetchRepoAlertStatus/.test(agg),
      "a field one writes and the other omits is erased on the other's next pass");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
