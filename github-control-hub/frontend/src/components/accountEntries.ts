import type { PermissionsFile, PersonEntry, AccountEntry } from "../api/admin";

/**
 * How a person's entry is read and written per account — in one place.
 *
 * An entry has two shapes. A **legacy** one has no `accounts` map: it was
 * written before accounts existed (the migration writes this shape) and it
 * applies in every account. Once an entry has any per-account entry, those are
 * the whole answer and the top-level fields stop counting.
 *
 * The server reads it that way in `sliceFor`. The console used to decide it
 * separately in four places and got two of them wrong: a migrated person showed
 * empty in every account tab, and "remove this preset from everyone" looked for
 * it in the per-account slots, found nothing, and reported that nothing would
 * change. The same rule written four times is four chances to disagree, so it
 * is written once here and tested.
 */

type Entryish = { presets?: string[]; grant?: string[]; revoke?: string[]; accounts?: Record<string, AccountEntry> };

export function isLegacy(entry: Entryish | undefined): boolean {
  return !entry?.accounts || Object.keys(entry.accounts).length === 0;
}

/** What applies to this person in one account. `accountId` null means accounts are not in play. */
export function sliceOf(entry: Entryish | undefined, accountId: string | null): AccountEntry {
  if (!entry) return {};
  if (accountId === null || isLegacy(entry)) {
    return { presets: entry.presets, grant: entry.grant, revoke: entry.revoke };
  }
  return entry.accounts?.[accountId] ?? {};
}

/**
 * Turn a legacy entry into per-account entries before editing one account.
 *
 * Required, not tidy: the moment an entry has one per-account entry, the
 * top-level fields stop counting. Writing a single account onto a legacy entry
 * without first copying its top-level into every other account would silently
 * strip the person everywhere else — the edit would look like it touched one
 * account and actually remove them from all the rest.
 */
export function materialise(entry: PersonEntry | undefined, accountIds: readonly string[]): PersonEntry {
  const base: PersonEntry = { ...(entry ?? {}) };
  if (!isLegacy(base) || accountIds.length === 0) return base;

  const copy = (): AccountEntry => ({
    presets: base.presets?.length ? [...base.presets] : undefined,
    grant: base.grant?.length ? [...base.grant] : undefined,
    revoke: base.revoke?.length ? [...base.revoke] : undefined,
  });

  return {
    ...base,
    presets: undefined,
    grant: undefined,
    revoke: undefined,
    accounts: Object.fromEntries(accountIds.map(id => [id, copy()])),
  };
}

/**
 * The file after giving `presetId` to — or taking it from — these people, in
 * these accounts. With no accounts declared, the top-level `presets` is edited.
 */
export function withPresetChange(
  file: PermissionsFile,
  logins: Iterable<string>,
  presetId: string,
  mode: "apply" | "remove",
  accountIds: readonly string[],
  allAccountIds: readonly string[],
): PermissionsFile {
  const people = { ...file.people };
  const scoped = allAccountIds.length > 0;

  const edit = (presets: string[] | undefined): string[] | undefined => {
    const held = new Set(presets ?? []);
    if (mode === "apply") held.add(presetId); else held.delete(presetId);
    return held.size ? [...held] : undefined;
  };

  for (const login of logins) {
    if (!scoped) {
      const person: PersonEntry = { ...(people[login] ?? {}) };
      person.presets = edit(person.presets);
      people[login] = person;
      continue;
    }

    // Every declared account, not just the ones being changed — see `materialise`.
    const person = materialise(people[login], allAccountIds);
    const byAccount = { ...(person.accounts ?? {}) };
    for (const accountId of accountIds) {
      const slice = { ...(byAccount[accountId] ?? {}) };
      slice.presets = edit(slice.presets);
      byAccount[accountId] = slice;
    }
    people[login] = { ...person, accounts: byAccount };
  }
  return { ...file, people };
}
