import { installAccountId, setInstallAccount, isAccountId } from "./accountScope";
import type { PermissionsFile } from "./types";

/**
 * Which AWS account this install *is* — resolved on demand, from anywhere.
 *
 * Every permission decision needs it, because the console writes a person's
 * permissions under an account id and an entry with per-account entries is
 * read for one account only. It used to be set in exactly two places: the
 * admin console's vocabulary read and the AWS accounts read. A signed-in
 * member touches neither, so for them the account was unknown, resolution fell
 * back to the top-level fields the console had emptied, and somebody holding
 * the `member` preset held nothing at all.
 *
 * That is the bug this file exists to make impossible: the answer is fetched
 * where it is needed rather than left to whichever route happens to run first.
 */

type Resolver = () => Promise<string>;

/** Overridden in tests; otherwise the STS call that names this account. */
let resolver: Resolver | null = null;

/**
 * When to try again after a failure.
 *
 * A call that fails on the request path must not be repeated per request —
 * that is how this app has held its own budget down before. Five minutes is
 * long enough to stop a storm and short enough that credentials arriving are
 * noticed without a restart.
 */
const RETRY_MS = 5 * 60_000;
let failedUntil = 0;
let lastError = "";

/** Test seam. */
export function __setAccountResolver(r: Resolver | null): void {
  resolver = r;
  failedUntil = 0;
  lastError = "";
}

/** Forget a failed lookup, so the next call asks again. */
export function forgetInstallAccount(): void {
  failedUntil = 0;
  lastError = "";
}

async function ask(): Promise<string> {
  if (resolver) return resolver();
  const { homeAccountId } = await import("../aws-guardrails/accounts");
  return homeAccountId();
}

export interface InstallAccount {
  /** The account to resolve against, or undefined when accounts are not in play. */
  accountId?: string;
  /**
   * Set when the account is needed and could not be worked out. The caller
   * answers "could not ask" rather than "you may not": the file's per-account
   * entries cannot be read for the wrong account, and guessing between two
   * declared accounts would grant somebody access in one nobody chose.
   */
  problem?: string;
}

/**
 * `declared` is the accounts the file names. With none, accounts are not in
 * play and resolution reads the entries' top-level fields, exactly as it did
 * before accounts existed.
 */
export async function installAccountFor(
  declared: readonly string[], now = Date.now(),
): Promise<InstallAccount> {
  const known = installAccountId();
  if (known) return { accountId: known };
  if (declared.length === 0) return {};

  if (now >= failedUntil) {
    try {
      const id = await ask();
      setInstallAccount(id);
      // `setInstallAccount` ignores anything that is not an account id, so read
      // it back rather than trusting what came in.
      const stored = installAccountId();
      if (stored) return { accountId: stored };
      lastError = `"${id}" is not an AWS account id`;
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    }
    failedUntil = now + RETRY_MS;
  }

  /**
   * One declared account is not a guess: the file names exactly one account, so
   * that is the account this install's entries are written under. Refusing
   * everybody because an STS call failed is the worse answer, and it is the one
   * that was shipping.
   */
  if (declared.length === 1) return { accountId: declared[0] };

  return {
    problem: `Could not work out which AWS account this app is running in, and the permissions `
      + `file names ${declared.length}, so its per-account entries cannot be read. ${lastError}`,
  };
}

/**
 * Every account this file has anything to say about: the ones it declares, and
 * the ones its entries are written under.
 *
 * Both, because they can disagree. The console offers a tab per account it can
 * see — which includes the account this install is in, whether or not anybody
 * declared it — so a person's permissions can sit under an account id the
 * `awsAccounts` list never mentions. Reading only the declared list there left
 * the account unknown and the entries unread, which is the same failure as
 * never resolving it at all.
 */
export function accountsNamedIn(file: PermissionsFile): string[] {
  const ids = new Set<string>();
  for (const a of file.awsAccounts ?? []) if (isAccountId(a.accountId)) ids.add(a.accountId);
  for (const entry of [...Object.values(file.people ?? {}), ...Object.values(file.teams ?? {})]) {
    for (const id of Object.keys((entry as { accounts?: Record<string, unknown> }).accounts ?? {})) {
      if (isAccountId(id)) ids.add(id);
    }
  }
  return [...ids];
}
