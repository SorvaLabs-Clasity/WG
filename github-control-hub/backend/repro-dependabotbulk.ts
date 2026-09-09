import fs from "node:fs";
import path from "node:path";
import { runDependabotBulk } from "./src/services/dependabotBulk";

/**
 * Regression test: turning Dependabot on across many repositories.
 *
 * Doing this by hand, one repository at a time, produced "an unexpected error
 * occurred" as soon as somebody clicked quickly: these are writes, GitHub
 * applies a secondary rate limit to writes in quick succession, and the app's
 * client is built to surface those rather than retry them.
 *
 * The two ways to get the fix wrong are both quiet. Retrying a refusal that
 * will never change makes a run take minutes to tell somebody they lack admin
 * access. Not retrying a request to slow down turns a pause into a failure and
 * leaves half the selection untouched with no clue which half.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

/** An error shaped the way Octokit reports one. */
const ghError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(message), { status, response: { headers } });

const secondary = () =>
  ghError(403, "You have exceeded a secondary rate limit", { "retry-after": "1" });

/** A stub that records what it was asked, and can be told to fail. */
function stub(
  behaviour: (repo: string, calls: number) => void = () => {},
  /**
   * What `repos.get` says about each repository.
   *
   * Absent means the read is not available at all, which is the case the
   * fallback exists for: the reason is then GitHub's own words rather than an
   * invented one.
   */
  facts?: Record<string, any>,
) {
  const calls: Array<{ repo: string; at: number }> = [];
  const perRepo = new Map<string, number>();
  const rest = {
    repos: {
      async get({ repo }: any) {
        calls.push({ repo: `${repo}:get`, at: Date.now() });
        if (!facts || !(repo in facts)) throw ghError(404, "Not Found");
        return { data: facts[repo] };
      },
      async enableVulnerabilityAlerts({ repo }: any) {
        const n = (perRepo.get(repo) ?? 0) + 1;
        perRepo.set(repo, n);
        calls.push({ repo, at: Date.now() });
        behaviour(repo, n);
      },
      async disableVulnerabilityAlerts({ repo }: any) { calls.push({ repo, at: Date.now() }); },
      async enableAutomatedSecurityFixes({ repo }: any) { calls.push({ repo: `${repo}:fixes`, at: Date.now() }); },
      async disableAutomatedSecurityFixes({ repo }: any) { calls.push({ repo: `${repo}:fixes`, at: Date.now() }); },
    },
  };
  return { octokit: { rest }, calls };
}

