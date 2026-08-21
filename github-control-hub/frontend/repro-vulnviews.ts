/**
 * The Vulnerabilities tab, split into three views.
 *
 * It used to be one column: every vulnerable repository, then the Dependabot
 * email settings, then Renovate, then the Renovate email settings. Reaching
 * Renovate meant scrolling past the whole of Dependabot — a page of repository
 * cards, fifteen at a time — which put the two halves of one question at
 * opposite ends of a scroll bar and made the second half easy to miss entirely.
 *
 * What is asserted here is the part that would quietly rot: that each view
 * still renders exactly once and in one place, that the URL carries the choice,
 * and that nothing on one view waits for data belonging to another. That last
 * one is the same fault as the scroll, wearing a different hat — an early
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
    check("Renovate is rendered on its own view",
      /\{view === "updates" && <RenovatePanel \/>\}/.test(page));
    check("  and only there — not also stacked under the alerts",
      count(/<RenovatePanel \/>/g) === 1, count(/<RenovatePanel \/>/g));

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
    // Labelled by tool rather than by noun — what people call them.
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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
