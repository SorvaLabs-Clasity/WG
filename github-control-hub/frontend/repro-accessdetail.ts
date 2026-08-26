/**
 * Every clickable row in the access map opens something.
 *
 * The team list was clickable, `TeamDetail` was written in full, and the branch
 * that renders it was missing — so `setOpenTeam` set a piece of state nothing
 * read, and clicking a team did nothing whatsoever. No error, no blank screen,
 * no clue: the click just had no effect.
 *
 * That shape is invisible in review because each half looks complete on its
 * own. It is only wrong in the gap between them, which is what this checks: for
 * every `setOpenX` the page can call, there must be an `if (openX)` that
 * renders a detail view.
 *
 * Run:  npx tsx repro-accessdetail.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const page = fs.readFileSync("./src/pages/AccessPage.tsx", "utf8");

(async () => {
  // Every detail view the page holds state for.
  const states = [...new Set(
    [...page.matchAll(/const \[(open\w+), set(\w+)\] = useState/g)].map(m => m[1]),
  )];

  check("the page has detail views to open", states.length >= 3, states);

  for (const state of states) {
    const opener = `set${state[0].toUpperCase()}${state.slice(1)}`;
    check(`${state}: something sets it`,
      new RegExp(`${opener}\\(`).test(page), opener);
    check(`  and a branch renders it`,
      new RegExp(`if \\(${state}\\) \\{`).test(page),
      "without this the click sets state nothing reads, and nothing happens");
  }

  // Each detail view must offer a way back, or it is a dead end.
  for (const comp of ["PersonDetail", "RepoDetail", "TeamDetail"]) {
    const at = page.indexOf(`<${comp}`);
    check(`  ${comp} is given a way back`,
      at > 0 && /onBack=\{/.test(page.slice(at, at + 400)), comp);
  }

  // The team view can reach both of the others, which is the whole point of a
  // graph you navigate rather than a list you read.
  {
    const at = page.indexOf("<TeamDetail");
    const block = page.slice(at, at + 500);
    check("the team view can open a person", /onOpenPerson=\{/.test(block));
    check("  and a repository", /onOpenRepo=\{/.test(block));
    check("  switching the list behind it, so Back lands somewhere coherent",
      /setMode\("people"\)/.test(block) && /setMode\("repos"\)/.test(block));
  }

  // ── the team view says access, not ownership ────────────────────────
  //
  // GitHub returns every repository a team has been granted anything on, at
  // whatever permission — the rows carry a permission pill saying so. Calling
  // that "owns" overstates a read-only grant, and contradicts `unowned-repos`,
  // which counts any team grant as ownership precisely because it is a floor.
  {
    const at = page.indexOf("Repositories this team");
    const heading = page.slice(at, page.indexOf("/>", at));

    check("the team's repository list is described as access",
      /has access to/.test(heading), heading.slice(0, 70));
    check("  not as ownership", !/\bowns\b/.test(heading), heading.slice(0, 70));
    check("  and each row shows the permission it was granted at",
      /<Pill intent=\{r\.permission === "admin"/.test(page),
      "read and admin are different findings and must not look alike");
  }

  // ── the rebuild asks first ──────────────────────────────────────────
  //
  // "Sync from GitHub" reads like a refresh and is not one: it clears the
  // stored map and rewrites it from a full walk, spending the organization's
  // GitHub budget over several minutes, in this application rather than in
  // AWS. The same walk runs by itself every six hours, so most presses were
  // buying nothing at a real cost.
  {

    check("pressing Sync asks before it rebuilds",
      /if \(confirmRebuild\(a\?\.edgeCount\)\) sync\.mutate\(\)/.test(page),
      "the label reads lighter than the act");
    check("  the dialog says what is replaced",
      /Rebuild the whole access map\?/.test(page)
        && /stored connections/.test(page));
    check("  and quantifies it where the count is known",
      /edgeCount\.toLocaleString\(\)/.test(page),
      '"everything currently stored" is the fallback, not the usual case');
    for (const [what, re] of [
      ["how long it takes", /Takes several minutes/],
      // Worded as a rate limit, not a "budget": the first reader of this
      // dialog asked whether it meant money. It means requests.
      ["that it draws on a shared rate limit", /shared GitHub rate limit/],
      ["that the cost lands on everyone", /the app down for everyone/],
      ["that closing the app stops it", /leave it open until it finishes/],
      ["that waiting would have done it anyway", /automatically every 6 hours/],
    ] as [string, RegExp][]) {
      check(`  it states ${what}`, re.test(page));
    }
    check("  and cancelling starts nothing",
      !/sync\.mutate\(\);\s*\}\s*\}/.test(page.replace(/if \(confirmRebuild[^\n]*\n/, "")),
      "the mutation must be reachable only through the confirmation");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