(async () => {
  console.log("\na request to slow down is waited out, not reported as a failure");
  {
    // The exact case somebody hit: GitHub asks for a pause partway through.
    let thrown = false;
    const { octokit, calls } = stub((repo) => {
      if (repo === "b" && !thrown) { thrown = true; throw secondary(); }
    });
    const out = await runDependabotBulk(octokit, "acme", ["a", "b", "c"], "alerts-on");

    check("every repository ends up changed", out.changed === 3, out);
    check("  none is reported as failed", out.failed === 0, out.results);
    check("  the one that was paused was tried again",
      calls.filter(c => c.repo === "b").length === 2, calls.map(c => c.repo));
    check("  and the wait is reported rather than hidden", out.sleptSeconds >= 1, out.sleptSeconds);
  }

  console.log("\na refusal that will never change is not retried");
  {
    // Retrying this would make the run take minutes to say "you are not an
    // admin on that one".
    const { octokit, calls } = stub((repo) => {
      if (repo === "b") throw ghError(403, "Must have admin rights to Repository.");
    }, { b: { archived: false, permissions: { admin: false } } });
    const out = await runDependabotBulk(octokit, "acme", ["a", "b"], "alerts-on");

    check("it is attempted once",
      calls.filter(c => c.repo === "b").length === 1, calls.map(c => c.repo));
    check("  and reported in words somebody can act on",
      /admin access/i.test(out.results.find(r => r.repo === "b")?.error ?? ""),
      out.results);
    check("  while the others still go through", out.changed === 1, out);
  }

  console.log("\nwhy GitHub refused is asked, not assumed");
  {
    /**
     * Every 403 used to be reported as "You do not have admin access to this
     * repository". That is the common cause and it was wrong for the two that
     * actually come up, so people went looking for a permission problem that
     * was not there.
     */
    const archived = stub(
      (repo) => { if (repo === "b") throw ghError(403, "Repository was archived so is read-only."); },
      { b: { archived: true } },
    );
    const out = await runDependabotBulk(archived.octokit, "acme", ["a", "b"], "alerts-on");
    const why = out.results.find(r => r.repo === "b")?.error ?? "";

    check("an archived repository is named as archived",
      /archived/i.test(why) && !/admin access/i.test(why), why);
    check("  and says what to do about it", /unarchive/i.test(why), why);

    // Only for a repository that already failed, so a clean run pays nothing.
    check("  and the extra read happens only for the one that failed",
      archived.calls.filter(c => c.repo.endsWith(":get")).length === 1,
      archived.calls.map(c => c.repo));
  }

  console.log("\nthe dependency graph being off is its own answer");
  {
    // Alerts are built on the dependency graph, so this is not a permission
    // problem and turning it on is a different switch in a different place.
    const { octokit } = stub(
      (repo) => { if (repo === "b") throw ghError(422, "Validation Failed"); },
      { b: { archived: false, security_and_analysis: { dependency_graph: { status: "disabled" } } } },
    );
    const out = await runDependabotBulk(octokit, "acme", ["a", "b"], "alerts-on");
    const why = out.results.find(r => r.repo === "b")?.error ?? "";

    check("it is named rather than blamed on access",
      /dependency graph/i.test(why) && !/admin access/i.test(why), why);
    check("  and says where it is turned on", /Code security/i.test(why), why);
  }

  console.log("\nwhen the reason cannot be read, GitHub's own words stand");
  {
    /**
     * The direction that matters. Guessing is the mistake being undone, so a
     * read that itself fails must not produce an invented reason.
     */
    const { octokit } = stub((repo) => {
      if (repo === "b") throw ghError(403, "Must have admin rights to Repository.");
    });   // no facts at all, so repos.get throws
    const out = await runDependabotBulk(octokit, "acme", ["a", "b"], "alerts-on");
    const why = out.results.find(r => r.repo === "b")?.error ?? "";

    check("what GitHub said is what is shown",
      /Must have admin rights/i.test(why), why);
    check("  and nothing is invented on top of it",
      !/archived|dependency graph/i.test(why), why);
    check("  while the run still finishes", out.changed === 1, out);
  }

  console.log("\none bad repository does not stop the rest");
  {
    const { octokit } = stub((repo) => {
      if (repo === "b") throw ghError(404, "Not Found");
    });
    const out = await runDependabotBulk(octokit, "acme", ["a", "b", "c", "d"], "alerts-on");
    check("everything else is done", out.changed === 3, out);
    check("  and the failure names its repository",
      out.results.find(r => r.repo === "b")?.ok === false, out.results);
  }

  console.log("\nfixes turn scanning on first");
  {
    // GitHub will not raise security updates for a repository it is not
    // scanning, so turning fixes on alone reports success and delivers nothing.
    const { octokit, calls } = stub();
    await runDependabotBulk(octokit, "acme", ["a"], "fixes-on");
    check("alerts are enabled before fixes",
      calls[0]?.repo === "a" && calls[1]?.repo === "a:fixes",
      calls.map(c => c.repo));
  }

  console.log("\nthe work is spaced rather than fired at once");
  {
    const started = Date.now();
    const { octokit } = stub();
    await runDependabotBulk(octokit, "acme", ["a", "b", "c", "d", "e", "f"], "alerts-on");
    const took = Date.now() - started;
    // Six repositories, three at a time, with a gap between each: slower than
    // instant on purpose, and the thing that stops GitHub refusing the burst.
    check("six repositories take a moment rather than no time", took >= 200, took);
  }

  console.log("\nthe pacing lives where the refusals arrive");
  {
    const routes = fs.readFileSync(path.join(__dirname, "src/routes/dependencies.ts"), "utf8");
    check("the bulk action is one request, not one per repository",
      /router\.post\("\/dependencies\/bulk"/.test(routes),
      "a loop in the browser is the burst that the limit exists to stop");
    // Scoped to the bulk handler rather than to a window of characters: the
    // same token line opens several routes in this file, and a fixed window
    // measures whichever one happens to be nearest.
    const bulk = routes.slice(
      routes.indexOf('router.post("/dependencies/bulk"'),
      routes.indexOf('router.get("/summary"'));
    check("  and it runs with the caller's own token",
      /req\.user\?\.accessToken/.test(bulk) && /createOctokit\(token,/.test(bulk)
        && !/getSystemToken/.test(bulk),
      "a bulk action must not reach further than the person could one at a time");
    check("  with a ceiling on how many at once",
      /list\.length > 200/.test(routes),
      "the run happens inside one request and a thousand would outlive it");

    const api = fs.readFileSync(
      path.join(__dirname, "..", "frontend", "src", "api", "dependencies.ts"), "utf8");
    check("  the client sends the whole selection in one call",
      /bulkDependabot\(repos: string\[\]/.test(api));

    /**
     * And that the panel is actually reachable.
     *
     * It was not, for a whole round: the component and the route were written,
     * imported and committed, and the page never rendered either of them. An
     * unused import is not a type error and a build over a component nobody
     * mounts still succeeds, so every check passed on a feature that did not
     * exist on screen.
     */
    const page = fs.readFileSync(
      path.join(__dirname, "..", "frontend", "src", "pages", "DependencyDashboardPage.tsx"), "utf8");
    check("the page has a control that opens it",
      // The control opens a drawer now rather than toggling a band, so it sets
      // the state rather than flipping it. The claim is unchanged: something
      // on the page has to put this on screen.
      /setManaging\(true\)/.test(page) && /title="Manage Dependabot"/.test(page),
      "importing the component is not the same as putting it on screen");
    check("  and renders the panel when it is open",
      /<DependabotManager\s/.test(page),
      "the import satisfied the compiler and nothing satisfied the reader");
    check("  only on the view it belongs to",
      /view === "alerts" && managing/.test(page));

    // Per repository, next to the findings, which is where somebody is when
    // they decide they want it.
    check("each repository can be switched on its own",
      /runFixes\(repo\)/.test(page) && /Auto-fix PRs/.test(page));
    check("  offered only where scanning is on",
      /!off && fixes === false/.test(page),
      "GitHub raises no updates for a repository it is not scanning");
    check("  and only where the answer is known",
      /fixes === false/.test(page) && /fixes === true/.test(page)
        && !/!fixes\b/.test(page),
      "undefined means the caller cannot see the field, and a button there can only fail");
    check("  reusing the paced endpoint rather than a second one",
      /bulkDependabot\(\[repo\], "fixes-on"\)/.test(page),
      "a separate route is a second place for the retry rules to drift");

    // Three states, because the field is absent for a repository the caller
    // does not administer, and absent is not off.
    const service = fs.readFileSync(
      path.join(__dirname, "src/services/dependencyService.ts"), "utf8");
    check("the status reader keeps unknown out of the map",
      /if \(state === "enabled" \|\| state === "disabled"\)/.test(service),
      "marking an unreadable repository as off invites turning on what is already on");
    check("  and reads the organization listing rather than one repository at a time",
      /listForOrg\(\{[\s\S]{0,80}per_page: 100/.test(service),
      "three hundred repositories is three hundred requests the other way");
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
