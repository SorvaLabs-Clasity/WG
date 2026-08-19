/**
 * Which stream each activity action belongs to.
 *
 * The feed mixed a widget being renamed with branch protection being removed,
 * so it was split four ways. The risk in splitting is that a row lands in a tab
 * nobody watches — which is worse than the mess, because at least the mess was
 * visible.
 *
 * So this asserts the classification of every action the backend can write,
 * enumerated from the ActivityAction union plus `aws.guardrail`, which the
 * guardrail Lambda writes as a raw string and which is not in that union.
 *
 * Run:  npx tsx repro-activitycategories.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import {
  categoryOf, countByCategory, FALLBACK_CATEGORY, inView, sourcesFor,
  CATEGORY_LABELS, CATEGORY_SOURCES, CATEGORY_ORDER, VIEW_ORDER,
  type ActivityCategory,
} from "./src/lib/activityCategories";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** Every action the backend writes, and where it must appear. */
const EXPECTED: Array<[string, ActivityCategory]> = [
  // Changed something about the organization.
  ["branch.create", "github"], ["branch.delete", "github"], ["branch.rename", "github"],
  ["branch.protect", "github"], ["branch.unprotect", "github"],
  ["repo.created", "github"], ["repo.publicized", "github"],
  ["repo.ruleset.create", "github"], ["repo.ruleset.delete", "github"], ["repo.ruleset.import", "github"],
  ["github.push", "github"], ["github.pr_opened", "github"], ["github.pr_merged", "github"],
  ["github.pr_closed", "github"], ["github.issue_opened", "github"],
  ["github.branch_protection_edited", "github"], ["github.ruleset_edited", "github"],
  ["dependabot.enable", "github"], ["dependabot.disable", "github"],
  ["conflict.pending", "github"], ["conflict.override", "github"], ["conflict.skip", "github"],
  // Applying a template changed repositories, so it belongs with the changes,
  // not with the settings that described it.
  ["template.apply", "github"], ["template.apply.repo", "github"],

  // The guardrail Lambda. Written as a raw string, absent from ActivityAction.
  ["aws.guardrail", "aws"],
  // The guardrail screens, which are in the union.
  ["aws.guardrail.create", "aws"], ["aws.guardrail.update", "aws"],
  ["aws.guardrail.delete", "aws"], ["aws.guardrail.run", "aws"],
  ["aws.guardrail.preview", "aws"],

  // This application's own configuration.
  ["widget.create", "app"], ["widget.update", "app"], ["widget.delete", "app"],
  ["scanner.create", "app"], ["scanner.update", "app"], ["scanner.delete", "app"],
  ["config.import", "app"], ["config.updated", "app"],
  ["exclusion.create", "app"], ["exclusion.update", "app"], ["exclusion.delete", "app"],
  ["template.create", "app"], ["template.update", "app"], ["template.delete", "app"],
  ["activity.undo", "app"], ["activity.redo", "app"], ["activity.retry", "app"],

  // Collection runs. Not changes to anything — the app going and looking.
  // Classified as housekeeping so a six-hourly sync cannot push a protection
  // change off the first page of the organization stream.
  ["sync.graph", "app"], ["sync.compliance", "app"], ["sync.query", "app"],
  ["sync.access", "app"], ["sync.scanner", "app"], ["sync.reminders", "app"],
  ["sync.alarms", "app"],

  ["audit.event", "audit"],
];

{
  let wrong: string[] = [];
  for (const [action, want] of EXPECTED) {
    const got = categoryOf(action);
    if (got !== want) wrong.push(`${action}: want ${want}, got ${got}`);
  }
  check(`all ${EXPECTED.length} known actions are classified deliberately`, wrong.length === 0, wrong);
}

// ── the two unions are one union ────────────────────────────────────
//
// ActivityAction is declared twice: once in the backend service that writes the
// rows, once in the frontend types that render them. Nothing links them, so a
// new action added on one side alone produces rows the feed cannot label — and
// because ACTION_CONFIG is a total Record over the frontend union, the failure
// shows up as an unlabelled badge rather than as a build error.
{
  // Paths from the working directory: this suite is run from frontend/, the
  // same as every other one here.
  const actionsIn = (file: string): string[] => {
    // Comments come off first. Both declarations carry explanatory comments, and
    // one of them mentions a filename ending in ".ts;" — which ended the parse
    // early and made the two unions look different when they were not. Reading
    // the quoted members after stripping comments has no such hazard.
    const src = fs.readFileSync(file, "utf8").replace(/\/\/[^\n]*/g, "");
    const start = src.indexOf("export type ActivityAction =");
    const end = src.indexOf(";", start);
    if (start < 0 || end < 0) throw new Error(`No ActivityAction union found in ${file}`);
    return [...src.slice(start, end).matchAll(/"([a-z0-9._]+)"/g)].map(m => m[1]).sort();
  };

  const backend = actionsIn("../backend/src/services/activityService.ts");
  const frontend = actionsIn("src/types/Activity.ts");

  const onlyBackend = backend.filter(a => !frontend.includes(a));
  const onlyFrontend = frontend.filter(a => !backend.includes(a));

  check(`both ActivityAction unions list the same ${backend.length} actions`,
    onlyBackend.length === 0 && onlyFrontend.length === 0,
    { onlyBackend, onlyFrontend });

  // And every one of them is classified, so the list above cannot fall behind
  // the union it is meant to cover.
  const unclassified = backend.filter(a => !EXPECTED.some(([e]) => e === a));
  check("  and every action in the union is in this file's expectations",
    unclassified.length === 0, unclassified);
}

