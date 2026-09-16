import type { PermissionsFile, PermissionEntry, PersonEntry, TeamEntry, Preset } from "./types";

/**
 * What a `PUT /file` actually asks for, derived from the diff rather than
 * trusted from the endpoint.
 *
 * `PUT /file` receives a whole file, the same shape whether the caller only
 * meant to toggle one person's note or meant to rewrite every preset in the
 * organization. Gating that route on one permission — historically
 * `admin.people.assign`, because it is the only write endpoint — let anybody
 * who could assign a preset also rewrite, create or delete every preset and
 * override any individual's permissions directly: three authorities the
 * table below keeps separate.
 *
 * This mirrors the rule `config.import` already follows for its own
 * multi-section bundle: a write is authorized section by section, by what it
 * actually changes, never by the coarsest thing the route is named after.
 *
 * Pure and unit-testable on purpose — no request, no store, just two files in
 * and the permission keys the difference between them requires.
 */

export const CHANGE_CLASS = {
  peopleAssign: "admin.people.assign",
  peopleOverride: "admin.people.override",
  presetsCreate: "admin.presets.create",
  presetsEdit: "admin.presets.edit",
  presetsDelete: "admin.presets.delete",
} as const;

/** Every permission a `PUT /file` write could ever require. Also the route's coarse gate. */
export const ALL_CHANGE_CLASSES: string[] = Object.values(CHANGE_CLASS);

/**
 * One entry out of a table keyed by whatever the file called it.
 *
 * A plain `table[id]` is a prototype read as well as an own-property read, so
 * ids the file is perfectly entitled to use — `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty` — came back as inherited `Object.prototype`
 * members instead of `undefined`. `!b && a` and `b && !a` were then never true
 * for them, so creating *and* deleting a preset called `constructor` both
 * classified as `admin.presets.edit`: `admin.presets.edit` alone was
 * sufficient to create and to delete presets, two of the three authorities
 * this whole module exists to keep apart, by choosing the id.
 *
 * `__proto__` is the same family — `JSON.parse` makes it an own property, so
 * `Object.hasOwn` sees it and a bare read does not necessarily — and is closed
 * by the same lookup.
 */
function own<T>(table: Record<string, T> | undefined, id: string): T | undefined {
  if (!table || !Object.hasOwn(table, id)) return undefined;
  return table[id];
}

function asSet(nodes: string[] | undefined): Set<string> {
  return new Set(nodes ?? []);
}

/** Same members, regardless of order — a reorder is not a change. */
function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const sa = asSet(a);
  const sb = asSet(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/** Whether `grant`/`revoke` differ between two entries. Missing is the same as empty. */
function entryOverrideChanged(before: PermissionEntry | undefined, after: PermissionEntry | undefined): boolean {
  return !sameSet(before?.grant, after?.grant) || !sameSet(before?.revoke, after?.revoke);
}

function presetsAssignmentChanged(before: PersonEntry | TeamEntry | undefined, after: PersonEntry | TeamEntry | undefined): boolean {
  return !sameSet(before?.presets, after?.presets);
}

/**
 * GitHub's numeric user id, which `types.ts` describes as the thing that makes
 * a renamed login detectable rather than silently orphaned. Removing or
 * changing it removes that detection, so it is an override of what the entry
 * says about who it is about.
 */
function idChanged(before: PersonEntry | undefined, after: PersonEntry | undefined): boolean {
  return (before?.id ?? undefined) !== (after?.id ?? undefined);
}

function noteChanged(before: PersonEntry | undefined, after: PersonEntry | undefined): boolean {
  // Missing and empty read the same: nobody writes an explicit "" note, and a
  // person entry that never had one should not register as having gained one.
  const b = before?.note?.trim() || undefined;
  const a = after?.note?.trim() || undefined;
  return b !== a;
}

function presetFieldsChanged(before: Preset | undefined, after: Preset | undefined): boolean {
  if (!before || !after) return false; // create/delete are their own classes, handled separately
  return before.name !== after.name
    || (before.description ?? undefined) !== (after.description ?? undefined)
    || (before.inherits ?? undefined) !== (after.inherits ?? undefined)
    || entryOverrideChanged(before, after);
}

/**
 * The permission keys this write requires, one per change class present in
 * the diff. **Never the single most specific class** — a write that both
 * assigns a preset to somebody and edits that preset's contents requires
 * both `admin.people.assign` and `admin.presets.edit`, because it does both
 * things.
 *
 * A no-op — `after` deep-equal to `before` in every field this function
 * looks at — returns no classes, which is what lets an unmodified save
 * (re-saving with a fresher `sha`, for instance) through even for a caller
 * who holds none of the five: it changes nothing, so nothing is asked of them.
 */
export function changeClasses(before: PermissionsFile, after: PermissionsFile): string[] {
  const classes = new Set<string>();

  /**
   * The format version decides how everything below it is read, so changing it
   * reinterprets every section at once rather than editing one of them. There
   * is no narrower authority that could be the right answer, and nothing in
   * the app has a reason to bump it through this route — the migration writes
   * its own file — so it asks for all five rather than for none, which is what
   * it asked for before.
   */
  if ((before.version ?? undefined) !== (after.version ?? undefined)) {
    for (const key of ALL_CHANGE_CLASSES) classes.add(key);
  }

  // ── people ──────────────────────────────────────────────────────────
  const peopleLogins = new Set([
    ...Object.keys(before.people ?? {}),
    ...Object.keys(after.people ?? {}),
  ]);
  for (const login of peopleLogins) {
    const b = own(before.people, login);
    const a = own(after.people, login);
    if (presetsAssignmentChanged(b, a)) classes.add(CHANGE_CLASS.peopleAssign);
    if (entryOverrideChanged(b, a) || noteChanged(b, a) || idChanged(b, a)) {
      classes.add(CHANGE_CLASS.peopleOverride);
    }
  }

  // ── teams ───────────────────────────────────────────────────────────
  // A single class covers the whole `teams` table: team membership changes
  // who a preset reaches exactly the way assigning a preset to a person does,
  // and the brief treats it as the same authority rather than splitting it
  // into its own override class.
  const teamSlugs = new Set([
    ...Object.keys(before.teams ?? {}),
    ...Object.keys(after.teams ?? {}),
  ]);
  for (const slug of teamSlugs) {
    const b = own(before.teams, slug);
    const a = own(after.teams, slug);
    if (!b && !a) continue;
    const changed = presetsAssignmentChanged(b, a) || entryOverrideChanged(b, a);
    if (changed) classes.add(CHANGE_CLASS.peopleAssign);
  }

  // ── presets ─────────────────────────────────────────────────────────
  const beforePresets = before.presets ?? {};
  const afterPresets = after.presets ?? {};
  const presetIds = new Set([...Object.keys(beforePresets), ...Object.keys(afterPresets)]);
  for (const id of presetIds) {
    const b = own(beforePresets, id);
    const a = own(afterPresets, id);
    if (!b && a) { classes.add(CHANGE_CLASS.presetsCreate); continue; }
    if (b && !a) { classes.add(CHANGE_CLASS.presetsDelete); continue; }
    if (presetFieldsChanged(b, a)) classes.add(CHANGE_CLASS.presetsEdit);
  }

  return [...classes];
}
