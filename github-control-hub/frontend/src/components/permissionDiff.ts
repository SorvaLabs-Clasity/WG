import type { PermissionLeaf, PermissionEntry, FlatRule } from "../api/admin";
import { decideLeaf, ownRulesFrom, knownNodesOf } from "./permissionTreeModel";

/**
 * What a save will actually change, per account, in the words of the tree.
 *
 * An entry is a set of grants and revokes at arbitrary depths, so two entries
 * that look nothing alike can decide the same thing, and two differing by one
 * character can decide something very different. Diffing the *entries* would
 * therefore report noise and miss substance.
 *
 * So this diffs what they **decide**: for every leaf, what the person holds
 * before against what they would hold after. That is the question somebody is
 * actually asking before they save, and it is the one a textual diff of JSON
 * cannot answer.
 */
export interface LeafChange {
  key: string;
  label: string;
}

export interface AccountDiff {
  accountId: string;
  name: string;
  gained: LeafChange[];
  lost: LeafChange[];
  /** Nothing decided differently here — worth saying, rather than showing a blank. */
  unchanged: boolean;
}

/** What one entry decides, leaf by leaf, on top of what the layers beneath decide. */
function decidedBy(
  vocabulary: readonly PermissionLeaf[],
  entry: PermissionEntry | undefined,
  baseline: Record<string, boolean>,
  inherited: FlatRule[],
  knownNodes: ReadonlySet<string>,
): Record<string, boolean> {
  const rules = [...inherited, ...ownRulesFrom(entry ?? {}, 2)];
  const out: Record<string, boolean> = {};
  for (const leaf of vocabulary) {
    const decided = decideLeaf(leaf.key, rules, knownNodes);
    out[leaf.key] = decided ? decided.effect === "grant" : (baseline[leaf.key] ?? false);
  }
  return out;
}

export function diffAccount(
  accountId: string,
  name: string,
  vocabulary: readonly PermissionLeaf[],
  before: PermissionEntry | undefined,
  after: PermissionEntry | undefined,
  baseline: Record<string, boolean>,
  inherited: FlatRule[],
): AccountDiff {
  const knownNodes = knownNodesOf(vocabulary);
  const b = decidedBy(vocabulary, before, baseline, inherited, knownNodes);
  const a = decidedBy(vocabulary, after, baseline, inherited, knownNodes);

  const gained: LeafChange[] = [];
  const lost: LeafChange[] = [];
  for (const leaf of vocabulary) {
    if (b[leaf.key] === a[leaf.key]) continue;
    (a[leaf.key] ? gained : lost).push({ key: leaf.key, label: leaf.label });
  }

  return { accountId, name, gained, lost, unchanged: gained.length === 0 && lost.length === 0 };
}

/**
 * What one person holds according to the file alone, in one account.
 *
 * Presets resolve additively — holding two is a statement that somebody should
 * have what both give — and the person's own grants and revokes sit on top,
 * where a revoke wins. This mirrors the server's `permissionsFor`; it is not a
 * second opinion, and where the two could disagree the server is right.
 *
 * **Teams are not in it.** The client knows which teams the signed-in person is
 * on and nobody else's, so a diff built from this understates what somebody
 * with team-derived access already holds. It is used only where the question is
 * "what does adding or removing *this preset* change", which is a question
 * about the file, and the screen says so rather than implying a full picture.
 */
export function heldFromFile(
  vocabulary: readonly PermissionLeaf[],
  presets: Record<string, { grant?: string[]; revoke?: string[]; inherits?: string }>,
  assigned: readonly string[],
  own: PermissionEntry | undefined,
  knownNodes: ReadonlySet<string>,
): Set<string> {
  const chainRules = (id: string): FlatRule[] => {
    const seen = new Set<string>();
    const chain: string[] = [];
    let cursor: string | undefined = id;
    while (cursor && !seen.has(cursor) && presets[cursor] && chain.length < 5) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = presets[cursor].inherits;
    }
    // Deepest-first, so a child's rule for a node outranks its parent's.
    const byNode = new Map<string, FlatRule>();
    for (const pid of [...chain].reverse()) {
      for (const node of presets[pid].grant ?? []) {
        byNode.set(node, { node, effect: "grant", layer: 1, origin: `preset ${pid}` });
      }
      for (const node of presets[pid].revoke ?? []) {
        byNode.set(node, { node, effect: "revoke", layer: 1, origin: `preset ${pid}` });
      }
    }
    return [...byNode.values()];
  };

  const held = new Set<string>();
  const ownRules = ownRulesFrom(own ?? {}, 2);

  for (const leaf of vocabulary) {
    // Presets add up: held if any assigned preset holds it on its own.
    const byAnyPreset = assigned.some(id => {
      const decided = decideLeaf(leaf.key, chainRules(id), knownNodes);
      return decided?.effect === "grant";
    });

    // The person's own layer decides over the presets, revoke winning on a tie.
    const mine = decideLeaf(leaf.key, ownRules, knownNodes);
    if (mine) {
      if (mine.effect === "grant") held.add(leaf.key);
      continue;
    }
    if (byAnyPreset) held.add(leaf.key);
  }
  return held;
}