// The two that differ only by suffix are the reason prefixes are longest-match.
{
  check("template.apply and template.create separate correctly",
    categoryOf("template.apply") === "github" && categoryOf("template.create") === "app",
    [categoryOf("template.apply"), categoryOf("template.create")]);
  check("  and template.apply.repo follows template.apply",
    categoryOf("template.apply.repo") === "github", categoryOf("template.apply.repo"));
}

// An action nobody has written yet must not vanish.
{
  check("an unknown action falls back rather than disappearing",
    categoryOf("something.invented.tomorrow") === FALLBACK_CATEGORY,
    categoryOf("something.invented.tomorrow"));
  check("  and the fallback is the stream people actually watch",
    FALLBACK_CATEGORY === "github", FALLBACK_CATEGORY);
  check("  including an empty action", categoryOf("") === FALLBACK_CATEGORY, categoryOf(""));
}

// A prefix must not swallow a longer, more specific one.
{
  check("aws.guardrail is not caught by a broader rule",
    categoryOf("aws.guardrail") === "aws", categoryOf("aws.guardrail"));
  check("activity.undo does not land in the organization stream",
    categoryOf("activity.undo") === "app", categoryOf("activity.undo"));
}

{
  const counts = countByCategory(["branch.protect", "widget.create", "aws.guardrail", "audit.event", "branch.delete"]);
  check("counts add up per stream",
    counts.github === 2 && counts.app === 1 && counts.aws === 1 && counts.audit === 1, counts);
  check("  and an empty feed counts zero everywhere",
    Object.values(countByCategory([])).every(n => n === 0), countByCategory([]));

  // The tab label has to agree with what the tab holds, or the count says one
  // thing and the table shows another.
  check("  the Everything count is the sum of the four streams",
    counts.all === counts.github + counts.app + counts.aws + counts.audit, counts);
}

// ── the combined view ─────────────────────────────────────────────────
{
  check("Everything holds a row from every stream",
    ["branch.protect", "widget.create", "aws.guardrail", "audit.event"]
      .every(a => inView(a, "all")));

  check("  while a single stream holds only its own",
    inView("branch.protect", "github") && !inView("widget.create", "github"));

  // "all" must not become a fifth bucket rows can be classified into, or the
  // exhaustiveness check above stops meaning anything.
  check("  and no action is ever classified as \"all\"",
    ["branch.protect", "widget.create", "aws.guardrail", "audit.event", "who.knows"]
      .every(a => (categoryOf(a) as string) !== "all"));

  check("  Everything is offered first, before the streams it merges",
    VIEW_ORDER[0] === "all" && VIEW_ORDER.length === CATEGORY_ORDER.length + 1, VIEW_ORDER);

  check("  and every view has a label",
    VIEW_ORDER.every(v => typeof CATEGORY_LABELS[v] === "string" && CATEGORY_LABELS[v].length > 0));
}

// ── the source filter, which used to be offered where it could only empty ──
{
  // Offered in all four streams, listing app and github. In the audit stream
  // every row is source `audit`, so either choice matched nothing: the filter
  // could only ever empty the table.
  check("a stream with one possible source does not offer the filter",
    sourcesFor("audit").length === 1 && sourcesFor("app").length === 1
      && sourcesFor("aws").length === 1,
    { audit: sourcesFor("audit"), app: sourcesFor("app"), aws: sourcesFor("aws") });

  check("  the organization stream does, being the only one written both ways",
    sourcesFor("github").length === 2
      && sourcesFor("github").includes("app") && sourcesFor("github").includes("github"),
    sourcesFor("github"));

  check("  and Everything offers each source once",
    sourcesFor("all").length === new Set(sourcesFor("all")).size
      && sourcesFor("all").includes("audit"),
    sourcesFor("all"));

  // The audit source was missing from the dropdown entirely, so audit rows
  // could not be isolated in the combined view even though they are the
  // majority of it.
  const everySource = new Set(CATEGORY_ORDER.flatMap(c => CATEGORY_SOURCES[c]));
  check("  covering every source any stream can produce",
    [...everySource].every(src => sourcesFor("all").includes(src)),
    { offered: sourcesFor("all"), exist: [...everySource] });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
