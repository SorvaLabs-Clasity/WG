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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
