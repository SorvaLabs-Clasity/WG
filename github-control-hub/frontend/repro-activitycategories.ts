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
import { categoryOf, countByCategory, FALLBACK_CATEGORY, type ActivityCategory } from "./src/lib/activityCategories";

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

  // This application's own configuration.
  ["widget.create", "app"], ["widget.update", "app"], ["widget.delete", "app"],
  ["scanner.create", "app"], ["scanner.update", "app"], ["scanner.delete", "app"],
  ["config.import", "app"],
  ["exclusion.create", "app"], ["exclusion.update", "app"], ["exclusion.delete", "app"],
  ["template.create", "app"], ["template.update", "app"], ["template.delete", "app"],
  ["activity.undo", "app"], ["activity.redo", "app"], ["activity.retry", "app"],

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
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
