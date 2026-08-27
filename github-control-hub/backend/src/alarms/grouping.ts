/**
 * How a burst of events becomes a small number of emails.
 *
 * The failure this exists to stop: a team added to a hundred repositories fires
 * a hundred webhooks, and a hundred separate emails arrive for one thing
 * somebody did once. The same shape appears when an advisory lands on every
 * repository that shares a dependency, and when Dependabot is switched on for a
 * repository that has been accumulating alerts for a year.
 *
 * Those three cases group differently, and that is the whole design:
 *
 *   one actor, many repositories   ->  group by what was done and who did it
 *   one advisory, many repositories ->  group by the advisory
 *   one repository, many advisories ->  group by the repository
 *
 * So rather than a fixed key, the axis is chosen per burst: whichever produces
 * fewer groups is the one that describes what happened. A hundred rows becomes
 * one email either way; which axis was used decides whether its subject reads
 * "left-pad affects 100 repositories" or "api-service has 30 new alerts".
 */

export interface Groupable {
  /** The repository an event is about. */
  repo: string;
  /** What the event is about: an advisory name, an alert type. */
  subject: string;
  /** Who caused it, where that is known and meaningful. */
  actor?: string;
}

export type Axis = "subject" | "repo";

/**
 * The axis that describes this burst.
 *
 * Ties go to the subject. One row is a tie between "one repository" and "one
 * advisory", and naming the advisory is more useful than naming the repository
 * somebody is already looking at.
 */
export function chooseAxis<T extends Groupable>(rows: T[]): Axis {
  const subjects = new Set(rows.map(r => r.subject)).size;
  const repos = new Set(rows.map(r => r.repo)).size;
  return subjects <= repos ? "subject" : "repo";
}

/** The rows of one burst, grouped along the axis that describes it. */
export function groupBurst<T extends Groupable>(rows: T[]): {
  axis: Axis;
  groups: Array<{ key: string; rows: T[] }>;
} {
  const axis = chooseAxis(rows);
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const k = axis === "subject" ? r.subject : r.repo;
    const list = by.get(k);
    if (list) list.push(r); else by.set(k, [r]);
  }
  // Largest first: the group that affected most is the one to read first.
  const groups = [...by.entries()]
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
  return { axis, groups };
}

/**
 * How many of a list to name before counting the rest.
 *
 * A digest naming a hundred repositories is a wall nobody reads, and SNS has
 * its own size limit besides. Twelve is enough to recognise a pattern, and the
 * count carries the scale.
 */
export const NAMED_LIMIT = 12;

export function nameAndCount(names: string[], limit = NAMED_LIMIT): string {
  const unique = [...new Set(names)].sort();
  if (unique.length <= limit) return unique.join(", ");
  return `${unique.slice(0, limit).join(", ")} and ${unique.length - limit} more`;
}

/**
 * One line describing a burst, for a subject line.
 *
 * Deliberately says what happened rather than how many rows there were. "Team
 * added to 100 repositories" is a thing somebody did; "100 team_added events"
 * is a description of the plumbing.
 */
export function describeBurst<T extends Groupable>(
  rows: T[], axis: Axis, key: string,
): string {
  const repos = new Set(rows.map(r => r.repo)).size;
  const subjects = new Set(rows.map(r => r.subject)).size;

  if (axis === "subject") {
    return repos === 1
      ? `${key} on ${[...new Set(rows.map(r => r.repo))][0]}`
      : `${key} across ${repos} repositories`;
  }
  return subjects === 1
    ? `${[...new Set(rows.map(r => r.subject))][0]} on ${key}`
    : `${subjects} findings on ${key}`;
}

/** How bad a severity is, for sorting and for picking the worst of a group. */
export const SEVERITY_RANK: Record<string, number> = {
  critical: 4, high: 3, medium: 2, moderate: 2, low: 1,
};

/**
 * The worst severity present, or undefined if none of them carried one.
 *
 * A digest spanning a critical and two lows is a critical email. Reporting
 * "3 severities" would be accurate and useless, and reporting whichever arrived
 * first would sometimes downgrade a critical to a low in the subject line,
 * which is the one direction this must never round.
 */
export function worstSeverity(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    if (!v) continue;
    const rank = SEVERITY_RANK[v.toLowerCase()] ?? 0;
    if (best === undefined || rank > (SEVERITY_RANK[best.toLowerCase()] ?? 0)) best = v;
  }
  return best;
}
