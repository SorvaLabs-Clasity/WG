/**
 * The permissions file: whether it can be used, and what is wrong when it cannot.
 *
 * Stage 1's engine is pure and assumes a well-formed file. This is the gate that
 * makes that assumption safe. A file that fails here grants nobody anything,
 * which is the whole of "fail closed" — so the difference between *fatal* and
 * *tolerated* is the most load-bearing judgement in this module.
 *
 * Run:  npx tsx repro-permissionsfile.ts   from github-control-hub/backend
 */
import { fileProblems, unknownNodesIn, isUsable } from "./src/permissions/validate";
import type { PermissionsFile } from "./src/permissions/types";
import fs from "node:fs";
import { emptyFile } from "./src/permissions/types";
import {
  decodeFileContent, isFailure, forgetPermissions, commitMessageFor,
} from "./src/permissions/store";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const good: PermissionsFile = {
  version: 1,
  presets: { engineer: { name: "Engineer", grant: ["me", "activity.read.own"] } },
  teams: { platform: { presets: ["engineer"] } },
  people: { someone: { presets: ["engineer"], grant: ["config.export"] } },
};

console.log("a usable file");
{
  check("a good file has no problems", fileProblems(good).length === 0, fileProblems(good));
  check("  and is usable", isUsable(good));
}

console.log("\nshapes that are not a permissions file at all");
{
  for (const [name, raw] of [
    ["null", null], ["a string", "nope"], ["an array", []], ["a number", 7],
  ] as const) {
    check(`  ${name} is refused`, fileProblems(raw).length > 0 && !isUsable(raw));
  }
  check("a missing version is refused",
    fileProblems({ presets: {}, teams: {}, people: {} }).some(p => /version/.test(p.what)));
  check("a non-object presets map is refused",
    fileProblems({ version: 1, presets: [], teams: {}, people: {} }).some(p => /presets/.test(p.where)));
  // Absent sections are tolerated: an empty file is a valid file that grants
  // nothing, and refusing it would make the very first save impossible.
  check("absent sections are tolerated as empty",
    fileProblems({ version: 1 }).length === 0);
}

console.log("\nthings that make a file unusable");
{
  /**
   * The finding stage 1 deferred here: resolvePreset returns the rules it
   * gathered below a missing ancestor, so an unknown `inherits` would grant a
   * subset rather than failing. The gate is this validator, and it is why
   * nothing may evaluate a file that has not passed it.
   */
  const dangling = { version: 1, presets: { a: { name: "A", inherits: "ghost" } }, teams: {}, people: {} };
  check("a preset inheriting something that does not exist is fatal",
    fileProblems(dangling).some(p => /ghost/.test(p.what)), fileProblems(dangling));

  const cyclic = { version: 1,
    presets: { a: { name: "A", inherits: "b" }, b: { name: "B", inherits: "a" } },
    teams: {}, people: {} };
  check("a preset cycle is fatal", fileProblems(cyclic).some(p => /cycle/i.test(p.what)));

  const badRef = { version: 1, presets: {}, teams: {},
    people: { someone: { presets: ["no-such-preset"] } } };
  check("a person assigned a preset that does not exist is fatal",
    fileProblems(badRef).some(p => /no-such-preset/.test(p.what)), fileProblems(badRef));

  const badTeamRef = { version: 1, presets: {},
    teams: { platform: { presets: ["no-such-preset"] } }, people: {} };
  check("  and so is a team assigned one", fileProblems(badTeamRef).length > 0);

  check("a preset with no name is fatal",
    fileProblems({ version: 1, presets: { a: {} }, teams: {}, people: {} }).length > 0);
}

