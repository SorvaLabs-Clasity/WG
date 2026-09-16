/**
 * What one click in the permission tree writes into somebody's file.
 *
 * The Admin tab's tree edits **one layer** — a person's own `grant`/`revoke`,
 * which outranks their presets and their GitHub teams. What it writes there is
 * therefore a decision about everything those other layers were giving them.
 *
 * It used to be handed the *resolved* state and asked for the entry that would
 * reproduce it if this layer were the only one. Ticking one Overview checkbox
 * saved `revoke: ["aws"]` and stripped fourteen AWS leaves the administrator
 * had not touched and could not see; and everything held through a GitHub team
 * was frozen into the person's own entry, so removing them from that team
 * stopped removing their access.
 *
 * So the client's arithmetic is run here against the **server's own
 * evaluator** — `permissionsFor`, the function that will actually decide these
 * questions in production — rather than against a restatement of it. Every
 * assertion below is "who holds what, before and after", not "what string did
 * it produce".
 *
 * Run:  npx tsx repro-permissiontree.ts   from github-control-hub/frontend
 */
import {
  buildTree, knownNodesOf, decideLeaf, ownRulesFrom, baselineOf, collapseEntry, collectLeafKeys,
  type Node,
} from "./src/components/permissionTreeModel";
import type { PermissionLeaf, PermissionEntry, FlatRule } from "./src/api/admin";
import { permissionsFor, type Subject } from "../backend/src/permissions/evaluate";
import { PERMISSIONS } from "../backend/src/permissions/vocabulary";
import type { PermissionsFile } from "../backend/src/permissions/types";
import fs from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

/** The real vocabulary, from the server, in the shape the tree is handed. */
const vocabulary: PermissionLeaf[] = PERMISSIONS.map(p => ({ key: p.key, label: p.label, addedIn: p.addedIn }));
const tree = buildTree(vocabulary);
const knownNodes = knownNodesOf(vocabulary);

/**
 * The screen's `inheritedFromExplanations`, in one line: every leaf the server
 * says this person holds through something other than their own entry becomes
 * a leaf-depth rule beneath the layer being edited.
 */
function inheritedFor(file: PermissionsFile, subject: Subject): FlatRule[] {
  const held = permissionsFor(file, subject);
  const out: FlatRule[] = [];
  for (const leaf of vocabulary) {
    const exp = held.explain(leaf.key);
    if (!exp.origin || exp.origin === "set on this person") continue;
    out.push({ node: leaf.key, effect: exp.held ? "grant" : "revoke", layer: 0, origin: `From ${exp.origin}` });
  }
  return out;
}

/** One click, exactly as `handleToggle` performs it. */
function click(node: Node, inherited: FlatRule[], entry: PermissionEntry): PermissionEntry {
  const ownLayer = (inherited.length ? Math.max(...inherited.map(r => r.layer)) : 0) + 1;
  const allRules = [...inherited, ...ownRulesFrom(entry, ownLayer)];
  const held = (key: string) => decideLeaf(key, allRules, knownNodes)?.effect === "grant";

  const desired = new Map<string, boolean>();
  for (const leaf of vocabulary) desired.set(leaf.key, held(leaf.key));

  if (node.isLeaf) {
    desired.set(node.key, !held(node.key));
  } else {
    const leaves = collectLeafKeys(node);
    const count = leaves.filter(held).length;
    const next = count < leaves.length;
    for (const key of leaves) desired.set(key, next);
  }

  return collapseEntry(desired, tree, baselineOf(vocabulary, inherited, knownNodes));
}

