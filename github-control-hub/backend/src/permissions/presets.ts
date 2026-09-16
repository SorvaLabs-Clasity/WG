import type { Preset, PermissionEntry } from "./types";

/**
 * One grant or revoke, flattened out of wherever it was written.
 *
 * The resolver sees only a list of these, which is what lets team entries,
 * preset entries and a person's own entries be compared by one rule instead of
 * three.
 */
export interface Rule {
  /** A node: a leaf, or a branch standing for every leaf beneath it. */
  node: string;
  effect: "grant" | "revoke";
  /**
   * Ordering *within one `inherits` chain*, used only for preset inheritance: a
   * child's own entries outrank the parent's, so "inherit Engineer, but not that
   * one thing" is writable. Higher wins.
   *
   * It is chain-relative, so it means nothing between rules from different
   * chains. `resolvePreset` therefore settles it before returning and nothing
   * outside this file compares it; it survives only so the admin screen can say
   * which preset in a chain had the last word.
   */
  sublayer: number;
  /** Shown in the admin UI: "from Engineer", "granted here". Never used to decide. */
  origin: string;
}

/** How deep an `inherits` chain may go before it is a mistake rather than a design. */
export const MAX_INHERIT_DEPTH = 4;

function rulesOf(entry: PermissionEntry, sublayer: number, origin: string): Rule[] {
  return [
    ...(entry.grant ?? []).map(node => ({ node, effect: "grant" as const, sublayer, origin })),
    ...(entry.revoke ?? []).map(node => ({ node, effect: "revoke" as const, sublayer, origin })),
  ];
}

/**
 * A preset and everything it inherits, flattened.
 *
 * Walks up to the root first so that the deepest ancestor gets the lowest
 * sublayer, then the chain back down raises it — the preset asked for always
 * ends up highest.
 *
 * At most one rule per node comes back: within a chain the most-derived preset
 * has the last word, so the chain is reduced here rather than leaving a stack of
 * superseded rules for the resolver to compare. That keeps `sublayer` a
 * within-chain concern; comparing it against a rule from an unrelated chain
 * would pre-empt the revoke-wins tie-break and grant where the spec says revoke.
 *
 * An unknown id, a cycle or an over-deep chain all resolve to nothing rather
 * than throwing. The file is somebody's data; `presetProblems` reports what is
 * wrong with it, and the caller fails it closed. A throw here would take down
 * every request instead. A present-but-not-an-object entry (`null`, a string, a
 * hand-edited mistake) is tolerated the same way as a missing one, for the same
 * reason: `!preset` is true for `null` exactly as it is for `undefined`, and
 * nothing below this line dereferences the entry without checking it first.
 */
export function resolvePreset(
  presets: Record<string, Preset>, id: string, layerLabel: string,
): Rule[] {
  const chain: string[] = [];
  let cursor: string | undefined = id;
  const seen = new Set<string>();

  while (cursor) {
    if (seen.has(cursor)) return [];              // cycle
    if (chain.length >= MAX_INHERIT_DEPTH + 1) return [];  // runaway
    const preset: Preset | undefined = presets[cursor];
    if (!preset) return chain.length === 0 ? [] : finish(chain, presets, layerLabel);
    seen.add(cursor);
    chain.push(cursor);
    cursor = preset.inherits;
  }
  return finish(chain, presets, layerLabel);
}

/**
 * `chain` is child-first; sublayer counts up so the child ends highest, and the
 * highest sublayer per node is the only one that survives.
 *
 * A preset that both grants and revokes the same node at once is a file that
 * contradicts itself at a single point; revoke wins there, the same answer the
 * resolver gives two teams that disagree.
 */
function finish(chain: string[], presets: Record<string, Preset>, layerLabel: string): Rule[] {
  const byNode = new Map<string, Rule>();
  const deepestFirst = [...chain].reverse();
  deepestFirst.forEach((presetId, index) => {
    const preset = presets[presetId];
    if (!preset) return;
    for (const rule of rulesOf(preset, index, `${layerLabel} ${preset.name}`)) {
      const held = byNode.get(rule.node);
      const wins = !held
        || rule.sublayer > held.sublayer
        || (rule.sublayer === held.sublayer && rule.effect === "revoke");
      if (wins) byNode.set(rule.node, rule);
    }
  });
  return [...byNode.values()];
}

/**
 * Everything wrong with a set of presets, as sentences.
 *
 * Reported rather than thrown for the same reason as the vocabulary: the caller
 * decides what a broken file means, and it means fail closed.
 */
export function presetProblems(presets: Record<string, Preset>): string[] {
  const problems: string[] = [];

  for (const [id, preset] of Object.entries(presets)) {
    // Defence in depth: `validate.ts` is expected to hand this a map already
    // filtered to object entries and to report a null/non-object preset
    // itself, but this function must never throw on whatever it is handed —
    // a throw is a fail-*open* path for the caller that gates evaluation on
    // it. Skip rather than report: the more specific report is validate.ts's
    // job, and duplicating it here would just be the other half of finding 4.
    if (!preset || typeof preset !== "object") continue;
    if (!preset.name) problems.push(`preset "${id}" has no name`);
    if (!preset.inherits) continue;

    if (!presets[preset.inherits]) {
      problems.push(`preset "${id}" inherits "${preset.inherits}", which does not exist`);
      continue;
    }

    const seen = new Set<string>([id]);
    let cursor: string | undefined = preset.inherits;
    let depth = 1;
    while (cursor) {
      if (seen.has(cursor)) { problems.push(`preset "${id}" is in an inheritance cycle`); break; }
      if (depth > MAX_INHERIT_DEPTH) {
        problems.push(`preset "${id}" inherits more than ${MAX_INHERIT_DEPTH} deep`);
        break;
      }
      seen.add(cursor);
      cursor = presets[cursor]?.inherits;
      depth++;
    }
  }
  return problems;
}
