/**
 * Per-account AWS permissions.
 *
 * `aws.rules.edit` means "in every account"; `aws.account.<id>.rules.edit`
 * means "in that one". The account id is a path segment rather than a separate
 * scope field, so the engine needs no new concept — prefix grants, revokes at
 * any depth and longest-prefix-wins all work on it unchanged. These are the
 * properties that has to keep being true.
 */
import {
  setConfiguredAccounts, currentVocabulary, permitsInAccount, scopedKey,
  accountOf, isAccountId, isKnownNodeNow, leavesUnderNow, globalKeyFor,
} from "./src/permissions/accountScope";
import { permissionsFor } from "./src/permissions/evaluate";
import { emptyFile, type PermissionsFile } from "./src/permissions/types";
import { PERMISSIONS } from "./src/permissions/vocabulary";
import { fileProblems } from "./src/permissions/validate";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const PROD = "0".repeat(11) + "1";
const DEV = "0".repeat(11) + "2";
const subject = (login: string) => ({ login, teamSlugs: [], isOrgOwner: false });

const fileWith = (grant: string[], revoke: string[] = []): PermissionsFile => ({
  ...emptyFile(), people: { alice: { grant, revoke } },
});

console.log("with no accounts configured, nothing changes");
{
  setConfiguredAccounts([]);
  check("the vocabulary is exactly the fixed list",
    currentVocabulary().length === PERMISSIONS.length, currentVocabulary().length);

  const global = permissionsFor(fileWith(["aws"]), subject("alice"));
  check("  and a global aws grant still works",
    global.has("aws.remediate") && global.has("aws.rules.enforce"));
  check("  and permitsInAccount falls back to the global key",
    permitsInAccount(k => global.has(k), PROD, "remediate"));
}

console.log("\nconfiguring accounts grows the tree, and only there");
{
  setConfiguredAccounts([PROD, DEV]);
  const vocab = currentVocabulary();
  check("every fixed leaf is still present",
    PERMISSIONS.every(p => vocab.some(v => v.key === p.key)));
  check("  and each account added a branch",
    vocab.some(v => v.key === scopedKey(PROD, "remediate"))
      && vocab.some(v => v.key === scopedKey(DEV, "remediate")));
  check("  with no leaf outside aws.account invented",
    vocab.filter(v => !PERMISSIONS.some(p => p.key === v.key))
      .every(v => v.key.startsWith("aws.account.")));

  check("an id that is not twelve digits is refused, not sanitised",
    !isAccountId("12") && !isAccountId("1234.5678.9012") && isAccountId(PROD),
    "a dotted id would invent sub-accounts a prefix grant would then cover");

  setConfiguredAccounts([PROD, DEV, "not-an-account", "12"]);
  check("  and is left out of the vocabulary entirely",
    currentVocabulary().filter(v => v.key.startsWith("aws.account.")).length
      === leavesUnderNow("aws.account").length
    && !currentVocabulary().some(v => v.key.includes("not-an-account")));
  setConfiguredAccounts([PROD, DEV]);
}

console.log("\nthe global form answers for every account");
{
  const held = permissionsFor(fileWith(["aws.remediate"]), subject("alice"));
  const has = (k: string) => held.has(k);
  check("holding aws.remediate permits remediation in prod",
    permitsInAccount(has, PROD, "remediate"));
  check("  and in dev",  permitsInAccount(has, DEV, "remediate"));
  check("  and in an account nobody has configured yet",
    permitsInAccount(has, "9".repeat(12), "remediate"),
    "a global grant that stopped at today's estate would quietly exclude tomorrow's");
  check("  but not a different action", !permitsInAccount(has, PROD, "rules.enforce"));
}

console.log("\nthe scoped form is a narrowing, not a second way in");
{
  const held = permissionsFor(fileWith([scopedKey(PROD, "remediate")]), subject("alice"));
  const has = (k: string) => held.has(k);
  check("holding it in prod permits prod", permitsInAccount(has, PROD, "remediate"));
  check("  and does not permit dev", !permitsInAccount(has, DEV, "remediate"));
  check("  and does not leak into another action in the same account",
    !permitsInAccount(has, PROD, "rules.enforce"));
}

console.log("\ngranting a branch and revoking one account is the shape people will write");
{
  /**
   * "Everything in AWS, except production." Longest prefix wins, so the revoke
   * of the account beats the grant of the branch — the engine's existing rule,
   * applied to a segment it has never seen before.
   */
  const held = permissionsFor(
    fileWith(["aws", "aws.account"], [`aws.account.${PROD}`]), subject("alice"));
  const has = (k: string) => held.has(k);

  check("dev is permitted", permitsInAccount(has, DEV, "remediate"));
  check("  and prod's scoped leaves are revoked",
    !held.has(scopedKey(PROD, "remediate")) && !held.has(scopedKey(PROD, "rules.enforce")));

  /**
   * And the honest caveat, asserted rather than left to be discovered: the
   * global `aws.remediate` is still held, and the global form answers for
   * every account — so "everything except prod" has to revoke the global keys
   * too, or use `aws.account` alone rather than `aws`.
   */
  check("  but the global grant still reaches prod, which is why the narrow form exists",
    permitsInAccount(has, PROD, "remediate"),
    "granting `aws` grants every account; the per-account form is `aws.account`");

  const narrow = permissionsFor(
    fileWith(["aws.read", "aws.account"], [`aws.account.${PROD}`]), subject("alice"));
  check("  and granting aws.account instead of aws gives the intended result",
    permitsInAccount(k => narrow.has(k), DEV, "remediate")
      && !permitsInAccount(k => narrow.has(k), PROD, "remediate"));
}

console.log("\nthe file validator accepts account nodes and still catches typos");
{
  check("a scoped grant is not reported as an unknown node",
    fileProblems(fileWith([scopedKey(PROD, "remediate")])).length === 0,
    fileProblems(fileWith([scopedKey(PROD, "remediate")])));
  check("  and `aws.account` is known even with no accounts configured",
    (() => { setConfiguredAccounts([]); const ok = isKnownNodeNow("aws.account");
             setConfiguredAccounts([PROD, DEV]); return ok; })(),
    "a grant naming it on an install whose account list has not loaded is not a typo");
  check("  while a genuine typo still is",
    !isKnownNodeNow("aws.acount.remediate") && !isKnownNodeNow("aws.account.remediate"));
}

console.log("\nthe helpers agree with the keys they build");
{
  check("accountOf reads the id back out", accountOf(scopedKey(PROD, "remediate")) === PROD);
  check("  and says nothing for a node outside the branch",
    accountOf("aws.remediate") === null && accountOf("alarms.org") === null);
  check("globalKeyFor maps an aws suffix", globalKeyFor("rules.edit") === "aws.rules.edit");
  check("  and leaves an activity suffix alone, because it is already a whole key",
    globalKeyFor("activity.undo") === "activity.undo");
  check("every scoped leaf's global counterpart exists in the fixed vocabulary",
    leavesUnderNow(`aws.account.${PROD}`)
      .map(k => globalKeyFor(k.split(".").slice(3).join(".")))
      .every(g => PERMISSIONS.some(p => p.key === g)),
    "a scoped leaf with no global form is one a global grant silently cannot cover");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
