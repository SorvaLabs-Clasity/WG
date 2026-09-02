/**
 * Writing a .github/dependabot.yml that actually triggers the fixes.
 *
 * The organization this was built for had 7,047 open alerts, 6,973 of them
 * with a patch GitHub itself had identified, and 85 open pull requests. The
 * fixes were not impossible: opening any one alert and pressing "create
 * security update" produced a pull request on the spot. GitHub had simply
 * never scheduled the work, and there is no API that asks it to.
 *
 * There is one documented trigger, and it is this file: "when grouped security
 * updates are first enabled, Dependabot will immediately try to create grouped
 * pull requests". So the file is not configuration for its own sake, it is the
 * only supported way to say "do the work you said you would do".
 *
 * Which makes generating it correctly the whole game. A dependabot.yml naming
 * an ecosystem the repository does not use, or a directory with no manifest in
 * it, is not an error anybody sees: Dependabot reads it, finds nothing, and
 * opens nothing, which looks exactly like the problem it was written to fix.
 * So every entry is derived from the repository's own alerts, which is the one
 * source that has already proved a manifest is there and that GitHub can read
 * it.
 */
import fs from "fs";
import path from "path";
import { buildDependabotConfig, ECOSYSTEM_MAP } from "./src/services/dependabotConfig";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const a = (ecosystem: string, manifest_path = "package.json") =>
  ({ ecosystem, manifest_path, patched_version: "1.0.1" } as any);

(async () => {
  console.log("the config is derived from what the repository's own alerts prove is there");
  {
    const yml = buildDependabotConfig([a("npm", "package.json")])!;
    check("the ecosystem the alerts name", /package-ecosystem: "npm"/.test(yml));
    check("  at the directory its manifest sits in", /directory: "\/"/.test(yml));
    check("  and a nested manifest gives a nested directory",
      /directory: "\/services\/api"/.test(buildDependabotConfig([a("npm", "services/api/package.json")])!));

    // Two manifests of the same ecosystem in different directories are two
    // entries. One entry at the root would leave the other unscanned.
    const two = buildDependabotConfig([a("npm", "package.json"), a("npm", "web/package.json")])!;
    check("  two directories produce two entries",
      (two.match(/package-ecosystem: "npm"/g) ?? []).length === 2, two);

    // The same manifest raising forty alerts is still one entry.
    const dupes = buildDependabotConfig([a("npm"), a("npm"), a("npm")])!;
    check("  and forty alerts on one manifest produce one",
      (dupes.match(/package-ecosystem/g) ?? []).length === 1);
  }

  console.log("\nGitHub's alert names are not GitHub's config names");
  {
    // The alerts API says "rubygems", the config file wants "bundler". A
    // config written with the alert's own spelling is rejected outright, and
    // the three that differ are exactly the ones easy to get wrong.
    check("rubygems becomes bundler", ECOSYSTEM_MAP.rubygems === "bundler");
    check("  go becomes gomod", ECOSYSTEM_MAP.go === "gomod");
    check("  rust becomes cargo", ECOSYSTEM_MAP.rust === "cargo");
    check("  erlang becomes hex", ECOSYSTEM_MAP.erlang === "hex");
    check("  actions becomes github-actions", ECOSYSTEM_MAP.actions === "github-actions");
    check("  and the ones that match are left alone", ECOSYSTEM_MAP.npm === "npm" && ECOSYSTEM_MAP.pip === "pip");

    // An ecosystem with no mapping is dropped rather than guessed at. A wrong
    // package-ecosystem makes Dependabot reject the entire file, taking the
    // ecosystems that were right down with it.
    const mixed = buildDependabotConfig([a("npm"), a("somethingnew", "thing.toml")])!;
    check("  an unmappable ecosystem is dropped, not guessed",
      /npm/.test(mixed) && !/somethingnew/.test(mixed), mixed);
    check("  and a repository of only unmappable ones produces no file at all",
      buildDependabotConfig([a("somethingnew", "thing.toml")]) === null);
  }

  console.log("\ngithub-actions is a special case, and getting it wrong writes a broken file");
  {
    // Its manifests are .github/workflows/*.yml, but the ecosystem is
    // configured at the root: a directory of "/.github/workflows" finds
    // nothing.
    const yml = buildDependabotConfig([a("actions", ".github/workflows/ci.yml")])!;
    check("workflows are configured at the root",
      /package-ecosystem: "github-actions"[\s\S]{0,60}directory: "\/"/.test(yml), yml);
  }

  console.log("\nsecurity updates only: this file exists to trigger fixes, not to add noise");
  {
    const yml = buildDependabotConfig([a("npm")])!;

    // Adding a config file switches version updates on, which on 66
    // repositories is thousands of pull requests nobody asked for. Zero turns
    // those off, and GitHub documents security updates as not subject to the
    // limit, so the fixes still come.
    check("version updates are switched off", /open-pull-requests-limit: 0/.test(yml));
    check("  while the group applies to security updates",
      /applies-to: security-updates/.test(yml));

    // 6,973 alerts ungrouped is 6,973 pull requests.
    check("  and everything is gathered into one group per manifest",
      /patterns:\s*\n\s*- "\*"/.test(yml), yml);

    // Severity grouping does not exist. GitHub's group options are patterns,
    // exclude-patterns, dependency-type, update-types and group-by, so a
    // severity split cannot be expressed and must not be pretended at.
    // Not the word, which the file explains itself with, but the shape: one
    // group per manifest and no key GitHub would reject.
    check("  and no severity split is attempted, because GitHub has none",
      !/^\s*severity:/m.test(yml) && (yml.match(/applies-to: security-updates/g) ?? []).length === 1,
      yml);
  }

  console.log("\nthe file says who wrote it and why");
  {
    const yml = buildDependabotConfig([a("npm")])!;
    // Somebody finds this in a repository months later, in a pull request from
    // a bot, and the first question is who put it there.
    check("it names itself", /Control Hub/i.test(yml));
    check("  and it is valid YAML starting at version 2", /^#[\s\S]*?\nversion: 2\n/.test(yml), yml.slice(0, 80));
  }

  console.log("\nnothing is written over a repository that already has one");
  {
    const rollout = fs.readFileSync(
      path.join(__dirname, "src/services/dependabotRollout.ts"), "utf8");
    // A repository with its own dependabot.yml has somebody's intent in it,
    // possibly excluding dependencies deliberately. Replacing that silently is
    // the worst thing this feature could do.
    check("an existing config is left alone",
      /already-configured/.test(rollout) && !/force/i.test(rollout));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
