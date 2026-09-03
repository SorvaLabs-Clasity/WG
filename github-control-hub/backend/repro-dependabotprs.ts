/**
 * Seeing which Dependabot pull requests are actually open.
 *
 * The tab knew how many there were, per repository, and that was enough to
 * print "4/18" beside the findings and nothing else. Somebody looking at that
 * still had to go to GitHub to learn which four, whether any of them were
 * green, and which of the findings below they would close.
 *
 * The same search already ran for the counts, so the pull requests were being
 * fetched and then thrown away. This keeps them, and asks the shared details
 * module for the check state, which is one GraphQL batch on a budget the
 * search does not touch.
 *
 * Two things this file exists to hold down:
 *
 *   - null still means "nobody looked". A failed search must not read as an
 *     organization with no open pull requests, because those two render
 *     identically and mean opposite things.
 *   - the branch name is parsed for the package it bumps, and parsing that
 *     wrong is worse than not parsing it. Dependabot's grouped branches carry
 *     no single package, and inventing one would label a pull request as
 *     fixing something it does not.
 */
import { packageFromBranch } from "./src/services/dependabotPrs";
import { fetchDependabotPrs, __resetDependabotPrCache } from "./src/services/dependabotPrs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const item = (over: any = {}) => ({
  id: 1, number: 7, title: "Bump lodash from 4.17.20 to 4.17.21",
  html_url: "https://github.com/Org/api/pull/7",
  repository_url: "https://api.github.com/repos/Org/api",
  created_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
  draft: false,
  ...over,
});

(async () => {
  console.log("the pull requests themselves, not only how many");
  {
    __resetDependabotPrCache();
    const search = async () => ({ items: [item(), item({ id: 2, number: 9, repository_url: "https://api.github.com/repos/Org/web" })] });
    const out = await fetchDependabotPrs(search as any, "Org");

    check("both are returned", out?.prs.length === 2, out?.prs.length);
    check("  attributed to the right repository, which only the URL carries",
      out?.prs[0].repo === "api" && out?.prs[1].repo === "web",
      out?.prs.map(p => p.repo));
    check("  with the link out", /pull\/7$/.test(out?.prs[0].url ?? ""));
    check("  and an age, because a stale bot pull request is the thing worth seeing",
      out?.prs[0].ageDays === 3, out?.prs[0].ageDays);

    check("  counts still come out of the same answer, rather than a second search",
      out?.counts.api === 1 && out?.counts.web === 1, out?.counts);
  }

  console.log("\nnobody looked is not nothing is open");
  {
    __resetDependabotPrCache();
    const broken = async () => { throw new Error("search is rate limited"); };
    const out = await fetchDependabotPrs(broken as any, "Org");
    check("a failed search returns null, not an empty list", out === null, out);
  }

  console.log("\nthe package a pull request bumps, where the branch says so");
  {
    // Dependabot's branch names are the most reliable statement of what a pull
    // request touches. The title says the same thing in prose, and prose is
    // what changes between GitHub releases.
    check("an npm bump", packageFromBranch("dependabot/npm_and_yarn/lodash-4.17.21") === "lodash");
    check("  a scoped package keeps its scope",
      packageFromBranch("dependabot/npm_and_yarn/babel/core-7.24.0") === "babel/core");
    check("  a maven coordinate",
      packageFromBranch("dependabot/maven/com.fasterxml.jackson.core-jackson-databind-2.15.0")
        === "com.fasterxml.jackson.core-jackson-databind");
    check("  and a nested manifest does not swallow the package",
      packageFromBranch("dependabot/npm_and_yarn/services/api/axios-1.6.0") === "axios");
  }

  console.log("\nand nothing is invented where the branch does not say");
  {
    // A grouped pull request bumps many packages and names none of them. The
    // UI falls back to the title there, which is honest; printing a group name
    // as a package would label the pull request as fixing something that does
    // not exist.
    //
    // The first version of this recognised only Dependabot's default "multi-"
    // grouping and read every other group as a package. A real branch from the
    // config this app writes, `security-fixes-450e0d57a0`, came out as the
    // package "security-fixes": the hash was stripped as though it were a
    // version number. The group name is whatever the dependabot.yml calls it,
    // so it can never be enumerated, and the rule below inverts to match: a
    // package is claimed only where the suffix genuinely looks like a version.
    check("the group this app's own config creates names no package",
      packageFromBranch("dependabot/npm_and_yarn/security-fixes-450e0d57a0") === null,
      packageFromBranch("dependabot/npm_and_yarn/security-fixes-450e0d57a0"));
    check("  nor does any other group name somebody chose",
      packageFromBranch("dependabot/pip/all-deps-9f8e7d6c5b") === null
        && packageFromBranch("dependabot/maven/prod-dependencies-0011223344") === null);
    check("  nor Dependabot's default grouping",
      packageFromBranch("dependabot/npm_and_yarn/multi-a1b2c3d4e5") === null);
    check("  nor a grouped branch under a directory",
      packageFromBranch("dependabot/npm_and_yarn/api/multi-a1b2c3d4e5") === null);

    // A hash that happens to start with a letter is the case a digit-led rule
    // would have missed, so the rule keys on the version's shape instead.
    check("  and a hash beginning with a letter is still not a version",
      packageFromBranch("dependabot/npm_and_yarn/security-fixes-a50e0d57a0") === null);

    // Conservative on purpose: a bump to a version with no dot claims nothing
    // rather than guessing. No wrong name is better than a plausible one.
    check("  while an undotted suffix claims nothing rather than guessing",
      packageFromBranch("dependabot/npm_and_yarn/something-2") === null);
    check("  a branch that is not Dependabot's shape gives nothing",
      packageFromBranch("feature/some-work") === null);
    check("  and neither does an empty one", packageFromBranch("") === null
      && packageFromBranch(undefined) === null);
  }

  console.log("\nheld briefly, because two views ask the same question");
  {
    __resetDependabotPrCache();
    let calls = 0;
    const search = async () => { calls++; return { items: [item()] }; };
    await fetchDependabotPrs(search as any, "Org");
    await fetchDependabotPrs(search as any, "Org");
    check("a second read inside the window costs no search", calls === 1, calls);
  }

  console.log("\nthe search is one query for the organization");
  {
    __resetDependabotPrCache();
    const queries: string[] = [];
    const search = async (q: string) => { queries.push(q); return { items: [] }; };
    await fetchDependabotPrs(search as any, "Org");

    // Search allows thirty requests a minute. A query per repository would be
    // 350 of them and would exhaust that allowance many times over.
    check("one search, not one per repository", queries.length === 1, queries);
    check("  scoped to the organization and to Dependabot",
      /org:Org/.test(queries[0]) && /author:app\/dependabot/.test(queries[0]), queries[0]);
    check("  and to open ones, since a merged fix is not something to act on",
      /is:open/.test(queries[0]), queries[0]);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
