/**
 * The one AWS account this app watches: the one it runs in.
 *
 * ## Why there is only one
 *
 * This began as a registry. An organisation could add accounts, each reached by
 * a role it deployed, or by an access key pair kept in Secrets Manager, and the
 * sweep ran across all of them. It worked, and the cost of it was a permission
 * the app had to hold permanently: `sts:AssumeRole` on a role name in *any*
 * account, plus the ability to create and read secrets holding other accounts'
 * credentials, plus `organizations:ListAccounts` to discover them.
 *
 * That is a large standing capability for a tool whose job is to report. It has
 * been removed, along with the screen that used it. What is left needs no
 * assumption, no stored keys and no organisation access: the engine runs with
 * the credentials the process already has, against the account those
 * credentials belong to, and can reach nothing else.
 *
 * The account is still discovered rather than configured — `sts:GetCallerIdentity`
 * answers it — because every finding is stamped with the account it came from,
 * and a hardcoded id would label somebody else's estate with our name.
 */
import { awsRegion, resolveAwsRegion } from "../utils/region";
import type { AwsAccount, Scope } from "./types";

const REGION = awsRegion();
const PREFIX = process.env.STACK_NAME || "github-control-hub";

/**
 * A region to record against the account.
 *
 * Asked of the SDK rather than guessed. Storing "us-east-1" here was the quiet
 * version of the bug: the account would be swept in a region it has nothing in,
 * report zero findings, and look healthy.
 */
async function homeRegion(): Promise<string> {
  return (await resolveAwsRegion()) ?? "";
}

/**
 * Regions to sweep, when the org config names them.
 *
 * An installation that has never chosen gets the one region the app runs in,
 * which is at least a region somebody picked.
 */
async function configuredRegions(): Promise<string[]> {
  try {
    const { getOrgConfig } = await import("../services/orgConfigService");
    const config: any = await getOrgConfig();
    const regions = config?.awsRegions;
    if (Array.isArray(regions) && regions.length > 0) return regions;
  } catch { /* a missing preference must not stop a sweep */ }
  const here = await homeRegion();
  return here ? [here] : [];
}

let homeIdCache: string | undefined;

/** Which account these credentials belong to. */
export async function homeAccountId(): Promise<string> {
  if (homeIdCache) return homeIdCache;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region: REGION });
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    homeIdCache = Account ?? "unknown";
  } catch (err: any) {
    // Every finding is stamped with the account it came from, so failing
    // silently here would label the whole estate "unknown".
    throw new Error(
      `Could not work out which AWS account this app is running in: ${err?.message ?? err}. ` +
      `Check that the app has AWS credentials.`
    );
  }
  return homeIdCache!;
}

/**
 * Forget which account this is.
 *
 * Cached because it is a network call whose answer could not change — which
 * stopped being true when the app learned to switch accounts. Every finding is
 * stamped with this, so a stale one files the account you moved to under the
 * name of the one you left.
 */
export function resetHomeAccountCache(): void {
  homeIdCache = undefined;
}

/** Test seam. The name is kept because the existing suites call it. */
export const __resetHomeAccountCache = resetHomeAccountCache;

/**
 * The account to run against. Always exactly one.
 *
 * Returned as an array because the engine sweeps a list, and keeping that shape
 * means the engine did not have to change when the registry went away.
 */
export async function resolveAccounts(): Promise<AwsAccount[]> {
  const accountId = await homeAccountId();
  return [{
    accountId,
    name: "This account",
    regions: await configuredRegions(),
    enabled: true,
    isHome: true,
    createdBy: "system",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }];
}

/**
 * Credentials for the account: always the ambient ones.
 *
 * Undefined means "use the credential chain the process already has", which is
 * the only thing this app can do now. There is no role to assume and no key
 * pair to fetch, which is the point — a compromise of the engine cannot reach
 * an account other than the one it already runs in.
 */
export async function credentialsFor(_account: AwsAccount): Promise<undefined> {
  return undefined;
}

/**
 * Where to sweep.
 *
 * An account with no regions is swept nowhere, and that is the honest outcome —
 * a region invented here would be one nobody chose, and the sweep would report
 * a clean bill of health for somewhere it never looked.
 */
export function scopesFor(accounts: AwsAccount[]): Omit<Scope, "credentials">[] {
  return accounts
    .filter(a => a.enabled)
    .flatMap(a => a.regions
      .map(region => ({ accountId: a.accountId, accountName: a.name, region })));
}

/** Kept so the guardrail tables' naming stays in one place. */
export const ACCOUNTS_TABLE = process.env.ORG_CONFIG_TABLE || `${PREFIX}-org-config`;
export { PREFIX as GUARDRAIL_PREFIX };
