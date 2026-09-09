import { fetchOrgDependencyAlerts, fetchRepoFacts, fetchRepoFixStatus } from "./dependencyService";
import { fixBlockerFor, groupsSecurityUpdates } from "./dependencyBlockers";
import type { DependencyAlert } from "./dependencyService";
import { mockCleanAlert, mockDisabledAlert } from "./dependencyMarkers";

/**
 * The whole organization's Dependabot picture: findings, plus a marker for
 * every repository that produced none.
 *
 * A service rather than a function in the route, because two things build it
 * now: the tab, and the alarm pass when it keeps the stored copy warm. Two
 * copies would be two places for the repository markers and the two status
 * reads to drift, and the drift shows as a repository appearing clean on one
 * path and unwatched on the other, which is the single worst thing this screen
 * can say.
 *
 * `alerts` may be supplied by a caller that has already swept. The alarm pass
 * has, and re-sweeping there would spend the org-wide walk twice in one
 * invocation for identical data.
 *
 * Returns whether the sweep behind it was degraded, along with the rows. It
 * used to return the rows alone, which meant the one fact a caller needs before
 * *storing* this was the one fact it could not have: a sweep GitHub refused
 * comes back empty, the view is then nothing but "clean" markers, and stored as
 * authoritative it reports an organization with no findings at all. The alarm
 * pass already refused to store a degraded sweep, because it fetches its own
 * and can see the flag. The route paths could not, so they stored it.
 */
export async function buildDependencyView(
  octokit: any,
  org: string,
  opts: { alerts?: DependencyAlert[] } = {},
): Promise<{ rows: any[]; degraded: boolean }> {

  // The alert sweep failing should cost the alerts, not the page. Every
  // repository below is still listed with its Dependabot state, which is
  // most of what this screen is for, so a degraded sweep is tolerated
  // here, and reported rather than thrown. The alarm evaluator reads the
  // same function and treats `degraded` as "no reading", because an alarm
  // must not resolve itself off a sweep that never ran.
  // A caller that supplied its own alerts has already judged them; only a sweep
  // made here can be reported as degraded by here.
  const swept = opts.alerts ? null : await fetchOrgDependencyAlerts(octokit, org);
  const allAlerts: any[] = opts.alerts ?? swept!.alerts;
  const degraded = !!swept?.degraded;


  // Every repository's alert setting in a handful of requests.
  //
  // This was one REST call per repository, 351 of them on this
  // organization, every time the tab was opened. GraphQL carries the same
  // flag 100 repositories at a time, and on a different rate-limit budget
  // from everything else here.
  // The same query returns the repository list, so listRepos is not called
  // here at all. It would be four more REST pages fetching names GraphQL
  // has already handed over.
  const reposWithAlerts = new Set(allAlerts.map(a => a.repo));
  const facts = await fetchRepoFacts(
    (query, vars) => (octokit as any).graphql(query, vars), org);
  const alertStatus = facts && new Map([...facts].map(([n, f]) => [n, f.alertsEnabled]));

  // A failed status query means no markers rather than a wrong one:
  // labelling every repository "Dependabot off" would read as 355
  // findings nobody caused.
  for (const [name, enabled] of alertStatus ?? []) {
    if (reposWithAlerts.has(name)) continue;
    allAlerts.push(enabled ? mockCleanAlert(name, org) : mockDisabledAlert(name, org));
  }

  /**
   * Which of them also open pull requests.
   *
   * Read alongside the alert flag rather than per row, and stamped onto
   * every row of a repository so the table can offer the switch next to a
   * finding, which is where somebody is when they want it.
   *
   * Missing stays missing: a repository the caller cannot administer is
   * left undefined rather than marked off.
   */
  const fixStatus = await fetchRepoFixStatus(octokit, org);
  if (fixStatus) {
    for (const alert of allAlerts) {
      const known = fixStatus.get(alert.repo);
      if (known !== undefined) alert.fixesEnabled = known;
    }
  }

  /**
   * And why each repository has no fix pull requests.
   *
   * Computed per repository over all of its alerts, not per row: "not one of
   * these has a patched version" is a statement about the repository, and a
   * single row cannot make it.
   *
   * Stamped onto every row so the table can show it beside a finding, which is
   * where somebody is standing when they ask the question.
   */
  const byRepo = new Map<string, any[]>();
  for (const alert of allAlerts) {
    if (alert.clean || alert.disabled) continue;
    const list = byRepo.get(alert.repo);
    if (list) list.push(alert);
    else byRepo.set(alert.repo, [alert]);
  }
  for (const [repo, rows] of byRepo) {
    const blocker = fixBlockerFor(rows, rows[0].fixesEnabled, facts?.get(repo) ?? null);
    const grouped = groupsSecurityUpdates(facts?.get(repo)?.config);
    for (const row of rows) {
      row.fixBlocker = blocker;
      row.groupedConfig = grouped;
    }
  }

  /**
   * Archived, stamped onto every row including the markers.
   *
   * The bulk manager offers to turn alerts on and off per repository, and
   * GitHub refuses every settings change on an archived one however much access
   * somebody has. Carrying the flag lets the screen say so before the button is
   * pressed rather than after sixty-six repositories have failed.
   *
   * Only where the facts query answered. It returns null when it failed, and
   * marking every repository unarchived on the strength of a failed read is an
   * assertion nobody made.
   */
  if (facts) {
    for (const row of allAlerts) {
      if (facts.get(row.repo)?.archived) row.archived = true;
    }
  }

  return { rows: allAlerts, degraded };
}
