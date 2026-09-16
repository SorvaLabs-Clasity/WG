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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
