import type { DependencyAlert } from "../types/Dependabot";

/**
 * How many pull requests a repository's findings can actually turn into.
 *
 * Not the number of findings, which is the number people reach for and the
 * reason a working rollout looks broken. Dependabot raises one pull request per
 * vulnerable package it can bump, and one such bump can close a dozen alerts:
 * the same package pulled into three manifests, or one package carrying four
 * advisories at once. A repository showing "100 findings, 4 pull requests" may
 * be finished, or a fifth of the way through, and the count of findings cannot
 * tell those apart.
 *
 * So this counts distinct packages that could be bumped, which is the ceiling
 * the pull requests are actually climbing towards.
 *
 * Unless the repository has a grouped configuration, which changes the shape of
 * the answer rather than its size. Grouped, Dependabot stops opening one pull
 * request per package and opens one per manifest carrying every bump in it, so
 * the ceiling becomes the manifest count. Leaving the per-package ceiling in
 * place there would show a finished repository as "2/40" forever, which is the
 * same misreading in the other direction.
 *
 * Ungrouped is the default, because that is what every repository is until
 * somebody rolls a configuration out to it.
 */
export function expectedFixPrs(alerts: DependencyAlert[], grouped = false): number {
  const packages = new Set<string>();
  const manifests = new Set<string>();

  for (const alert of alerts) {
    if (alert.clean || alert.disabled || alert.scanning) continue;

    // No patch is no pull request, whatever else is true of it.
    if (!alert.patched_version) continue;

    // Nor is one Dependabot cannot reach: a transitive dependency outside npm
    // usually needs the parent changed by a person. Counting these would
    // inflate the ceiling and make a finished rollout read as a stalled one,
    // which is the exact misreading this function exists to prevent.
    if (alert.relationship === "transitive" && (alert.ecosystem ?? "").toLowerCase() !== "npm") {
      continue;
    }

    // Keyed on the package alone, not on the package and the version. The
    // whole point is that one bump closes every alert against that package.
    if (alert.dependency) packages.add(alert.dependency);

    // A manifest only counts once it has something fixable in it, which is why
    // this sits below the exclusions rather than above them.
    manifests.add(String(alert.manifest_path ?? ""));
  }

  return grouped ? manifests.size : packages.size;
}