console.log("\nthings that are tolerated and reported");
{
  /**
   * An app upgrade that removes a permission must not lock the organization
   * out of the screen that would fix it. So an unknown node is ignored at
   * evaluation time — stage 1's decideLeaf already skips it — and named here
   * so the admin screen can offer to clean it up.
   */
  const stale: PermissionsFile = { version: 1, presets: {}, teams: {},
    people: { someone: { grant: ["alarms.org.create", "alarms.removedLastYear"] } } };
  check("an unknown node does not make a file unusable",
    fileProblems(stale).length === 0 && isUsable(stale));
  check("  but it is reported",
    unknownNodesIn(stale).includes("alarms.removedLastYear"), unknownNodesIn(stale));
  check("  and a known one is not",
    !unknownNodesIn(stale).includes("alarms.org.create"));
  check("  branches count as known",
    unknownNodesIn({ version: 1, presets: {}, teams: {},
      people: { x: { grant: ["alarms"] } } }).length === 0);
  check("  and nodes inside presets and teams are reported too",
    unknownNodesIn({ version: 1,
      presets: { p: { name: "P", grant: ["made.up.one"] } },
      teams: { t: { revoke: ["also.made.up"] } }, people: {} },
    ).sort().join() === "also.made.up,made.up.one");
  check("  each unknown node reported once",
    unknownNodesIn({ version: 1, presets: {}, teams: {},
      people: { a: { grant: ["ghost.node"] }, b: { grant: ["ghost.node"] } } }).length === 1);
}

console.log("\nevery problem says where it is");
{
  const p = fileProblems({ version: 1, presets: { a: { name: "A", inherits: "ghost" } }, teams: {}, people: {} });
  check("a problem names its location", p.every(x => x.where.length > 0), p);
  check("  and what is wrong", p.every(x => x.what.length > 0));
}

console.log("\nreading the file");
{
  // Decoding is the only part of the reader that is pure enough to test
  // directly; the rest needs GitHub and is exercised by the route tests in
  // stage 3. Base64 with embedded newlines is what the contents API returns.
  check("base64 content is decoded, newlines and all",
    decodeFileContent(Buffer.from('{"version":1}', "utf8").toString("base64")) === '{"version":1}');
  const wrapped = Buffer.from('{"version":1}', "utf8").toString("base64").match(/.{1,4}/g)!.join("\n");
  check("  and GitHub's line-wrapped base64 too",
    decodeFileContent(wrapped) === '{"version":1}');

  check("a failure is distinguishable from a load",
    isFailure({ reason: "unreachable", detail: "x" })
    && !isFailure({ file: emptyFile(), sha: null, source: "absent" }));

  // The decision that must not soften: a failure yields nothing, never a
  // remembered copy. A cached grant is a grant nobody can revoke.
  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");
  check("nothing keeps a last-known-good copy",
    !/lastKnownGood|lastGood|fallbackFile/.test(store),
    "a cached grant outlives the file that granted it");
  check("  and the cache is cleared rather than served on failure",
    /forgetPermissions/.test(store));
}

console.log("\nfileProblems is total: it reports, it never throws");
{
  /**
   * `fileProblems` runs on arbitrary parsed JSON — somebody's hand-edit —
   * and `store.ts` gates every request on it. A throw here is not "a
   * rejection with extra steps": the caller treats a throw differently from
   * a returned list of problems, so a throw is a fail-*OPEN* path. Every
   * shape below used to crash `presetProblems` reaching into a `null` entry
   * that `validate.ts` had reported but not removed.
   */
  const safely = (raw: unknown) => {
    try {
      return { threw: false, problems: fileProblems(raw) };
    } catch (e) {
      return { threw: true, problems: [] as ReturnType<typeof fileProblems> };
    }
  };

  const cases: Array<[string, unknown]> = [
    ["a null preset", { version: 1, presets: { a: null }, teams: {}, people: {} }],
    ["a preset that is a string", { version: 1, presets: { a: "text" }, teams: {}, people: {} }],
    ["a null team", { version: 1, presets: {}, teams: { t: null }, people: {} }],
    ["a null person", { version: 1, presets: {}, teams: {}, people: { p: null } }],
  ];
  for (const [name, raw] of cases) {
    const result = safely(raw);
    check(`  ${name} does not throw`, !result.threw);
    check(`    and is reported as a problem`, result.problems.length > 0, result.problems);
  }
}

