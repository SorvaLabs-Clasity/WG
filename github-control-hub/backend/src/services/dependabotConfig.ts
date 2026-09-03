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

/**
 * Which JVM ecosystem a manifest belongs to.
 *
 * The alerts API has one value for the whole JVM, its list being "composer,
 * go, maven, npm, nuget, pip, pub, rubygems, rust". The configuration file has
 * three: `maven`, `gradle` and `sbt`. Writing `maven` for a Gradle repository
 * produces a file that reads correctly and does nothing, because Dependabot
 * looks for a pom.xml and finds a build.gradle, and nothing anywhere reports
 * it.
 *
 * The filename is the only thing that distinguishes them, and the alert
 * carries it. Null where it does not say, because either answer is a coin flip
 * that fails silently when it loses, and a repository reported as having no
 * configurable ecosystem is at least visible.
 */
function jvmEcosystem(manifestPath: string): string | null {
  const file = manifestPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";

  if (file === "pom.xml") return "maven";
  if (file === "build.sbt") return "sbt";
  // Groovy and Kotlin build scripts, the settings file, and the version
  // catalog a newer Gradle build keeps its dependencies in.
  if (/^(build|settings)\.gradle(\.kts)?$/.test(file)) return "gradle";
  if (file === "libs.versions.toml") return "gradle";

  return null;
}

/**
 * The `package-ecosystem` for one alert, or null where it cannot be settled.
 *
 * Everything except the JVM is a straight lookup: the mapping is the whole
 * job, since a wrong value has the file rejected outright.
 */
function configEcosystem(alertEcosystem: string, manifestPath: string): string | null {
  const mapped = ECOSYSTEM_MAP[alertEcosystem.toLowerCase()];
  if (!mapped) return null;
  return mapped === "maven" ? jvmEcosystem(manifestPath) : mapped;
}

/** The directory an entry should watch, from the manifest raising the alert. */
function directoryFor(ecosystem: string, manifestPath: string): string {
  // Workflows live in .github/workflows, but the ecosystem is configured at
  // the repository root. A directory of "/.github/workflows" reads as valid
  // and finds nothing.
  if (ecosystem === "github-actions") return "/";

  // A version catalog lives at gradle/libs.versions.toml, but the build it
  // belongs to is its parent. Pointing Dependabot at /gradle finds no build
  // script, which is the same silent nothing as naming the wrong ecosystem.
  if (ecosystem === "gradle" && /(^|\/)gradle\/libs\.versions\.toml$/i.test(manifestPath)) {
    const up = manifestPath.replace(/(^|\/)gradle\/libs\.versions\.toml$/i, "");
    return up ? `/${up}` : "/";
  }

  const dir = manifestPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  return dir ? `/${dir}` : "/";
}

/**
 * The name for one entry's security group.
 *
 * The group name is the only part of the pull request's title this file
 * controls: GitHub renders it as "Bump the <name> group with N updates". Every
 * entry used to be called `security-fixes`, so a repository with npm and pip
 * produced two pull requests with identical titles, and an organization's pull
 * request list gave no way to tell which was which.
 *
 * The separation itself was never the problem, and is not what changed here.
 * One `updates` entry per ecosystem and directory was already being written,
 * and a Dependabot group only spans its own entry, so npm and pip have always
 * been separate pull requests. This makes them *say* so.
 *
 * The directory is included only when it is not the root, because two entries
 * for the same ecosystem in different directories would otherwise collide on
 * the same name and the same repository.
 *
 * Restricted to lowercase letters, digits and dashes: this ends up inside a
 * branch name, and anything else there is a ref nobody can push.
 */
function groupName(ecosystem: string, directory: string): string {
  const slug = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const dir = slug(directory);
  const eco = slug(ecosystem);
  return dir ? `${eco}-${dir}-security` : `${eco}-security`;
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
    const path = String(alert.manifest_path ?? "");
    const mapped = configEcosystem(String(alert.ecosystem ?? ""), path);
    if (!mapped) continue;
    const directory = directoryFor(mapped, path);
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
      # Named for this ecosystem and directory, because the group name is what
      # GitHub puts in the title: "Bump the ${groupName(ecosystem, directory)}
      # group with N updates". A shared name made every one of these pull
      # requests read identically.
      ${groupName(ecosystem, directory)}:
        applies-to: security-updates
        # One pull request per manifest. Ecosystems are already separate, since
        # each is its own entry above and a group never spans entries. Below
        # this there is nothing left to split on: GitHub cannot group by
        # advisory severity, and per-package would be thousands.
        #
        # "*" deliberately, so nothing is left outside the group. GitHub raises
        # an individual pull request for anything that matches no rule, so a
        # narrower pattern here would produce the grouped pull request AND a
        # stray one per unmatched dependency.
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
