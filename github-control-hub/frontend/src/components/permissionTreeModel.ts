import type { PermissionLeaf, PermissionEntry, FlatRule } from "../api/admin";

/**
 * The permission tree's arithmetic, with no React in it.
 *
 * Split out of `PermissionTree.tsx` so it can be run: this is where a click
 * turns into the `{grant, revoke}` that gets written into somebody's
 * permissions file, and that calculation shipped a Critical — see
 * `collapseEntry` below. A pure module is a module a `repro-*.ts` can drive
 * with `npx tsx`; a `.tsx` that imports the design system is not.
 */

// ── the tree, derived from the vocabulary's own keys ────────────────────

export interface Node {
  key: string;
  label: string;
  isLeaf: boolean;
  leaf?: PermissionLeaf;
  children: Node[];
}

/** "webhookHealth" -> "Webhook health". Branches have no label of their own to show. */
export function prettyLabel(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Account ids are not names.
 *
 * A branch reading as twelve raw digits tells nobody which estate they are about to
 * grant remediation in, and picking the wrong twelve-digit number is precisely
 * how somebody grants it in production. Given the configured accounts, the
 * branch is labelled the way people refer to it, with the id kept alongside
 * because two accounts can share a name.
 */
export type AccountNames = Readonly<Record<string, string>>;

function labelFor(key: string, segment: string, accounts: AccountNames): string {
  const parts = key.split(".");
  if (parts.length === 3 && parts[0] === "aws" && parts[1] === "account") {
    const name = accounts[segment];
    return name ? `${name} (${segment})` : segment;
  }
  return prettyLabel(segment);
}

export function buildTree(
  vocabulary: readonly PermissionLeaf[], accounts: AccountNames = {},
): Node[] {
  const roots: Node[] = [];
  const branches = new Map<string, Node>();

  function ensureBranch(key: string): Node {
    const existing = branches.get(key);
    if (existing) return existing;
    const parts = key.split(".");
    const node: Node = { key, label: labelFor(key, parts[parts.length - 1], accounts), isLeaf: false, children: [] };
    branches.set(key, node);
    if (parts.length === 1) roots.push(node);
    else ensureBranch(parts.slice(0, -1).join(".")).children.push(node);
    return node;
  }

  for (const leaf of vocabulary) {
    const parts = leaf.key.split(".");
    const leafNode: Node = { key: leaf.key, label: leaf.label, isLeaf: true, leaf, children: [] };
    if (parts.length === 1) roots.push(leafNode);
    else ensureBranch(parts.slice(0, -1).join(".")).children.push(leafNode);
  }
  return roots;
}

export function collectLeafKeys(node: Node, out: string[] = []): string[] {
  if (node.isLeaf) { out.push(node.key); return out; }
  for (const child of node.children) collectLeafKeys(child, out);
  return out;
}

/** Every branch and leaf key the vocabulary implies, for `decideLeaf`'s known-node test. */
export function knownNodesOf(vocabulary: readonly PermissionLeaf[]): Set<string> {
  const out = new Set<string>();
  for (const leaf of vocabulary) {
    out.add(leaf.key);
    const parts = leaf.key.split(".");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return out;
}

// ── deciding a leaf across layers, the same way the server does ─────────

const depthOf = (node: string) => node.split(".").length;

/** The longest, highest-layer match wins; a tie goes to revoke. Same order as `decideLeaf` server-side. */
export function decideLeaf(leafKey: string, rules: FlatRule[], knownNodes: ReadonlySet<string>): FlatRule | null {
  let best: FlatRule | null = null;
  for (const rule of rules) {
    if (!knownNodes.has(rule.node)) continue;
    if (!(leafKey === rule.node || leafKey.startsWith(rule.node + "."))) continue;
    if (!best) { best = rule; continue; }
    const a = [depthOf(rule.node), rule.layer, rule.effect === "revoke" ? 1 : 0];
    const b = [depthOf(best.node), best.layer, best.effect === "revoke" ? 1 : 0];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] > b[i]) best = rule;
      break;
    }
  }
  return best;
}

export function ownRulesFrom(entry: PermissionEntry, layer: number): FlatRule[] {
  return [
    ...(entry.grant ?? []).map(node => ({ node, effect: "grant" as const, layer, origin: "Granted here" })),
    ...(entry.revoke ?? []).map(node => ({ node, effect: "revoke" as const, layer, origin: "Revoked here" })),
  ];
}

/** What the layers *beneath* this one decide, on their own. The baseline every edit is a diff against. */
export function baselineOf(
  vocabulary: readonly PermissionLeaf[], inherited: FlatRule[], knownNodes: ReadonlySet<string>,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const leaf of vocabulary) {
    out.set(leaf.key, decideLeaf(leaf.key, inherited, knownNodes)?.effect === "grant");
  }
  return out;
}

/** Nothing to say about this node: the inherited layers already decide it correctly. */
type Opinion = "grant" | "revoke" | "none";

/**
 * The minimal `{grant, revoke}` that turns `baseline` into `desired`.
 *
 * **It is a diff, not a snapshot.** It used to be handed the *resolved* state
 * and asked for the entry that would produce it if this layer were the only
 * one — which meant one click wrote an explicit person-layer `grant` for
 * everything the person already held through a team or a preset, and an
 * explicit person-layer `revoke` for every branch they did not. Two things
 * followed, and both were reproduced against the server's own evaluator:
 *
 *   - Ticking a single Overview checkbox saved `revoke: ["aws"]`, stripping
 *     fourteen AWS leaves nobody had touched, because a person-layer revoke
 *     beats the team grant that was giving them. Nothing on screen said so.
 *   - Everything the person held through their GitHub team was frozen into
 *     their own entry, so removing them from that team on GitHub stopped
 *     removing their access — and the written `revoke: ["admin"]`,
 *     `revoke: ["access"]` pre-emptively blocked every future team or preset
 *     grant of those branches.
 *
 * So a node produces a rule only where `desired` disagrees with what the
 * inherited layers alone decide. A branch whose whole subtree disagrees in the
 * same direction collapses to one rule — which is what keeps a leaf added to
 * the vocabulary later inside that grant — and a branch nobody touched
 * produces nothing at all.
 */
export function collapseEntry(
  desired: ReadonlyMap<string, boolean>,
  roots: Node[],
  baseline: ReadonlyMap<string, boolean>,
): PermissionEntry {
  const grant: string[] = [];
  const revoke: string[] = [];

  function visit(node: Node): Opinion {
    if (node.isLeaf) {
      const want = desired.get(node.key) ?? false;
      if (want === (baseline.get(node.key) ?? false)) return "none";
      return want ? "grant" : "revoke";
    }
    if (node.children.length === 0) return "none";

    const values = node.children.map(visit);
    if (values[0] !== "none" && values.every(v => v === values[0])) return values[0];

    node.children.forEach((child, i) => {
      const v = values[i];
      if (v !== "none") (v === "grant" ? grant : revoke).push(child.key);
    });
    return "none";
  }

  for (const root of roots) {
    const v = visit(root);
    if (v !== "none") (v === "grant" ? grant : revoke).push(root.key);
  }

  return { grant: grant.length ? grant : undefined, revoke: revoke.length ? revoke : undefined };
}
