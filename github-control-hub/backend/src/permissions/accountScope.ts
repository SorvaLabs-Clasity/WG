import { PERMISSIONS, isUnder, type PermissionLeaf } from "./vocabulary";

/**
 * Which AWS accounts exist, and which one this install is.
 *
 * Permissions are scoped per account by the **entry**, not by the key: a
 * person's `accounts` map holds one set of grants per account id, over the
 * whole vocabulary. See `PersonEntry.accounts` and `collectRules`.
 *
 * There used to be a second mechanism here — an `aws.account.<id>.*` branch of
 * generated keys — and two mechanisms for one idea is one too many. It could
 * only scope a subset of the AWS permissions, so it could never express "read
 * Activity in sandbox but not production", and it put per-account access
 * three levels down inside the AWS branch where nobody could find it. The
 * registry below is all that survived, because the account *tabs* need to know
 * which accounts there are.
 */

/**
 * A twelve-digit AWS account id, and nothing else.
 *
 * The id keys the per-account entries, so a value that is not one names an
 * account no install will ever match — and everything written under it
 * silently decides nothing while reading as though it had taken effect.
 */
export function isAccountId(id: string): boolean {
  return /^[0-9]{12}$/.test(id);
}

/**
 * The declared accounts: the one this install runs in, plus whatever an
 * administrator has added in the Admin tab. Declaring one is not the same as
 * the app being able to reach it — credentials are separate — and the
 * permission tabs only need to know the account exists.
 */
let configured: readonly string[] = [];

export function setConfiguredAccounts(ids: readonly string[]): void {
  configured = [...new Set(ids.filter(isAccountId))].sort();
}

export function configuredAccounts(): readonly string[] {
  return configured;
}

/**
 * The account this install *is*.
 *
 * A request arriving at this process concerns the account this process runs
 * in, so every gate resolves against this one. The admin console edits entries
 * for every declared account because the file is shared; only this account's
 * entries decide anything here.
 *
 * Undefined until `resolveAccounts` has run, and undefined is meaningful: it
 * means accounts are not in play, and evaluation falls back to an entry's
 * top-level fields — which is every file written before accounts existed.
 */
let installAccount: string | undefined;

export function setInstallAccount(accountId: string | undefined): void {
  installAccount = accountId && isAccountId(accountId) ? accountId : undefined;
}

export function installAccountId(): string | undefined {
  return installAccount;
}

/**
 * The vocabulary. One fixed list — the account dimension lives on entries, so
 * declaring an account no longer adds keys.
 */
export function currentVocabulary(): PermissionLeaf[] {
  return [...PERMISSIONS];
}

const BRANCH_KEYS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const { key } of PERMISSIONS) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return out;
})();

export function isKnownNodeNow(node: string): boolean {
  return PERMISSIONS.some(l => l.key === node) || BRANCH_KEYS.has(node);
}

export function leavesUnderNow(node: string): string[] {
  return PERMISSIONS.filter(l => isUnder(l.key, node)).map(l => l.key);
}
