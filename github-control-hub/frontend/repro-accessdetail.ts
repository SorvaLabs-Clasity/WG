/**
 * Every clickable row in the access map opens something.
 *
 * The team list was clickable, `TeamDetail` was written in full, and the branch
 * that renders it was missing, so `setOpenTeam` set a piece of state nothing
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
  // whatever permission, the rows carry a permission pill saying so. Calling
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

    // The dialog is shared now: two buttons trigger the same walk, and one of
    // them warning while the other did not is how somebody learns the warning
    // is optional.
    const dialog = fs.readFileSync("./src/lib/confirmRebuild.ts", "utf8");
    const overview = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");

    // Structural now rather than checked twice: both pages render the same
    // component, and that component is the only thing that calls the dialog.
    // Two hand-written buttons is how one of them came to warn and the other
    // not, which teaches somebody the warning is optional.
    const button = fs.readFileSync("./src/components/RecrawlButton.tsx", "utf8");
    check("both buttons that trigger a recrawl are the same button",
      /<RecrawlButton/.test(page) && /<RecrawlButton/.test(overview),
      "Access had the dialog and Overview did not");
    check("  and it asks first",
      /if \(confirmRebuild\(edgeCount\)\) trigger\.mutate\(\)/.test(button),
      "the label reads lighter than the act");
    // Scoped to this dialog's wording. A blanket ban on window.confirm catches
    // "Remove this from the dashboard?", which is a different question that has
    // every right to its own prompt.
    check("  and neither keeps its own copy of this wording",
      !/Run a full GitHub recrawl/.test(page + overview),
      "two copies drift, and the quieter one is the one people meet");


    check("  the dialog says what it re-reads",
      /Run a full GitHub recrawl\?/.test(dialog)
        && /stored connections/.test(dialog));
    check("  and quantifies it where the count is known",
      /edgeCount\.toLocaleString\(\)/.test(dialog),
      '"everything currently stored" is the fallback, not the usual case');
    for (const [what, re] of [
      ["how long it takes", /Takes several minutes/],
      // Worded as a rate limit, not a "budget": the first reader of this
      // dialog asked whether it meant money. It means requests.
      ["that it draws on a shared rate limit", /shared GitHub rate limit/],
      ["that the cost lands on everyone", /the app down for everyone/],
      ["that closing the app stops it", /leave it open until it finishes/],
      // The cadence has been wrong twice. Asserted against the words, and
      // repro-recrawl.ts checks those words against the stack's own schedule.
      ["that waiting would have done it anyway", /automatically every night at 10pm Eastern/],
      ["that there is a limit on how often", /At most one an hour/],
    ] as [string, RegExp][]) {
      check(`  it states ${what}`, re.test(dialog));
    }
    check("  and cancelling starts nothing",
      !/trigger\.mutate\(\)/.test(button.replace(/if \(confirmRebuild[^\n]*\n/, "")),
      "the mutation must be reachable only through the confirmation");

    // The two buttons must not look alike: one re-reads a stored answer in a
    // second, the other re-reads the organization over several minutes.
    // Both pages get this from the one component, so it is asserted there.
    check("the recrawl button is styled apart from refresh",
      /variant="caution"/.test(button));
    check("  and is named for what it does",
      /"Full GitHub recrawl"/.test(button),
      '"Sync data" read as a refresh');
    check("  while saying so when somebody else is already recrawling",
      /Recrawling, this takes a few minutes/.test(button)
        && /recrawl\?\.running/.test(button),
      "this was local pending state, invisible to everyone but the clicker");
  }

  /**
   * The row has to be allowed to be narrower than what is in it.
   *
   * These rows are laid out in a `grid`, and a grid item's `min-width` defaults
   * to `auto`, which resolves to its *min-content* size. One person in twenty
   * teams therefore sized the whole track to fit the joined list, the page grew
   * a horizontal scrollbar, and the `truncate` on that line never did anything
   * — nothing was ever narrower than the text, so there was nothing to clip.
   *
   * It read as theme-specific and was not: the themes with a narrow `--page-max`
   * showed it first, and Quiet hid it completely because its `grid-cols-*`
   * override already rewrites tracks to `minmax(0, 1fr)`.
   */
  console.log("\na long row cannot widen the page");
  {
    const design = fs.readFileSync("./src/design/index.tsx", "utf8");
    /** One exported function's source, up to wherever the next one begins. */
    const body = (name: string) => {
      const from = design.indexOf(`export function ${name}`);
      if (from < 0) return "";
      const next = design.indexOf("\nexport ", from + 1);
      return design.slice(from, next < 0 ? undefined : next);
    };

    check("a list row may be narrower than its contents",
      /min-w-0/.test(body("RailCard")),
      "without this a grid track sizes to the longest unbreakable string in it");

    check("  and so may an inset row",
      /min-w-0/.test(body("InsetRow")));

    const page = fs.readFileSync("./src/pages/AccessPage.tsx", "utf8");

    /**
     * Ellipsis alone would cut a team name mid-word and lose the only number
     * that is actionable — how many there are. The names are what gets dropped.
     */
    check("a person's teams are summarized rather than joined in full",
      /function teamSummary/.test(page) && /\+\$\{rest\} more/.test(page),
      "twenty joined names is a string no row can hold at any width");

    check("  and the row still truncates underneath that",
      /teamSummary\(person\.teams\)/.test(page)
      && /truncate"\s*\n\s*title=\{person\.teams/.test(page),
      "one team can be named anything, so the cap is not a guarantee");

    check("  with the full list still reachable",
      /title=\{person\.teams\.length === 0 \? undefined : person\.teams/.test(page));

    check("and the drawer's line is capped too, just higher",
      /teamSummary\(data\.teams, 8\)/.test(page),
      "more room there than in a row, but not room for thirty");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
