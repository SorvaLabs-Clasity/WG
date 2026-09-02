/**
 * The .github/dependabot.yml that makes GitHub do the work it already agreed to.
 *
 * Enabling security updates through the repository setting is documented to
 * open a pull request for "every open Dependabot alert that has an available
 * patch", and on a large backlog it frequently does not. There is no API that
 * asks it to try again. There is exactly one documented trigger, and it is
 * this file: "when grouped security updates are first enabled, Dependabot will
 * immediately try to create grouped pull requests."
 */

/**
 * The alerts API and the configuration file do not use the same names for the
 * same ecosystems, and five of them differ. A file naming "rubygems" is
 * rejected in full, taking the correctly named entries down with it, so this
 * mapping is the difference between a file that works and a file that silently
 * does nothing.
 *
 * Unmapped ecosystems are dropped rather than passed through: a guess here
 * costs the whole file.
 */
export const ECOSYSTEM_MAP: Record<string, string> = {
  npm: "npm",
  pip: "pip",
  maven: "maven",
  nuget: "nuget",
  composer: "composer",
  pub: "pub",
  swift: "swift",
  rubygems: "bundler",
  go: "gomod",
  rust: "cargo",
  erlang: "hex",
  actions: "github-actions",
};

/** The directory an entry should watch, from the manifest raising the alert. */
function directoryFor(ecosystem: string, manifestPath: string): string {
  // Workflows live in .github/workflows, but the ecosystem is configured at
  // the repository root. A directory of "/.github/workflows" reads as valid
  // and finds nothing.
  if (ecosystem === "github-actions") return "/";

  const dir = manifestPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  return dir ? `/${dir}` : "/";
}

interface ConfigurableAlert {
  ecosystem?: string;
  manifest_path?: string | null;
}

/**
 * The file for one repository, or null where none of its alerts name an
 * ecosystem that can be configured.
 *
 * Every entry comes from an alert, which is the only source that has already
 * proved the manifest exists and that GitHub can read it. An entry invented
 * from a guess about the repository's shape fails silently: Dependabot reads
 * it, finds no manifest, and opens nothing, which looks identical to the
 * problem this file was written to solve.
 */
export function buildDependabotConfig(alerts: ConfigurableAlert[]): string | null {
  const entries = new Map<string, { ecosystem: string; directory: string }>();

  for (const alert of alerts) {
    const mapped = ECOSYSTEM_MAP[String(alert.ecosystem ?? "").toLowerCase()];
    if (!mapped) continue;
    const directory = directoryFor(mapped, String(alert.manifest_path ?? ""));
    entries.set(`${mapped} ${directory}`, { ecosystem: mapped, directory });
  }

  if (entries.size === 0) return null;

  const blocks = [...entries.values()]
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.directory.localeCompare(b.directory))
    .map(({ ecosystem, directory }) =>
`  - package-ecosystem: "${ecosystem}"
    directory: "${directory}"
    schedule:
      interval: "weekly"
    # Version updates off. Adding this file switches them on by default, which
    # across an organization is thousands of pull requests nobody asked for.
    # Security updates are not subject to this limit, so the fixes still come.
    open-pull-requests-limit: 0
    groups:
      security-fixes:
        applies-to: security-updates
        # Everything in one pull request per manifest. GitHub offers no way to
        # group by advisory severity, and one pull request per alert would be
        # thousands.
        patterns:
          - "*"`);

  return `# Added by GitHub Control Hub to switch on grouped Dependabot security updates.
#
# The repository setting alone had left a backlog of alerts with available
# patches and no pull requests. Turning on grouped security updates is the one
# thing GitHub documents as immediately retrying all of them.
#
# Every entry below was derived from an alert this repository actually raised,
# so each names a manifest GitHub has already read.
version: 2
updates:
${blocks.join("\n")}
`;
}
