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
   * Ordering *within* a layer, used only for preset inheritance: a child's own
   * entries outrank the parent's, so "inherit Engineer, but not that one thing"
   * is writable. Higher wins.
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
 * An unknown id, a cycle or an over-deep chain all resolve to nothing rather
 * than throwing. The file is somebody's data; `presetProblems` reports what is
 * wrong with it, and the caller fails it closed. A throw here would take down
 * every request instead.
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

/** `chain` is child-first; sublayer counts up so the child ends highest. */
function finish(chain: string[], presets: Record<string, Preset>, layerLabel: string): Rule[] {
  const out: Rule[] = [];
  const deepestFirst = [...chain].reverse();
  deepestFirst.forEach((presetId, index) => {
    const preset = presets[presetId];
    if (!preset) return;
    out.push(...rulesOf(preset, index, `${layerLabel} ${preset.name}`));
  });
  return out;
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
