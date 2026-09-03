/**
 * The Vulnerabilities tab waiting on a sweep it already had the answer to.
 *
 * The list was served from storage the moment somebody opened the tab, and the
 * tab still took as long as an organization-wide walk to appear, on the first
 * open after every app launch. Two facts explain it together:
 *
 *   - the spinner is `depsLoading || sumLoading`, so it waits for the severity
 *     counts as well as the list, and
 *   - `/summary` swept the whole organization live, every call, ignoring the
 *     stored answer entirely. On 7,047 alerts that is seventy-one sequential
 *     pages.
 *
 * The second open in a session was fast because the sweep is held briefly in
 * memory, which is precisely why this only ever showed up on the first open
 * after launching the app, and why it looked like a cold-start mystery rather
 * than a missing cache read.
 *
 * The counts are arithmetic over exactly the rows already stored. Nothing had
 * to be fetched to produce them.
 *
 * The trap in doing this, and the reason the counting is one shared function:
 * the stored rows are not the swept rows. Storage also holds a marker for every
 * repository that produced no findings, so that a clean repository can be told
 * apart from an unwatched one. Counting those as vulnerabilities would report
 * findings against every quiet repository in the organization.
 */
import { summariseAlerts } from "./src/services/dependencySummary";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const alert = (over: any = {}) => ({ repo: "api", severity: "high", ...over });

console.log("counts over the rows, without asking GitHub anything");
{
  const out = summariseAlerts([
    alert({ severity: "critical" }), alert({ severity: "high" }),
    alert({ severity: "high", repo: "web" }), alert({ severity: "low", repo: "web" }),
  ]);
  check("severities are counted", out.critical === 1 && out.high === 2 && out.low === 1, out);
  check("  and repositories are counted once each", out.repos_with_vulns === 2, out);
}

console.log("\nGitHub's spelling, not this app's");
{
  // Counting only "medium" meant every moderate alert fell through and was
  // reported in no severity at all, so the totals were short in the
  // reassuring direction.
  const out = summariseAlerts([alert({ severity: "moderate" })]);
  check("moderate is counted as medium", out.medium === 1, out);
}

console.log("\nthe markers in storage are not findings");
{
  // These exist so a clean repository can be told from an unwatched one. They
  // are rows, they carry a severity, and counting them would report findings
  // against every quiet repository in the organization.
  const out = summariseAlerts([
    alert({ repo: "quiet", clean: true, severity: "low" }),
    alert({ repo: "unwatched", disabled: true, severity: "low" }),
    alert({ repo: "justenabled", scanning: true, severity: "low" }),
    alert({ repo: "api", severity: "critical" }),
  ]);
  check("a clean marker is not a finding", out.low === 0, out);
  check("  and only the real one counts towards repositories",
    out.repos_with_vulns === 1 && out.critical === 1, out);
}

console.log("\nan unnamed repository is not a repository");
{
  // The sweep uses "unknown" where it could not attribute an alert, and
  // counting it would invent a repository nobody could go and look at.
  const out = summariseAlerts([alert({ repo: "unknown" }), alert({ repo: "" })]);
  check("neither unknown nor blank becomes a repository", out.repos_with_vulns === 0, out);
}

console.log("\nthe route prefers what is stored, and both paths count the same way");
{
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const route = fs.readFileSync(path.join(__dirname, "src/routes/dependencies.ts"), "utf8");

  // To the next route, not to the first "});" — that one closes the 401
  // response object three lines in, and slicing there made every check below
  // pass or fail on an empty string.
  const from = route.indexOf('router.get("/summary"');
  const next = route.indexOf("\nrouter.", from + 1);
  const body = route.slice(from, next === -1 ? undefined : next);

  check("the stored answer is read before anything is fetched",
    body.indexOf("readDependencySnapshot") > 0
      && body.indexOf("readDependencySnapshot") < body.indexOf("fetchOrgDependencyAlerts"),
    { stored: body.indexOf("readDependencySnapshot"), swept: body.indexOf("fetchOrgDependencyAlerts") });

  // Two hand-written loops would be two places for the marker handling and
  // the moderate spelling to drift, and the drift shows as a tab whose header
  // disagrees with the list underneath it.
  check("  both paths count through the one function",
    (body.match(/summariseAlerts/g) ?? []).length >= 2, body.match(/summariseAlerts/g));

  // A degraded sweep is a partial reading, and reporting counts off it
  // understates the organization in the reassuring direction.
  check("  and a degraded stored answer is refused the same way a degraded sweep is",
    /stored\.degraded/.test(body), body.slice(0, 400));

  // The live sweep must still be there for the first open of a new
  // organization, where nothing has been stored yet.
  check("  while nothing stored still falls back to sweeping",
    /fetchOrgDependencyAlerts/.test(body));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