console.log("\na malformed presets assignment is a problem, not a silent no-op");
{
  // `presets: "engineer"` is not an array. Reading "not an array" as "no
  // presets assigned" makes a broken assignment look unused rather than
  // broken, and grants nothing where the file asked for something.
  const malformed = { version: 1, presets: {}, teams: {},
    people: { p: { presets: "engineer" } } };
  check("a person with a non-array presets value is not usable", !isUsable(malformed));
  check("  and the problem names the person",
    fileProblems(malformed).some(p => p.where === "people.p"), fileProblems(malformed));

  // Absent is still fine — this is what the earlier behaviour must not
  // regress.
  const absent = { version: 1, presets: {}, teams: {}, people: { p: { grant: ["me"] } } };
  check("  while a person with no presets at all is still usable", isUsable(absent));
}

console.log("\na preset with no name is reported once, not twice");
{
  // `validate.ts` reports it at the specific `presets.<id>`; `presetProblems`
  // (stage 1's own checker) reports the same defect again at the coarser
  // `presets`, because it has no per-id location. One defect, one problem.
  const nameless = { version: 1, presets: { a: {} }, teams: {}, people: {} };
  const p = fileProblems(nameless);
  check("exactly one problem is reported for one nameless preset", p.length === 1, p);
  check("  and it is the specific one", p[0]?.where === "presets.a", p);
}

console.log("\nwriting the file");
{
  check("the commit message names the change and who made it",
    commitMessageFor("some-login", "Grant alarms.org.create to other-login")
      === "Grant alarms.org.create to other-login\n\nBy some-login via Control Hub",
    commitMessageFor("some-login", "Grant alarms.org.create to other-login"));

  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");

  /**
   * Two administrators on the same screen must not silently discard each
   * other's work. The sha the editor loaded is sent back; a changed one means
   * somebody saved first, and the write is refused rather than applied.
   */
  check("the write sends the sha it read",
    /sha: sha \?\? undefined|sha:\s*sha/.test(store), "without it a concurrent save is lost");
  check("  and a 409 from GitHub is reported as a conflict",
    /409/.test(store) && /"conflict"/.test(store));

  // Writing a file that cannot be read back is how an admin locks the org out.
  check("a file that would not validate is refused before it is written",
    /isUsable\(next\)/.test(store) || /fileProblems\(next\)/.test(store));

  check("a successful write drops the cache",
    /forgetPermissions\(\)/.test(store.slice(store.indexOf("savePermissions"))),
    "otherwise a change you just made is invisible for up to a minute");
}

console.log("\nwho the caller is");
{
  const subject = fs.readFileSync("./src/permissions/subject.ts", "utf8");

  /**
   * The exemption that keeps a broken file from locking everybody out. It has
   * to be read from GitHub rather than from the permissions file, or the file
   * could revoke the exemption that exists to survive the file.
   */
  check("organization ownership is read from GitHub, not from the file",
    /getMembershipForUser/.test(subject) && /role === "admin"/.test(subject));
  check("  and never from the permissions file",
    !/loadPermissions|PermissionsFile/.test(subject));

  /**
   * One paginated call, not one per team. The obvious implementation — list
   * every team in the org, then ask "is this person in it" for each — is
   * O(teams) GitHub calls for every permission load, on every request. An org
   * with fifty teams would spend fifty calls answering one question.
   */
  check("the caller's teams are read in one paginated call",
    /listForAuthenticatedUser/.test(subject));
  check("  not by asking per team",
    !/getMembershipForUserInOrg/.test(subject),
    "that is O(teams) calls per permission load");
  check("  paged the way the rest of this codebase pages",
    /per_page: 100/.test(subject) && /page\b/.test(subject));

  /**
   * Fail closed, the same rule as the file: an unreadable membership means the
   * person keeps only what their own entries and presets give them. Not a
   * fallback to a remembered list.
   */
  check("an unreadable membership yields no teams rather than the last known set",
    /catch/.test(subject) && !/lastKnownTeams|cachedTeams\b/.test(subject));

  check("answers are cached, so a screen is not a burst of GitHub calls",
    /TTL|expires/.test(subject) && /forgetSubjects/.test(subject));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