function find(key: string): Node {
  const walk = (nodes: Node[]): Node | null => {
    for (const n of nodes) {
      if (n.key === key) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(tree);
  if (!hit) throw new Error(`no node "${key}" in the vocabulary`);
  return hit;
}

// ── the world the review reproduced this in ────────────────────────────
//
// dana holds the `member` preset directly, and the `aws` preset through her
// GitHub team. Exactly the shape the migration writes on day one.
const baseFile = (): PermissionsFile => ({
  version: 1,
  presets: {
    member: { name: "Member", grant: ["me", "overview.read", "repos.read", "pulls.read", "deps.read"] },
    aws: { name: "AWS", grant: ["aws", "activity.detailedLogging"] },
  },
  teams: { platform: { presets: ["aws"] } },
  people: { dana: { presets: ["member"] } },
});

const dana: Subject = { login: "dana", teamSlugs: ["platform"], isOrgOwner: false };

/** dana's file with `entry` written into her own layer, as the save would. */
const withEntry = (entry: PermissionEntry): PermissionsFile => {
  const f = baseFile();
  f.people.dana = { presets: ["member"], grant: entry.grant, revoke: entry.revoke };
  return f;
};

console.log("one tick changes one thing");
{
  const before = permissionsFor(baseFile(), dana);
  const inherited = inheritedFor(baseFile(), dana);

  check("the world is the one the bug needed: dana holds AWS through her team",
    before.has("aws.rules.edit") && before.explain("aws.rules.edit").origin?.includes("team platform"),
    before.explain("aws.rules.edit"));
  check("  and does not hold the leaf about to be ticked",
    !before.has("overview.cards.read"));

  const entry = click(find("overview.cards.read"), inherited, {});

  /**
   * One rule, covering exactly the leaf that was ticked.
   *
   * Written as "what does the entry reach" rather than "what string is in it":
   * `overview.cards` has a single leaf today, so the collapse correctly names
   * the branch — which is the property that keeps a leaf added beneath it later
   * inside the grant. Pinning the literal string would fail the day a second
   * leaf is added there, for no reason, and that is how several suites in this
   * repository have already had to be rewritten once.
   */
  const covered = (nodes: string[]) =>
    vocabulary.map(l => l.key).filter(k => nodes.some(n => k === n || k.startsWith(n + ".")));

  check("the entry is one rule, reaching exactly the leaf that was ticked",
    (entry.grant ?? []).length === 1 && entry.revoke === undefined
      && covered(entry.grant!).join() === "overview.cards.read",
    { entry, covers: covered(entry.grant ?? []) });

  const after = permissionsFor(withEntry(entry), dana);
  const gained = after.held.filter(k => !before.has(k));
  const lost = before.held.filter(k => !after.has(k));

  check("  so evaluated by the server, exactly one leaf is gained",
    gained.join() === "overview.cards.read", gained);
  check("  and nothing at all is lost",
    lost.length === 0, lost);
  check("  in particular, not the fourteen AWS leaves nobody touched",
    after.has("aws.rules.edit") && after.has("aws.remediate") && after.has("aws.costs.read"),
    lost.filter(k => k.startsWith("aws")));
}

console.log("\nun-ticking is a revoke of that leaf alone");
{
  const before = permissionsFor(baseFile(), dana);
  const inherited = inheritedFor(baseFile(), dana);

  const entry = click(find("aws.remediate"), inherited, {});
  check("turning off one leaf held through a team writes that leaf, not its branch",
    (entry.revoke ?? []).join() === "aws.remediate" && entry.grant === undefined, entry);

  const after = permissionsFor(withEntry(entry), dana);
  check("  and the rest of the branch survives",
    !after.has("aws.remediate") && after.has("aws.rules.edit") && after.has("aws.read"),
    before.held.filter(k => !after.has(k)));
  check("  with exactly one leaf lost and none gained",
    before.held.filter(k => !after.has(k)).join() === "aws.remediate"
      && after.held.filter(k => !before.has(k)).length === 0);
}

console.log("\nnothing a team gives is copied into the person's own layer");
{
  /**
   * The quieter half of the same defect: one click used to write an explicit
   * person-layer grant for everything held through a team, so removing dana
   * from `platform` on GitHub no longer removed her AWS access — and the
   * `revoke: ["admin"]` written alongside it pre-emptively blocked every
   * future team or preset grant of that branch.
   */
  const inherited = inheritedFor(baseFile(), dana);
  const entry = click(find("deps.age.read"), inherited, {});

  const offTheTeam: Subject = { login: "dana", teamSlugs: [], isOrgOwner: false };
  const after = permissionsFor(withEntry(entry), offTheTeam);

  check("leaving the team removes what the team was giving",
    !after.has("aws.rules.edit") && !after.has("aws.read"),
    after.held.filter(k => k.startsWith("aws")));
  check("  while the deliberate tick survives", after.has("deps.age.read"));

  /**
   * And a branch nobody touched carries no pre-emptive revoke, so a preset
   * granting it later still reaches her.
   */
  const laterGrant = withEntry(entry);
  laterGrant.presets.newcomer = { name: "Newcomer", grant: ["access"] };
  laterGrant.people.dana.presets = ["member", "newcomer"];
  check("  and a branch granted to her later is not blocked by a revoke nobody wrote",
    permissionsFor(laterGrant, offTheTeam).has("access.read"),
    entry.revoke);
}

console.log("\nan untouched tree writes nothing at all");
{
  const inherited = inheritedFor(baseFile(), dana);
  const entry = click(find("overview.cards.read"), inherited, {});
  const undone = click(find("overview.cards.read"), inherited, entry);

  check("ticking a leaf and un-ticking it leaves an empty entry",
    undone.grant === undefined && undone.revoke === undefined, undone);

  const after = permissionsFor(withEntry(undone), dana);
  const before = permissionsFor(baseFile(), dana);
  check("  which the server reads as no change whatsoever",
    after.held.join() === before.held.join(),
    { gained: after.held.filter(k => !before.has(k)), lost: before.held.filter(k => !after.has(k)) });
}

console.log("\na branch whose every leaf is turned on still collapses to one rule");
{
  /**
   * The property the collapse exists for: a branch granted as a branch keeps a
   * leaf added to the vocabulary later inside it. Ticking the `access` branch
   * for somebody who holds none of it must write `grant: ["access"]`, not five
   * leaf keys.
   */
  const inherited = inheritedFor(baseFile(), dana);
  const entry = click(find("access"), inherited, {});
  check("ticking a whole branch nobody holds writes the branch",
    (entry.grant ?? []).join() === "access" && entry.revoke === undefined, entry);

  const after = permissionsFor(withEntry(entry), dana);
  check("  and every leaf beneath it is held",
    collectLeafKeys(find("access")).every(k => after.has(k)));

  /**
   * But only when every leaf below it differs. A branch dana already half
   * holds through her team must not be re-stated wholesale.
   */
  const partial = click(find("aws"), inherited, {});
  check("ticking a branch already fully held through a team turns it off leaf by branch, not by re-granting it",
    (partial.grant ?? []).join() === "" && (partial.revoke ?? []).join() === "aws", partial);
}

console.log("\nthe screen does not offer an edit against a baseline it knows is stale");
{
  /**
   * The first lock, which is the one that belongs on the screen: while the
   * preset selection is dirty the tree's baseline is rebuilt from a route that
   * answers for presets, not for people, so this person's team-derived rules
   * are missing from it. An edit is a diff against that baseline, so the tree
   * is read-only until the preset change is saved and the server has
   * re-resolved them.
   */
  const page = fs.readFileSync("./src/pages/AdminPage.tsx", "utf8");
  check("the person's tree is read-only while the preset selection is dirty",
    /readOnly=\{!canOverride \|\| presetsChanged\}/.test(page),
    "a tick against a baseline known to be incomplete is a diff against the wrong thing");
}

console.log("\nan incomplete baseline still writes nothing about what it cannot see");
{
  /**
   * The Critical, in its dangerous direction.
   *
   * While the preset multi-select is dirty the screen rebuilds `inherited` from
   * `GET /admin/preset/:id/resolved` for the selected presets only — a route
   * that answers for a preset, so dana's **team**-derived rules are missing
   * from it. The old `collapseEntry` took the resolved state as its input, so
   * every branch absent from that preview came out as an explicit person-layer
   * `revoke`, and `revoke: ["aws"]` at the person layer beats the team's
   * `grant: ["aws"]`. One Overview tick removed her entire AWS access, silently.
   *
   * `AdminPage` now makes the tree read-only while the selection is dirty,
   * because a baseline known to be incomplete cannot be diffed against. This is
   * the second lock: even handed that incomplete baseline, a diff says nothing
   * about branches it cannot see, because `desired` and `baseline` agree there.
   */
  const presetOnlyPreview = inheritedFor(
    { ...baseFile(), teams: {} },                      // the team's rules dropped
    { login: "dana", teamSlugs: [], isOrgOwner: false },
  );

  const entry = click(find("overview.cards.read"), presetOnlyPreview, {});
  check("no rule is written for a branch the preview could not see",
    !(entry.revoke ?? []).some(n => n === "aws" || n.startsWith("aws.")), entry.revoke);
  check("  and the tick itself is still written",
    (entry.grant ?? []).length === 1, entry.grant);

  // Saved against the real file, with her real team, nothing of hers is lost.
  const before = permissionsFor(baseFile(), dana);
  const after = permissionsFor(withEntry(entry), dana);
  check("  so saving it loses her nothing, AWS included",
    before.held.filter(k => !after.has(k)).length === 0,
    before.held.filter(k => !after.has(k)));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
