/**
 * The permission engine: what one person may do, decided from plain data.
 *
 * Everything here is a pure function. No GitHub, no storage, no Express — those
 * arrive in stage 2 and wrap this rather than change it.
 *
 * Run:  npx tsx repro-permissions.ts   from github-control-hub/backend
 */
import {
  PERMISSIONS, LEAF_KEYS, isLeaf, isKnownNode, leavesUnder, vocabularyProblems,
} from "./src/permissions/vocabulary";
import type { Preset } from "./src/permissions/types";
import { resolvePreset, presetProblems } from "./src/permissions/presets";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

console.log("the vocabulary");
{
  check("every permission in the vocabulary is present", PERMISSIONS.length === 101, PERMISSIONS.length);

  /**
   * The rule the whole tree rests on. If `activity.read.app` were both a
   * checkable permission and the parent of `activity.read.app.actor`, granting
   * it would mean two different things depending on who was asking, and the
   * tri-state checkbox in the admin UI would have nothing coherent to show.
   */
  check("no key is an ancestor of another", vocabularyProblems().length === 0,
    vocabularyProblems());

  check("every key is unique",
    new Set(PERMISSIONS.map(p => p.key)).size === PERMISSIONS.length);

  check("every key is dotted lower-case segments",
    PERMISSIONS.every(p => /^[a-z]+(\.[a-zA-Z]+)+$/.test(p.key)),
    PERMISSIONS.filter(p => !/^[a-z]+(\.[a-zA-Z]+)+$/.test(p.key)).map(p => p.key));

  check("every key is described", PERMISSIONS.every(p => p.label.length > 3));

  check("a leaf is recognized", isLeaf("alarms.org.create"));
  check("  and a branch is not a leaf", !isLeaf("alarms.org"));
  check("  while both are known nodes",
    isKnownNode("alarms.org.create") && isKnownNode("alarms.org") && isKnownNode("alarms"));
  check("  and an invented one is not", !isKnownNode("alarms.invented"));

  // A branch expands to every leaf beneath it. This is what makes ~120
  // permissions assignable without ticking 120 boxes.
  const orgAlarms = leavesUnder("alarms.org");
  check("a branch expands to its leaves",
    orgAlarms.length === 4 && orgAlarms.every(k => k.startsWith("alarms.org.")),
    orgAlarms);
  check("  a leaf expands to itself",
    leavesUnder("alarms.org.create").join() === "alarms.org.create");
  check("  and an unknown node expands to nothing",
    leavesUnder("nonsense").length === 0);

  // Prefix matching must respect segment boundaries, or "me" would match
  // "members.read" and quietly grant a tab nobody chose.
  check("a branch does not match a key that merely starts with its text",
    !leavesUnder("activity.read.app").includes("activity.read.github"),
    leavesUnder("activity.read.app"));

  check("the redaction split exists, as two leaves under a branch",
    isLeaf("activity.read.app.rows") && isLeaf("activity.read.app.actor")
    && !isLeaf("activity.read.app") && leavesUnder("activity.read.app").length === 2);

  check("LEAF_KEYS agrees with PERMISSIONS", LEAF_KEYS.size === PERMISSIONS.length);
}

console.log("\nresolving a preset");
{
  const presets: Record<string, Preset> = {
    engineer: { name: "Engineer", grant: ["me", "activity.read.own"] },
    lead: { name: "Lead", inherits: "engineer", grant: ["alarms"], revoke: ["alarms.org.delete"] },
    deep4: { name: "D4", inherits: "lead" },
  };

  const engineer = resolvePreset(presets, "engineer", "preset");
  check("a preset yields one rule per entry", engineer.length === 2, engineer);
  check("  carrying the node and the effect",
    engineer[0].node === "me" && engineer[0].effect === "grant", engineer[0]);
  check("  and naming where it came from",
    engineer.every(r => r.origin.includes("Engineer")), engineer.map(r => r.origin));

  const lead = resolvePreset(presets, "lead", "preset");
  check("inherited rules come through", lead.some(r => r.node === "me"), lead);
  check("  along with the child's own", lead.some(r => r.node === "alarms"));
  check("  and the child's revoke", lead.some(r => r.node === "alarms.org.delete" && r.effect === "revoke"));

  /**
   * The child must outrank its parent, or "inherit Engineer, but not this one
   * thing" cannot be written. Sublayer is how that ordering survives into the
   * resolver, which sees a flat list.
   */
  const own = lead.find(r => r.node === "alarms")!;
  const inherited = lead.find(r => r.node === "me")!;
  check("  with the child outranking the parent", own.sublayer > inherited.sublayer,
    { own: own.sublayer, inherited: inherited.sublayer });

  check("an unknown preset resolves to nothing rather than throwing",
    resolvePreset(presets, "no-such-preset", "preset").length === 0);

  // Cycles and runaway chains are schema errors: they fail the file closed
  // rather than looping.
  const cyclic: Record<string, Preset> = {
    a: { name: "A", inherits: "b" },
    b: { name: "B", inherits: "a" },
  };
  check("a cycle is reported", presetProblems(cyclic).some(p => /cycle/i.test(p)),
    presetProblems(cyclic));
  check("  and resolving one does not hang",
    resolvePreset(cyclic, "a", "preset").length === 0);

  const tooDeep: Record<string, Preset> = {
    p1: { name: "1" }, p2: { name: "2", inherits: "p1" }, p3: { name: "3", inherits: "p2" },
    p4: { name: "4", inherits: "p3" }, p5: { name: "5", inherits: "p4" },
    p6: { name: "6", inherits: "p5" },
  };
  check("an inheritance chain deeper than 4 is reported",
    presetProblems(tooDeep).some(p => /deep/i.test(p)), presetProblems(tooDeep));

  check("a preset naming an unknown parent is reported",
    presetProblems({ x: { name: "X", inherits: "ghost" } }).some(p => /ghost/.test(p)));

  check("a healthy set has no problems", presetProblems(presets).length === 0, presetProblems(presets));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
