import type { PermissionsFile, PermissionEntry, Preset } from "./types";
import { resolvePreset, type Rule } from "./presets";
import { isKnownNode, isUnder, PERMISSIONS } from "./vocabulary";
import { CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

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
 *
 * `includeOwnEntry: false` leaves out the person's own `grant`/`revoke` and
 * nothing else — their presets stay, because a preset is a layer *beneath* the
 * person, not part of their entry. That is what `inheritedStanding` needs and
 * it is the only reason the option exists.
 */
export function collectRules(
  file: PermissionsFile, login: string, teamSlugs: string[],
  opts: { includeOwnEntry?: boolean } = {},
): LayeredRule[] {
  const includeOwnEntry = opts.includeOwnEntry !== false;
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
  if (includeOwnEntry) out.push(...ownRules(person, LAYER.person, "set on this person"));

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
  /**
   * GitHub could not be asked which teams this person is in, so `teamSlugs` is
   * empty because the question failed rather than because the answer is none.
   *
   * **A subject whose teams could not be read is not a subject with no teams.**
   * Absent — every hand-built subject in this repository — means the list is
   * complete. Present and true means it is not, and the caller has to decide
   * which way that failure points. For a *gate* an empty list denies, which is
   * closed and therefore safe to leave alone. For anything that compares two
   * evaluations of the same subject — the admin router's self-widening check —
   * it is fail-open: both sides lose the same teams, so granting `admin` to a
   * team the caller is in registers as no gain at all. Those callers must
   * refuse outright.
   */
  teamsUnavailable?: boolean;
}

export interface Explanation {
  held: boolean;
  reason: "owner" | "controlHubAdmin" | "inert" | "granted" | "revoked" | "not granted";
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
 * Everything, held.
 *
 * Two situations need exactly this set and must not drift apart: an
 * organization owner, exempt from every check below, and an install with no
 * GitHub organization at all, where there is no file, nothing to decide, and
 * every check passes. Writing the second as its own always-true object is how
 * the two quietly stop agreeing about what "everything" is after a permission
 * is added.
 *
 * It answers `has` without consulting the vocabulary on purpose: a leaf this
 * version does not know about is still held by somebody exempt from the
 * question, and `held` is the enumerable form for the admin screen.
 */
export function allPermissions(reason: Explanation["reason"], origin: string): PermissionSet {
  const all = PERMISSIONS.map(p => p.key).sort();
  return {
    has: () => true,
    held: all,
    explain: () => ({ held: true, reason, origin }),
  };
}

/**
 * What this person may do.
 *
 * Computed once over the whole vocabulary rather than lazily per question: the
 * vocabulary is small, the admin screen needs every answer at once anyway, and
 * a set that cannot change under a request is one fewer thing to reason about.
 */
export function permissionsFor(file: PermissionsFile, subject: Subject): PermissionSet {
  if (subject.isOrgOwner) return allPermissions("owner", "organization owner");

  /**
   * The Control Hub admin team holds everything, and is not configurable.
   *
   * The team already decides who may open the Admin tab, and somebody trusted
   * to hand out every permission in the organization is not usefully
   * restricted from using them. Splitting the two produced a role nobody
   * wanted — an administrator who can grant `aws.rules.enforce` to anybody
   * except themselves — and an entry in the file that looked like it governed
   * them while deciding nothing.
   *
   * So membership is the grant. Narrowing somebody means taking them off the
   * team, which is done on GitHub and is visible there, rather than leaving
   * them on it with a file entry that quietly contradicts it.
   *
   * Note this reads `teamSlugs`, so it inherits the `teamsUnavailable`
   * behaviour: a team listing that failed leaves the list empty and denies,
   * which is the safe direction and the same one the gate already takes.
   */
  if (subject.teamSlugs.includes(CONTROL_HUB_ADMIN_TEAM)) {
    return allPermissions("controlHubAdmin", `member of ${CONTROL_HUB_ADMIN_TEAM}`);
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

/**
 * What one preset's own `inherits` chain grants, leaf by leaf — the same
 * per-leaf shape `permissionsFor(...).explain` returns for a whole person,
 * computed here from a single chain rather than from a person's teams, presets
 * and own entries layered together.
 *
 * `frontend/src/api/admin.ts` used to hand-port `resolvePreset` for exactly
 * this — down to a duplicated `MAX_INHERIT_DEPTH` — so the Presets editor could
 * show what an `inherits` selection actually grants before it is saved. A hand
 * port is a drift hazard: if the tie rule or the depth cap ever changes here,
 * that screen would quietly start lying about what a preset grants. This is
 * what the admin route now serves instead, over `resolvePreset` itself rather
 * than a copy of it.
 *
 * A single chain needs no `layer` of its own to compete against — there is
 * only ever one candidate rule per node here, so every rule is placed at
 * layer 0 and `decideLeaf`'s depth-then-revoke tie-break applies within the
 * chain exactly as `resolvePreset` already resolved it.
 */
export function presetRules(presets: Record<string, Preset>, id: string): LayeredRule[] {
  return resolvePreset(presets, id, "preset").map(r => ({ ...r, layer: 0 }));
}

export function explainPreset(presets: Record<string, Preset>, id: string): Record<string, Explanation> {
  const rules = presetRules(presets, id);
  const out: Record<string, Explanation> = {};
  for (const { key } of PERMISSIONS) {
    const decision = decideLeaf(key, rules);
    out[key] = decision.rule
      ? { held: decision.held, reason: decision.held ? "granted" : "revoked", origin: decision.rule.origin }
      : { held: false, reason: "not granted", origin: null };
  }
  return out;
}

/**
 * What one *layer* of rules decides, leaf by leaf.
 *
 * The admin tree edits one layer as a **difference** from the layers beneath
 * it, so it needs their verdict on every leaf as a thing in its own right, not
 * as a side effect of the winning rule overall. This is that verdict.
 */
export function baselineOf(rules: LayeredRule[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const { key } of PERMISSIONS) out[key] = decideLeaf(key, rules).held;
  return out;
}

export interface Standing {
  /**
   * Every rule from the layers beneath, **at the depth it was written**.
   *
   * Not one rule per leaf. `decideLeaf` ranks depth above layer on both sides
   * of the wire, so a rule flattened to leaf depth on the way out is a rule
   * that outranks, in the client's tree, a shallower rule it loses to on the
   * server. That mismatch is what made un-ticking a branch show as unchanged on
   * screen while revoking fourteen leaves on save.
   */
  rules: LayeredRule[];
  /** What those rules alone decide. The baseline the tree diffs against. */
  baseline: Record<string, boolean>;
}

/**
 * What the layers **beneath this person** decide, on their own.
 *
 * The admin tree edits exactly one layer — the person's own `grant`/`revoke` —
 * and writes the shortest entry expressing the difference between what the
 * administrator ticked and what everything below already gives. So it needs
 * "what would this person hold if their own entry were empty", and that is a
 * different question from "what do they hold, with the rules that came from
 * their own entry filtered out of the answer".
 *
 * The screen used to ask the second one, by dropping every leaf whose winning
 * explanation read `set on this person`. A leaf the person's own `revoke` was
 * suppressing came back as "not granted" — which is what the baseline says for
 * a leaf nothing grants — so the revoke agreed with the baseline, no rule was
 * emitted for it, and the next unrelated tick rewrote the entry without it.
 * The team grant underneath returned, silently, with the tree still showing the
 * branch as not held.
 *
 * Evaluating the file with the entry genuinely removed cannot make that
 * mistake: a leaf the person revokes and their team grants is `true` here,
 * because the team grants it and the person's revoke is not in the room.
 */
export function inheritedStanding(file: PermissionsFile, subject: Subject): Standing {
  const rules = collectRules(file, subject.login, subject.teamSlugs, { includeOwnEntry: false });
  return { rules, baseline: baselineOf(rules) };
}

/**
 * The same thing for the Presets editor, whose layer beneath is one `inherits`
 * chain rather than a person's teams and presets.
 */
export function presetStanding(presets: Record<string, Preset>, id: string): Standing {
  const rules = presetRules(presets, id);
  return { rules, baseline: baselineOf(rules) };
}
