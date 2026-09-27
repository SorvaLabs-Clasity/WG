/**
 * Who may do something, said so that it is true.
 *
 * Refusals used to read "only members of the X team (or organization
 * owners)". Both halves stopped being true: owners no longer get in, and once
 * a permissions file is in force the team is not the rule — the permission
 * is. Somebody refused under enforcement was told to join a team that would
 * make them a full administrator, when what they needed was one permission.
 *
 * So the permission first, and the team only as what decides before a file
 * exists.
 */
export function onlyHolders(keys: readonly string[], team: string): string {
  const named = keys.map(k => `"${k}"`).join(" or ");
  return `Only people holding ${named} (or, before a permissions file is in force, `
    + `members of the "${team}" team)`;
}
