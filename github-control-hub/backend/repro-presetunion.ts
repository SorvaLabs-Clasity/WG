/**
 * Two presets on one person add up. They do not cancel out.
 *
 * Holding two is a statement that somebody should have what both give. Assign
 * one that grants half the app and revokes the rest, and another that does the
 * exact opposite, and the person should end up with all of it — not none of
 * it, which is what revoke-beats-grant produced when both landed on the same
 * node at the same layer.
 *
 * Revoke still wins everywhere else, and that is the half worth guarding: a
 * person-layer revoke is somebody saying "not this one, for this person", and
 * a team's is the same sentence about a team. Neither is a bundle being
 * combined with another bundle.
 */
import { permissionsFor } from "./src/permissions/evaluate";
import { emptyFile, type PermissionsFile } from "./src/permissions/types";
import { PERMISSIONS } from "./src/permissions/vocabulary";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const who = (teamSlugs: string[] = []) => ({ login: "alice", teamSlugs, isOrgOwner: false });

console.log("the exact case: two presets that are each other's opposite");
{
  /**
   * `alarms` and `aws` stand in for "half the app and the other half" — the
   * shape is what matters, not the branches. Each preset grants one and
   * revokes the other, so every leaf under both is granted by one preset and
   * revoked by the other at the same node, at the same layer.
   */
  const file: PermissionsFile = {
    ...emptyFile(),
    presets: {
      first:  { name: "First",  grant: ["alarms"], revoke: ["aws"] },
      second: { name: "Second", grant: ["aws"],    revoke: ["alarms"] },
    },
    people: { alice: { presets: ["first", "second"] } },
  };

  const held = permissionsFor(file, who());
  check("holding both gives everything both give",
    held.has("alarms.org.create") && held.has("aws.rules.enforce"),
    { alarms: held.has("alarms.org.create"), aws: held.has("aws.rules.enforce") });

  const onlyFirst = permissionsFor(
    { ...file, people: { alice: { presets: ["first"] } } }, who());
  check("  while holding one alone still revokes what it revokes",
    onlyFirst.has("alarms.org.create") && !onlyFirst.has("aws.rules.enforce"));

  check("  and the order they are listed in changes nothing",
    permissionsFor({ ...file, people: { alice: { presets: ["second", "first"] } } }, who())
      .held.join() === held.held.join());
}

console.log("\nadding a preset can only add");
{
  const base: PermissionsFile = {
    ...emptyFile(),
    presets: {
      wide:   { name: "Wide",   grant: ["alarms", "aws", "repos"] },
      narrow: { name: "Narrow", grant: ["overview.read"], revoke: ["aws", "repos"] },
    },
    people: { alice: { presets: ["wide"] } },
  };
  const before = permissionsFor(base, who()).held;
  const after = permissionsFor(
    { ...base, people: { alice: { presets: ["wide", "narrow"] } } }, who()).held;

  const lost = before.filter(k => !after.includes(k));
  check("nothing is lost by assigning a second preset", lost.length === 0, lost);
  check("  and what the second one grants is gained",
    after.includes("overview.read") && !before.includes("overview.read"));
}

console.log("\nrevoke still wins where it is not two bundles meeting");
{
  const file: PermissionsFile = {
    ...emptyFile(),
    presets: { wide: { name: "Wide", grant: ["aws"] } },
    teams: { platform: { grant: ["alarms"], revoke: ["alarms.org.delete"] } },
    people: { alice: { presets: ["wide"], revoke: ["aws.rules.enforce"] } },
  };
  const held = permissionsFor(file, who(["platform"]));

  check("a person-layer revoke beats a preset grant",
    held.has("aws.rules.read") && !held.has("aws.rules.enforce"),
    "otherwise 'not this one, for this person' stops meaning anything");
  check("  and a team's own revoke still wins over its own grant",
    held.has("alarms.org.create") && !held.has("alarms.org.delete"));
}

console.log("\nand a preset narrowing the preset it inherits still narrows it");
{
  /**
   * This is the case the change must not break. A child preset revoking part
   * of its parent is one bundle being defined, not two being combined —
   * `resolvePreset` collapses that chain before anything here sees it.
   */
  const file: PermissionsFile = {
    ...emptyFile(),
    presets: {
      parent: { name: "Parent", grant: ["aws"] },
      child:  { name: "Child", inherits: "parent", revoke: ["aws.rules.enforce"] },
    },
    people: { alice: { presets: ["child"] } },
  };
  const held = permissionsFor(file, who());
  check("the child's revoke narrows what it inherits",
    held.has("aws.rules.read") && !held.has("aws.rules.enforce"),
    "a chain is one preset being defined, not two being added together");
}

console.log("\nthe union reaches the whole vocabulary when the presets cover it");
{
  const half = PERMISSIONS.slice(0, Math.floor(PERMISSIONS.length / 2)).map(p => p.key);
  const rest = PERMISSIONS.slice(Math.floor(PERMISSIONS.length / 2)).map(p => p.key);
  const file: PermissionsFile = {
    ...emptyFile(),
    presets: {
      a: { name: "A", grant: half, revoke: rest },
      b: { name: "B", grant: rest, revoke: half },
    },
    people: { alice: { presets: ["a", "b"] } },
  };
  const held = permissionsFor(file, who()).held;
  check("every permission in the app is held",
    held.length === PERMISSIONS.length, { held: held.length, total: PERMISSIONS.length });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
