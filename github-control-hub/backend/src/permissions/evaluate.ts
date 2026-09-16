import type { PermissionsFile, PermissionEntry } from "./types";
import { resolvePreset, type Rule } from "./presets";
import { isKnownNode, isUnder, PERMISSIONS } from "./vocabulary";

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
 * concatenation. "My own grant beats my preset's" falls out of `layer` alone,
 * since a person's entries and their presets sit at different layers. The
 * `sublayer: 99` on a direct entry only marks it as belonging to no inheritance
 * chain; the resolver does not compare it.
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
 * `sublayer` is deliberately absent from that comparison. It orders a preset
 * against the preset it inherits from, which `resolvePreset` has already settled
 * by the time a rule gets here; comparing it across unrelated chains — one
 * person's two sibling presets, or a team's preset against another team's own
 * entry — would decide on an accident of chain position and let a grant slip
 * past the revoke that should have won.
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
    if (!isUnder(leaf, rule.node)) continue;
    if (!best) { best = rule; continue; }

    const a = [depthOf(rule.node), rule.layer, rule.effect === "revoke" ? 1 : 0];
    const b = [depthOf(best.node), best.layer, best.effect === "revoke" ? 1 : 0];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] > b[i]) best = rule;
      break;
    }
  }

  return { held: best?.effect === "grant", rule: best };
}

export interface Subject {
  login: string;
  /** GitHub team slugs this person is in. Read by the caller; this is pure. */
  teamSlugs: string[];
  /**
   * Organization owners are exempt from every check.
   *
   * Otherwise an empty file, a broken file, or an administrator who removed
   * their own access locks everybody out of the one screen that could fix it.
   * The old team check had the same exemption; this keeps it and makes it
   * visible in `explain`, because access nobody can account for reads as a bug.
   */
  isOrgOwner: boolean;
}

export interface Explanation {
  held: boolean;
  reason: "owner" | "granted" | "revoked" | "not granted";
  /** "preset Engineer", "team platform", "set on this person". Null when nothing matched. */
  origin: string | null;
}

export interface PermissionSet {
  has(leaf: string): boolean;
  /** Every leaf held, sorted. */
  held: string[];
  explain(leaf: string): Explanation;
}

/**
 * What this person may do.
 *
 * Computed once over the whole vocabulary rather than lazily per question: the
 * vocabulary is small, the admin screen needs every answer at once anyway, and
 * a set that cannot change under a request is one fewer thing to reason about.
 */
export function permissionsFor(file: PermissionsFile, subject: Subject): PermissionSet {
  if (subject.isOrgOwner) {
    const all = PERMISSIONS.map(p => p.key).sort();
    return {
      has: () => true,
      held: all,
      explain: () => ({ held: true, reason: "owner", origin: "organization owner" }),
    };
  }

  const rules = collectRules(file, subject.login, subject.teamSlugs);
  const decisions = new Map<string, Decision>();
  for (const { key } of PERMISSIONS) decisions.set(key, decideLeaf(key, rules));

  const held = [...decisions.entries()]
    .filter(([, d]) => d.held).map(([key]) => key).sort();

  return {
    has: (leaf: string) => decisions.get(leaf)?.held === true,
    held,
    explain(leaf: string): Explanation {
      const decision = decisions.get(leaf);
      if (!decision?.rule) return { held: false, reason: "not granted", origin: null };
      return {
        held: decision.held,
        reason: decision.held ? "granted" : "revoked",
        origin: decision.rule.origin,
      };
    },
  };
}
