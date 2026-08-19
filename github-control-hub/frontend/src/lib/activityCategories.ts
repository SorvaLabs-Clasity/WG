/**
 * Which stream an activity row belongs to.
 *
 * The feed was one undifferentiated list, so a widget being renamed sat beside
 * branch protection being removed. Those are not the same kind of event and
 * nobody reads them for the same reason: one is somebody tidying their
 * dashboard, the other is a security control disappearing.
 *
 * Four streams, because four things write here:
 *
 *   github  changes to the organization — branches, protection, rulesets,
 *           repositories, Dependabot. Some done through this app, some caught
 *           by webhook after somebody did them on github.com.
 *   aws     the guardrail engine, which runs in Lambda and writes `aws.guardrail`
 *           rows. Note that action is not in the ActivityAction union — the
 *           Lambda writes the string directly.
 *   app     this application's own configuration: widgets, scanners, imports.
 *           Housekeeping. Real, and not why anyone opens an audit trail. Also
 *           the `sync.*` collection runs — when the app last went and looked,
 *           who asked it to, and what came back.
 *   audit   the enterprise audit log. `audit.event` is already in the union,
 *           reserved before anything wrote it.
 *
 * Kept as data rather than a switch so repro-activitycategories.ts can assert
 * every known action lands somewhere deliberate, rather than defaulting.
 */

export type ActivityCategory = "github" | "aws" | "app" | "audit";

/**
 * "all" is a view, not a category.
 *
 * No row is ever classified as "all" — `categoryOf` still returns one of the
 * four. Keeping it out of ActivityCategory is what stops it becoming a fifth
 * bucket that rows could accidentally land in, and keeps the exhaustiveness
 * check in repro-activitycategories.ts meaningful.
 */
export type ActivityView = ActivityCategory | "all";

export const CATEGORY_ORDER: ActivityCategory[] = ["github", "aws", "app", "audit"];

/** Tab order: everything first, then the four streams it is made of. */
export const VIEW_ORDER: ActivityView[] = ["all", ...CATEGORY_ORDER];

export const CATEGORY_LABELS: Record<ActivityView, string> = {
  all: "Everything",
  github: "Organization",
  aws: "AWS",
  app: "App settings",
  audit: "Audit log",
};

/** Which sources a row in each stream can actually carry. */
export const CATEGORY_SOURCES: Record<ActivityCategory, Array<"app" | "github" | "audit">> = {
  // The only stream written from both directions: this app makes a change, or
  // a webhook reports one somebody made on github.com.
  github: ["app", "github"],
  // The guardrail Lambda writes these itself.
  aws: ["app"],
  app: ["app"],
  audit: ["audit"],
};

/**
 * Prefixes, longest-match-wins, so `template.apply` can differ from
 * `template.create` — applying a template changed repositories, creating one
 * only changed a setting in this app.
 */
const PREFIXES: Array<[string, ActivityCategory]> = [
  ["aws.", "aws"],
  ["audit.", "audit"],

  // Collection runs: a sync, a sweep, a re-check. Housekeeping in the same sense
  // the rest of this bucket is — the app going and looking, rather than anything
  // in GitHub or AWS changing. Without a prefix here they would fall through to
  // the organization stream, where a six-hourly sync would sit between two
  // protection changes and push real events off the first page.
  ["sync.", "app"],

  // App configuration.
  ["widget.", "app"],
  ["scanner.", "app"],
  ["config.", "app"],
  ["exclusion.", "app"],
  ["template.create", "app"],
  ["template.update", "app"],
  ["template.delete", "app"],
  // Undo, redo and retry are records of someone operating this app. The row
  // they acted on keeps its own category and is marked `undone`, so the
  // organization stream still shows the truth about what was reversed.
  ["activity.", "app"],

  // Everything that changed GitHub.
  ["template.apply", "github"],
  ["branch.", "github"],
  ["repo.", "github"],
  ["github.", "github"],
  ["dependabot.", "github"],
  ["conflict.", "github"],
];

/**
 * An unrecognized action counts as an organization change.
 *
 * Defaulting the other way would hide something new in a tab nobody watches.
 * A stray housekeeping row in the organization feed is a small annoyance; a
 * missed protection change is the failure this whole app exists to prevent.
 */
export const FALLBACK_CATEGORY: ActivityCategory = "github";

export function categoryOf(action: string): ActivityCategory {
  let best: ActivityCategory | null = null;
  let bestLen = -1;
  for (const [prefix, category] of PREFIXES) {
    if (action.startsWith(prefix) && prefix.length > bestLen) {
      best = category;
      bestLen = prefix.length;
    }
  }
  return best ?? FALLBACK_CATEGORY;
}

/** Rows in each stream, in one pass. */
export function countByCategory(actions: string[]): Record<ActivityView, number> {
  const counts: Record<ActivityView, number> = { all: 0, github: 0, aws: 0, app: 0, audit: 0 };
  for (const a of actions) { counts[categoryOf(a)]++; counts.all++; }
  return counts;
}

/** Whether a row belongs in the current view. "all" holds everything. */
export function inView(action: string, view: ActivityView): boolean {
  return view === "all" || categoryOf(action) === view;
}

/**
 * The sources worth offering as a filter in this view.
 *
 * Returns fewer than two when filtering cannot change what is shown, so the
 * control can be hidden rather than offered. It was offered in every stream,
 * where in three of the four it could only ever empty the table: an audit row
 * is always source `audit`, and the dropdown listed only app and github.
 */
export function sourcesFor(view: ActivityView): Array<"app" | "github" | "audit"> {
  if (view === "all") {
    return [...new Set(CATEGORY_ORDER.flatMap(c => CATEGORY_SOURCES[c]))];
  }
  return CATEGORY_SOURCES[view];
}
