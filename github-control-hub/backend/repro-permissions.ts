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
import type { PermissionsFile } from "./src/permissions/types";
import { collectRules, LAYER, decideLeaf, type LayeredRule } from "./src/permissions/evaluate";

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

console.log("\ncollecting rules from the three layers");
{
  const file: PermissionsFile = {
    version: 1,
    presets: {
      engineer: { name: "Engineer", grant: ["me"] },
      lead: { name: "Lead", inherits: "engineer", grant: ["alarms"] },
    },
    teams: {
      "platform": { presets: ["engineer"], grant: ["repos.read"] },
      "contractors": { revoke: ["access"] },
    },
    people: {
      "some-login": { presets: ["lead"], grant: ["config.export"], revoke: ["alarms.org.delete"] },
    },
  };

  const rules = collectRules(file, "some-login", ["platform", "contractors"]);

  check("a person's own entries are collected",
    rules.some(r => r.node === "config.export" && r.layer === LAYER.person), rules);
  check("  their preset's, at a lower layer",
    rules.some(r => r.node === "alarms" && r.layer === LAYER.preset));
  check("  what that preset inherits, same layer",
    rules.some(r => r.node === "me" && r.layer === LAYER.preset));
  check("  and their teams', lower still",
    rules.some(r => r.node === "repos.read" && r.layer === LAYER.team));
  check("  including a team's preset",
    rules.some(r => r.node === "me" && r.layer === LAYER.team));
  check("  and a team's revoke",
    rules.some(r => r.node === "access" && r.effect === "revoke" && r.layer === LAYER.team));

  // The login is the key, and GitHub logins are not case-sensitive in practice.
  check("the login is matched case-insensitively",
    collectRules(file, "SOME-LOGIN", []).some(r => r.node === "config.export"));

  check("somebody with no entry and no teams gets no rules at all",
    collectRules(file, "stranger", []).length === 0);

  // A team the file does not mention contributes nothing, rather than failing.
  check("a team with no entry in the file contributes nothing",
    collectRules(file, "stranger", ["some-other-team"]).length === 0);

  check("every rule says where it came from",
    rules.every(r => r.origin.length > 0), rules.filter(r => !r.origin));
}

console.log("\nresolution: the longest match decides");
{
  const r = (node: string, effect: "grant" | "revoke", layer: number, sublayer = 99): LayeredRule =>
    ({ node, effect, layer, sublayer, origin: "test" });

  check("a leaf matched by nothing is denied",
    decideLeaf("alarms.org.create", []).held === false);

  check("a branch grant reaches the leaf",
    decideLeaf("alarms.org.create", [r("alarms", "grant", LAYER.person)]).held === true);

  /**
   * "All alarms except deleting one." The blanket rule this replaces —
   * union the grants, then subtract the revokes — handles this correctly and
   * the next case wrongly.
   */
  check("a deeper revoke beats a shallower grant",
    decideLeaf("alarms.org.delete",
      [r("alarms", "grant", LAYER.person), r("alarms.org.delete", "revoke", LAYER.person)],
    ).held === false);

  /**
   * "No AWS at all, except seeing findings." Under subtract-last this silently
   * yields nothing and the person who wrote it cannot tell from the file that
   * it did not work.
   */
  check("a deeper grant beats a shallower revoke",
    decideLeaf("aws.findings.read",
      [r("aws", "revoke", LAYER.person), r("aws.findings.read", "grant", LAYER.person)],
    ).held === true);

  check("  and the shallower revoke still holds elsewhere",
    decideLeaf("aws.rules.delete",
      [r("aws", "revoke", LAYER.person), r("aws.findings.read", "grant", LAYER.person)],
    ).held === false);

  // Layer only breaks ties at equal depth. A longer team rule beats a shorter
  // personal one, because specificity is the stronger signal.
  check("at equal depth, a person beats their preset",
    decideLeaf("config.export",
      [r("config.export", "revoke", LAYER.preset), r("config.export", "grant", LAYER.person)],
    ).held === true);

  check("at equal depth, a preset beats a team",
    decideLeaf("config.export",
      [r("config.export", "revoke", LAYER.team), r("config.export", "grant", LAYER.preset)],
    ).held === true);

  check("but a longer team rule beats a shorter personal one",
    decideLeaf("aws.rules.delete",
      [r("aws", "grant", LAYER.person), r("aws.rules.delete", "revoke", LAYER.team)],
    ).held === false);

  // Two teams disagreeing is a real state, and the safe answer is no.
  check("at equal depth and layer, revoke wins",
    decideLeaf("access.read",
      [r("access.read", "grant", LAYER.team), r("access.read", "revoke", LAYER.team)],
    ).held === false);

  // Within a preset chain, the child outranks what it inherits.
  check("within a layer, a higher sublayer wins",
    decideLeaf("me.work.read",
      [r("me.work.read", "grant", LAYER.preset, 0), r("me.work.read", "revoke", LAYER.preset, 1)],
    ).held === false);

  check("the deciding rule is reported, for the admin screen",
    decideLeaf("alarms.org.create", [r("alarms", "grant", LAYER.person)]).rule?.node === "alarms");

  // A branch that no longer exists must not match anything, or a renamed
  // branch silently keeps granting.
  check("a rule naming an unknown node decides nothing",
    decideLeaf("alarms.org.create", [r("nonsense", "grant", LAYER.person)]).held === false);

  // Segment boundaries again, this time in the resolver.
  check("a rule does not match a leaf that merely starts with its text",
    decideLeaf("activity.read.github",
      [r("activity.read.app", "grant", LAYER.person)],
    ).held === false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
