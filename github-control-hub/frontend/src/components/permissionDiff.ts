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
