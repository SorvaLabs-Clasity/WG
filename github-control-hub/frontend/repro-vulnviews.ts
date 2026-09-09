/**
 * The Vulnerabilities tab, split into three views.
 *
 * It used to be one column: every vulnerable repository, then the Dependabot
 * email settings, then Renovate, then the Renovate email settings. Reaching
 * Renovate meant scrolling past the whole of Dependabot, a page of repository
 * cards, fifteen at a time, which put the two halves of one question at
 * opposite ends of a scroll bar and made the second half easy to miss entirely.
 *
 * What is asserted here is the part that would quietly rot: that each view
 * still renders exactly once and in one place, that the URL carries the choice,
 * and that nothing on one view waits for data belonging to another. That last
 * one is the same fault as the scroll, wearing a different hat, an early
 * return on the Dependabot fetch made opening Renovate wait for a list it does
 * not use.
 *
 * Run:  npx tsx repro-vulnviews.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const page = fs.readFileSync("./src/pages/DependencyDashboardPage.tsx", "utf8");
const count = (re: RegExp) => (page.match(re) ?? []).length;

(async () => {
  // ── one home each ───────────────────────────────────────────────────
  {
    /**
     * One view again. It was split into pull requests and a dependency
     * dashboard, which is the same subject cut down the middle: an update
     * Renovate errored on and one it raised last week are the same question at
     * two moments, and answering them in separate tabs meant checking both to
     * learn where a repository stood. They are joined on the branch now.
     */
    check("Renovate is rendered on its own view",
      /\{view === "updates" && <RenovatePanel \/>\}/.test(page));
    check("  and only there, not also stacked under the alerts",
      count(/<RenovatePanel \/>/g) === 1, count(/<RenovatePanel \/>/g));

    // The split is gone rather than hidden: no second component, and no
    // switcher choosing between them.
    check("  with no separate dashboard view to switch to",
      !/RenovateDashboardPanel/.test(page) && !/renovateView/.test(page));

    check("both notification panels sit together on one view",
      /view === "notifications" &&[\s\S]{0,240}feed="dependabot-alert"[\s\S]{0,200}feed="renovate-pr"/.test(page),
      '"who gets told" is one question, not half a question on each of two views');
    check("  and each panel appears exactly once",
      count(/feed="dependabot-alert"/g) === 1 && count(/feed="renovate-pr"/g) === 1);

    check("the alerts view still holds the repository list",
      /view === "alerts" &&[\s\S]{0,200}<StatusSlab/.test(page));
  }

  // ── the choice lives in the URL ─────────────────────────────────────
  {
    check("the view is a URL parameter, so it survives a refresh",
      /useSearchParams/.test(page) && /params\.get\("view"\)/.test(page));
    check("  an unrecognized one falls back rather than rendering nothing",
      /VIEWS\.includes\(raw\) \? raw : "alerts"/.test(page));
    check("  and the default view leaves no parameter behind",
      /if \(v === "alerts"\) next\.delete\("view"\)/.test(page),
      "?view=alerts is noise in a shared link");
    check("  replacing rather than pushing, so Back leaves the page",
      /\{ replace: true \}/.test(page),
      "otherwise Back walks through every tab you looked at");
  }

  // ── no view waits for another view's data ───────────────────────────
  {
    check("the Dependabot fetch no longer blocks the whole page",
      !/if \(depsLoading \|\| sumLoading\) return <Page/.test(page),
      "an early return here made opening Renovate wait for the alert list");
    check("  its spinner belongs to the alerts view",
      /view === "alerts" && \(alertsLoading \? <Spinner \/>/.test(page));

    check("refreshing refreshes the view you are on",
      /view === "updates"\s*\n?\s*\? refetchRenovate\(\)/.test(page),
      "refetching all three would spend rate limit on views nobody has open");
  }

  // ── the tabs say how much is behind them ────────────────────────────
  {
    // Labelled by tool rather than by noun, what people call them.
    check("the alert count is on the Dependabot tab",
      /counts\.total > 0 \? `Dependabot \$\{counts\.total\}`/.test(page));
    check("  and the open pull request count on the Renovate one",
      /renovateOpen > 0 \? `Renovate \$\{renovateOpen\}`/.test(page));
    check("  with zero shown as no number rather than a zero",
      /: "Dependabot"/.test(page) && /: "Renovate"/.test(page),
      '"Renovate 0" reads as a problem; "Renovate" reads as a place to look');
    check("  while the view ids stay put, so existing links still work",
      /\["alerts", counts/.test(page) && /\["updates", renovateOpen/.test(page));

    // The panel fetches this itself; the page asks for the count under the same
    // key so React Query serves both from one request.
    check("the count reuses the panel's query rather than fetching twice",
      /queryKey: \["renovate"\]/.test(page)
      && /queryKey: \["renovate"\]/.test(fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8")));
  }

  console.log("\nthe Renovate panel is built from the app's design system");
  {
    /**
     * The mistake three rewrites of this panel made, and the only one that
     * mattered.
     *
     * Each was styled from scratch: hand-mixed hex greys, its own radii, its
     * own type sizes, hard-coded row heights, no shadow and no motion. Each was
     * defensible on its own and each looked like a different application when
     * placed next to the rest of the product, which is what "sloppy" meant.
     *
     * `tokens.ts` records the agreed direction, saturated colour and depth and
     * motion with colour only ever carrying meaning, and every other page is
     * built from `SURFACE`, `TYPE` and `INTENT`. This asserts that this panel
     * is too, because nothing else stops the next rewrite doing it again.
     */
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");

    check("it draws its surfaces from the system",
      /SURFACE\.card/.test(panel) && /SURFACE\.inset/.test(panel),
      "a bespoke surface is why it read as a different app");
    check("  its type from the system",
      /TYPE\.metricSm/.test(panel) && /TYPE\.heading/.test(panel) && /TYPE\.label/.test(panel));
    check("  and its state colours from the system",
      /INTENT\[/.test(panel) && /intent: "danger"/.test(panel) && /intent: "good"/.test(panel),
      "an error here must be the same red as an error anywhere else");

    // The app's entrance animation. The direction is "saturated colour, depth
    // and motion"; the previous version had none of the three.
    check("  with the same entrance as every other list",
      /enter\(/.test(panel));

    /**
     * No hand-mixed colour. Every previous version defined its own greys and
     * hues as literals, which is precisely how it drifted: a palette that lives
     * in one component cannot follow the theme the rest of the app follows.
     */
    const hexes = panel.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    check("  and no colour invented inside the component",
      hexes.length === 0, hexes);

    // Row heights and radii were pinned in pixels, against an app built on the
    // Tailwind scale, which is why nothing lined up with anything around it.
    check("  no hard-coded row height",
      !/h-\[\d+px\]/.test(panel), "fixed pixel rows do not match the app's rhythm");
    check("  and no bespoke radius",
      !/rounded-\[\d/.test(panel), "the app's radii are rounded-lg, -xl and -2xl");
  }

  console.log("\nthe Renovate flaps open the way somebody left them");
  {
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");

    /**
     * Two spans, and they are not the same one.
     *
     * "Only the top one open" is wanted on the first open *per app launch*.
     * After that it has to be however it was left, and the tab unmounts every
     * time somebody switches away from it, so component state would re-collapse
     * whatever they had just expanded the moment they came back. Module scope
     * survives a remount and still resets on relaunch, which is exactly the
     * span asked for.
     */
    check("the collapsed set outlives the component",
      /^let sessionShut: Set<string> \| null = null;/m.test(panel),
      "component state would re-collapse everything on every tab switch");
    check("  and is seeded from it on mount",
      /useState<Set<string>>\(\(\) => sessionShut \?\? new Set\(\)\)/.test(panel));
    check("  and written back on every change",
      /sessionShut = next/.test(panel),
      "state that is not written back is forgotten at the next tab switch");

    // null is "this session has not opened the tab"; an empty set is the real
    // answer "nothing is collapsed". Collapsing the two reapplies the default
    // forever, which is the bug this guards.
    check("  a first open is told apart from nothing being collapsed",
      /sessionShut !== null/.test(panel),
      "an empty set is a real answer, not an uninitialised one");

    check("everything but the first is collapsed on a first open",
      /new Set\(\[\.\.\.queueRepos\.slice\(1\), QUIET_KEY\]\)/.test(panel),
      "slice(1) keeps the top one open and closes the rest");

    // The list is not known until the queries answer, and the effect that reads
    // it is a hook, so it cannot sit after the early returns below it.
    check("  computed before the conditional returns, since a hook cannot follow one",
      panel.indexOf("const queueRepos = useMemo") < panel.indexOf("if (prs.isLoading"));
  }

  console.log("\nthe first row is not flush against its heading");
  {
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");
    // The version this was reported against stacked a 26px row straight onto a
    // 22px header button with no padding on either, so the first item in every
    // expanded repository touched the heading above it.
    check("the expanded list has room at the top",
      /px-4 pt-1 pb-4 grid gap-1\.5/.test(panel));
  }

  console.log("\nrepositories Renovate has never touched are listed too");
  {
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");

    /**
     * The sweep is a search for issues the bot wrote, so it can only return
     * repositories Renovate is already active on. A repository it has never
     * touched is invisible to it, which is why this cannot come from the sweep
     * and has to come from the organization's own repository list.
     */
    check("the full repository list comes from the access map",
      /useAccessRepos\(true\)/.test(panel),
      "the sweep can only ever return repositories Renovate already writes to");
    check("  and the quiet ones are what it does not cover",
      /const active = new Set\(\[\.\.\.dashboards\.map/.test(panel)
        && /filter\(r => !active\.has\(r\)\)/.test(panel));

    /**
     * The honesty this screen turns on. Renovate can be perfectly well
     * onboarded with `dependencyDashboard` off, and with nothing outstanding it
     * then looks identical to a repository Renovate has never been near. The
     * heading and the copy must not claim to tell those apart.
     */
    check("  described as nothing seen, not as Renovate being off",
      /No Renovate activity/.test(panel) && !/Renovate is disabled|not enabled/.test(panel),
      "absence of a dashboard is not proof that Renovate is off");
    check("  and the ambiguity is stated rather than left implied",
      /it is not proof/.test(panel) && /dependencyDashboard/.test(panel));

    // It is not part of the queue, so a lens that narrows the queue must not
    // appear to have narrowed this.
    check("  hidden while a lens is narrowing the queue",
      /\{!lens && quiet\.length > 0/.test(panel));

    // Remembered the same way the repositories are, so one mechanism covers
    // every flap on the page.
    check("  and it remembers its own state like the rest",
      /toggle\(shut, QUIET_KEY, setShut\)/.test(panel));
  }

  console.log("\neverything in the Renovate queue opens where it lives");
  {
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");

    // Electron sends target="_blank" to the system browser, so an anchor is all
    // that is needed. What matters is that every one of them has one.
    check("the repository name opens the repository",
      /href=\{org \? `https:\/\/github\.com\/\$\{org\}\/\$\{repo\}` : undefined\}/.test(panel));

    /**
     * A row backed by a pull request opens the pull request; one that exists
     * only on the dashboard opens the dashboard issue, which is the only place
     * it is written down. Falling back to nothing would leave the rows that are
     * hardest to find the only ones with no way to reach them.
     */
    check("  and every row opens whatever it is about",
      /const href = r\.pr\?\.url \?\? dashboard\?\.url;/.test(panel));

    // Nesting a link inside a button is invalid, and making the whole bar a
    // link would take away the collapse, which is used far more often.
    check("  the heading is two controls rather than one",
      /aria-label=\{`\$\{open \? "Collapse" : "Expand"\} \$\{repo\}`\}/.test(panel),
      "a link cannot live inside a button");

    const blanks = panel.match(/target="_blank"[^>]*/g) ?? [];
    check("  and each opens outside the app safely",
      blanks.length >= 3 && blanks.every(a => /rel="noreferrer noopener"/.test(a)),
      blanks.filter(a => !/rel=/.test(a)));
  }

  console.log("\nevery Renovate action is confirmed first");
  {
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");
    const design = fs.readFileSync("./src/design/index.tsx", "utf8");

    /**
     * These instruct a bot to act on somebody else's repository, several of
     * them in bulk, and none of it can be undone from this screen.
     */
    check("no action reaches the server straight from a click",
      !/onClick=\{\(\) => act\(/.test(panel),
      "every one of these is a request a bot carries out later");
    check("  the row actions ask first", /onClick=\{\(\) => setPending\(\{[\s\S]{0,200}issueNumber: r\.issueNumber/.test(panel));
    check("  and so do the bulk ones",
      /onClick=\{\(\) => setPending\(\{[\s\S]{0,160}issueNumber: dashboard\.issueNumber/.test(panel));

    // Not the native one. Electron implements its own dialog handling, which is
    // how the bulk-close button was silently dead for a release.
    check("  through the app's own dialog, not the browser's",
      /<ConfirmDialog/.test(panel)
        && !/window\.confirm\(/.test(panel) && !/window\.prompt\(/.test(panel));
    check("  which lives in the design system rather than in this panel",
      /export function ConfirmDialog/.test(design));

    // A dialog that closes on the click leaves the button looking untouched for
    // the second the call takes, which reads as nothing having happened.
    check("  and stays open until the request finishes",
      /\.finally\(\(\) => setPending\(null\)\)/.test(panel));

    /**
     * The copy is the point of having a dialog at all. Every one of these ticks
     * a checkbox that a bot reads later, and "Approve" is the most misreadable
     * word on the screen: it looks like a pull request review and is not one.
     */
    check("the dialog says a bot acts later, not now",
      /Renovate reads it on its next run/.test(panel));
    check("  and that approving here is not a review",
      /This is not a pull request review/.test(panel));
    check("  and that a bulk action covers every match",
      /applies to every matching update/.test(panel));
  }

  console.log("\nan action GitHub would refuse is not offered as though it would work");
  {
    const panel = fs.readFileSync("./src/components/RenovatePanel.tsx", "utf8");
    const route = fs.readFileSync("../backend/src/routes/dependencies.ts", "utf8");
    const me = fs.readFileSync("../backend/src/routes/me.ts", "utf8");

    /**
     * The request runs as the person pressing the button, not as the app, so
     * GitHub refuses it without write access to the repository. That is the
     * right design, and it means the screen can know the answer in advance.
     */
    check("the tick runs as the caller, not as the app",
      /const token = req\.user\?\.accessToken;/.test(route)
        && /createOctokit\(token, "Renovate dependency dashboards"\)/.test(route),
      "the app's own token would let anybody act on any repository");

    check("  where somebody may write is served from the stored graph",
      /writableRepos: writable\.map/.test(me));
    check("  and the control says why it is unavailable",
      /title=\{writable \? undefined : NO_WRITE\(repo\)\}/.test(panel)
        && /You need write access to \$\{repo\}/.test(panel));

    /**
     * The direction that matters. An unbuilt graph returns an empty list, and
     * reading that as "writes nowhere" would disable every control for
     * everybody. Unknown has to mean "do not narrow".
     */
    check("  while not knowing never disables anything",
      /if \(!myAccess \|\| myAccess\.unknown\) return true;/.test(panel),
      "an empty list is not the same answer as no data");

    // And when it is attempted anyway, the refusal has to say which permission,
    // on what, and that nothing was changed.
    check("a refusal explains itself rather than saying authorization failed",
      /status === 403 \|\| status === 404/.test(route)
        && /Nothing was changed/.test(route));
  }

  console.log("\na bulk Dependabot run reports itself while it runs");
  {
    const mgr = fs.readFileSync("./src/components/DependabotManager.tsx", "utf8");
    const design = fs.readFileSync("./src/design/index.tsx", "utf8");

    /**
     * Sixty repositories is a minute or more of paced writes. What was there
     * was a button reading "Working…" and nothing else: no count, no idea which
     * repository, no way to tell a slow run from a stuck one, and every result
     * withheld until the last one landed.
     */
    check("the run is sent in batches rather than one long request",
      /const CHUNK = 4;/.test(mgr) && /repos\.slice\(i, i \+ CHUNK\)/.test(mgr),
      "one request for two hundred repositories outlives the connection");

    /**
     * The bar has to be real. A timer-driven one that reaches the end and waits
     * is worse than no bar, because it says the opposite of what is happening.
     */
    check("  and the bar advances only when a batch actually returns",
      /setProgress\(p => \(p \? \{ \.\.\.p, done, lines: \[\.\.\.lines\] \} : p\)\)/.test(mgr));
    check("  with no timer driving it",
      !/setInterval|setTimeout/.test(mgr),
      "a bar on a timer reports progress that is not happening");

    // A batch that never reached GitHub still has to be reported per
    // repository, or the run silently covers fewer than it claims.
    check("  a failed batch is named per repository rather than thrown away",
      /batch\.map\(repo => \(\{ repo, ok: false, note \}\)\)/.test(mgr));

    // Closing mid-run would hide a run that is still going, and the next thing
    // somebody does is press the button again.
    check("  the window cannot be dismissed while it is running",
      /dismissible=\{!running\}/.test(design));

    check("every one of the actions goes through it",
      /runBatched<BulkSummary>/.test(mgr) && /runBatched<RolloutSummary>/.test(mgr)
        && /runBatched<CloseSummary>/.test(mgr),
      "an action without it is the one that looks frozen");

    // Retrying should redo the ones that failed, not the whole list again.
    check("  and only the failures stay selected afterwards",
      /const keepFailures = \(lines: ProgressLine\[\]\)/.test(mgr));

    // The shell is shared, so the backdrop, the Escape handling and the scroll
    // lock cannot drift between the two dialogs.
    check("both dialogs share one shell",
      /function ModalShell\(/.test(design)
        && (design.match(/<ModalShell/g) ?? []).length === 2);

    // Same preference as the Renovate tab: not the browser's dialogs.
    check("and nothing here uses a native dialog",
      !/window\.confirm\(|[^.]\bconfirm\(/.test(mgr) && !/window\.prompt\(/.test(mgr),
      "Electron's dialog handling is its own, and prompt is not implemented at all");
  }

  console.log("\na run can be stopped, and undone only where that is true");
  {
    const mgr = fs.readFileSync("./src/components/DependabotManager.tsx", "utf8");
    const design = fs.readFileSync("./src/design/index.tsx", "utf8");

    // Read between batches by a running async function. State would be the
    // value it closed over when it started, which is false for the whole run.
    check("the stop flag is a ref, not state",
      /const cancelRef = useRef\(false\);/.test(mgr)
        && /if \(cancelRef\.current\) \{ stopped = true; break; \}/.test(mgr),
      "state read inside a running loop never changes");

    /**
     * The distinction this turns on. Only the switches have a true inverse, and
     * the repositories already reached are known exactly, so "cancel and undo"
     * is a promise that can be kept. The other three cannot be undone from
     * here, and dressing them alike would be a promise that is not.
     */
    check("the four switches offer to undo",
      /"alerts-on": \{ action: "alerts-off"/.test(mgr)
        && /"fixes-off": \{ action: "fixes-on"/.test(mgr));
    check("  and undo what was changed, not what was selected",
      /const changed = lines\.filter\(l => l\.ok\)\.map\(l => l\.repo\);/.test(mgr),
      "a repository that failed was never changed and must not be switched the other way");

    /**
     * The undo reads the same flag the stop set, so without clearing it first
     * it breaks on its own first batch and puts nothing back, having just
     * promised to.
     */
    check("  with the stop flag cleared before the undo runs",
      /cancelRef\.current = false;\s*\n\s*const back = await runBatched/.test(mgr),
      "the undo would stop itself immediately");

    /**
     * Writing a file and closing a pull request cannot be taken back from here.
     * A closed Dependabot pull request is the worst of them: GitHub treats the
     * close as `@dependabot close` and will not raise it again.
     */
    check("  while the writes only offer to stop",
      /\{ label: "Stop", note: mode === "pr"/.test(mgr)
        && /\{ label: "Stop",\s*\n\s*note: "Stopping leaves the ones already closed/.test(mgr));
    check("  and say what stays done",
      /Stopping leaves the pull requests already opened/.test(mgr)
        && /Stopping leaves the commits already made/.test(mgr)
        && /Dependabot will not raise those again/.test(mgr));

    // The label belongs to the caller, because the two cases are different and
    // must not be dressed alike.
    check("the dialog takes the wording rather than choosing it",
      /cancel\?: \{ label: string; note\?: string; run: \(\) => void; pending\?: boolean \}/.test(design));
  }

  console.log("\na repository that cannot be switched says why");
  {
    const bulk = fs.readFileSync("../backend/src/services/dependabotBulk.ts", "utf8");
    const view = fs.readFileSync("../backend/src/services/dependencyView.ts", "utf8");
    const mgr = fs.readFileSync("./src/components/DependabotManager.tsx", "utf8");

    /**
     * Every 403 was reported as "You do not have admin access to this
     * repository", which is the common cause and was wrong for the two that
     * actually come up: an archived repository refuses every settings change,
     * and one with the dependency graph off cannot have alerts at all. Both
     * were blamed on the person pressing the button.
     */
    check("the reason is asked for rather than assumed",
      /async function explainRefusal\(/.test(bulk)
        && /octokit\.rest\.repos\.get\(\{ owner: org, repo \}\)/.test(bulk));
    check("  archived is named",
      /GitHub refuses every settings change on an archived/.test(bulk));
    check("  and so is the dependency graph",
      /dependency_graph\?\.status === "disabled"/.test(bulk)
        && /The dependency graph is off for this repository/.test(bulk),
      "alerts are built on it, so this is not a permission problem");

    // Only for a repository that has already failed, so a clean run pays
    // nothing for it.
    check("  and only asked after a failure",
      /if \(status === 403 \|\| status === 422\) \{/.test(bulk));

    // And when the read itself fails, it falls back to GitHub's own words
    // rather than inventing a reason, which is the mistake being undone.
    check("  falling back to what GitHub said when it cannot ask",
      /the mistake this function exists to undo/.test(bulk));

    // Said before the button is pressed, not only after it fails.
    check("archived is visible in the list up front",
      /if \(r\.archived\) row\.archived = true;/.test(mgr)
        && />\s*archived\s*<\/span>/.test(mgr));
    check("  stamped from the same query that reads the switches",
      /if \(facts\.get\(row\.repo\)\?\.archived\) row\.archived = true;/.test(view));

    // A failed facts query returns null, and marking every repository
    // unarchived on the strength of that is an assertion nobody made.
    check("  and never guessed from a failed read",
      /if \(facts\) \{/.test(view));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
