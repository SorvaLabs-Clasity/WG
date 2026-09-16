import type { PermissionsFile, PermissionEntry } from "./types";
import { resolvePreset, type Rule } from "./presets";
import { isKnownNode } from "./vocabulary";

/**
 * Where a rule was written, in increasing authority.
 *
 * Teams are lowest because membership lives on GitHub and changes without
 * anybody editing this file — so it is the layer a person should be able to
 * override, not the other way round.
 */
export const LAYER = { team: 0, preset: 1, person: 2 } as const;

export interface LayeredRule extends Rule {
  layer: number;
}

function ownRules(entry: PermissionEntry, layer: number, origin: string): LayeredRule[] {
  return [
    ...(entry.grant ?? []).map(node => ({ node, effect: "grant" as const, sublayer: 99, origin, layer })),
    ...(entry.revoke ?? []).map(node => ({ node, effect: "revoke" as const, sublayer: 99, origin, layer })),
  ];
}

/**
 * Every rule that could bear on this person, flattened across the three layers.
 *
 * Order does not matter here — the resolver sorts — so this is a plain
 * concatenation. `sublayer: 99` on direct entries puts them above anything
 * inherited within the same layer, which is what "my own grant beats my
 * preset's" means when both sit at the same depth.
 */
export function collectRules(
  file: PermissionsFile, login: string, teamSlugs: string[],
): LayeredRule[] {
  const out: LayeredRule[] = [];
  const key = login.toLowerCase();

  for (const slug of teamSlugs) {
    const team = file.teams?.[slug];
    if (!team) continue;
    for (const presetId of team.presets ?? []) {
      out.push(...resolvePreset(file.presets ?? {}, presetId, `team ${slug} via`)
        .map(r => ({ ...r, layer: LAYER.team })));
    }
    out.push(...ownRules(team, LAYER.team, `team ${slug}`));
  }

  const person = file.people?.[key];
  if (!person) return out;

  for (const presetId of person.presets ?? []) {
    out.push(...resolvePreset(file.presets ?? {}, presetId, "preset")
      .map(r => ({ ...r, layer: LAYER.preset })));
  }
  out.push(...ownRules(person, LAYER.person, "set on this person"));

  return out;
}

export interface Decision {
  held: boolean;
  /** The rule that decided it, for the admin screen. Null when nothing matched. */
  rule: LayeredRule | null;
}

/** On a segment boundary: `me` must not match `members.read`. */
function covers(node: string, leaf: string): boolean {
  return leaf === node || leaf.startsWith(node + ".");
}

const depthOf = (node: string) => node.split(".").length;

/**
 * Whether this person holds one leaf, and which rule said so.
 *
 * **The longest match decides.** Depth first, because specificity is the
 * strongest signal of intent: somebody who wrote `aws.findings.read` meant that
 * leaf more precisely than whoever wrote `aws`. Only at equal depth does it
 * matter who wrote it — person over preset over team — and only at equal depth
 * *and* layer does revoke win over grant, which is the safe answer when two
 * teams disagree.
 *
 * The alternative, union-the-grants-then-subtract-the-revokes, cannot express
 * "none of AWS except the findings": the shallow revoke eats the deep grant and
 * the file gives no sign that it did.
 *
 * A rule naming a node the vocabulary does not have decides nothing. That keeps
 * a renamed or deleted branch from silently continuing to grant, and it is why
 * an unknown node is tolerated at read time rather than failing the file.
 */
export function decideLeaf(leaf: string, rules: LayeredRule[]): Decision {
  let best: LayeredRule | null = null;

  for (const rule of rules) {
    if (!isKnownNode(rule.node)) continue;
    if (!covers(rule.node, leaf)) continue;
    if (!best) { best = rule; continue; }

    const a = [depthOf(rule.node), rule.layer, rule.sublayer, rule.effect === "revoke" ? 1 : 0];
    const b = [depthOf(best.node), best.layer, best.sublayer, best.effect === "revoke" ? 1 : 0];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] > b[i]) best = rule;
      break;
    }
  }

  return { held: best?.effect === "grant", rule: best };
}
