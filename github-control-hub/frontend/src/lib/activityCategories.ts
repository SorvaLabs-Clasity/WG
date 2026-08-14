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
 *           Housekeeping. Real, and not why anyone opens an audit trail.
 *   audit   the enterprise audit log. `audit.event` is already in the union,
 *           reserved before anything wrote it.
 *
 * Kept as data rather than a switch so repro-activitycategories.ts can assert
 * every known action lands somewhere deliberate, rather than defaulting.
 */

export type ActivityCategory = "github" | "aws" | "app" | "audit";

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  github: "Organization",
  aws: "AWS",
  app: "App settings",
  audit: "Audit log",
};

/**
 * Prefixes, longest-match-wins, so `template.apply` can differ from
 * `template.create` — applying a template changed repositories, creating one
 * only changed a setting in this app.
 */
const PREFIXES: Array<[string, ActivityCategory]> = [
  ["aws.", "aws"],
  ["audit.", "audit"],

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
export function countByCategory(actions: string[]): Record<ActivityCategory, number> {
  const counts: Record<ActivityCategory, number> = { github: 0, aws: 0, app: 0, audit: 0 };
  for (const a of actions) counts[categoryOf(a)]++;
  return counts;
}
