import { AwsAccount, AwsCredentials, Scope } from "./types";

/**
 * The accounts the guardrails run against, and how to reach them.
 *
 * The account hosting the app is always in the list and never needs a role —
 * it is reached with the ambient credentials the Lambda already has. Everything
 * else is reached by assuming a role that account granted, so access is revoked
 * where the resources live rather than by hunting down a stored key.
 *
 * A registry with no rows behaves exactly as the single-account version did.
 * That is the point: adding this feature must not require configuring it.
 */

const REGION = process.env.AWS_REGION || "us-east-1";
const PREFIX = process.env.STACK_NAME || "github-control-hub";

export const ACCOUNTS_TABLE = process.env.AWS_ACCOUNTS_TABLE || `${PREFIX}-aws-accounts`;

/** Session name on the assumed role, so CloudTrail in the target account says who. */
const SESSION_NAME = "control-hub-guardrails";

/**
 * Assumed credentials are good for an hour; renew with five minutes to spare so
 * a sweep that starts just before expiry does not fail halfway through.
 */
const RENEW_BEFORE_MS = 5 * 60_000;

let docClientCache: any;
async function docClient() {
  if (docClientCache) return docClientCache;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  docClientCache = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return docClientCache;
}

/** Registered accounts, exactly as stored. Does not include the implicit home account. */
export async function listRegisteredAccounts(): Promise<AwsAccount[]> {
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  const items: AwsAccount[] = [];
  let key: any;
  do {
    const page: any = await client.send(new ScanCommand({ TableName: ACCOUNTS_TABLE, ExclusiveStartKey: key }));
    items.push(...((page.Items ?? []) as AwsAccount[]));
    key = page.LastEvaluatedKey;
  } while (key);
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function putAccount(account: AwsAccount): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  await client.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: account }));
}

export async function deleteAccount(accountId: string): Promise<void> {
  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  await client.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId } }));
}

let homeIdCache: string | undefined;

/** The account we are running in, asked of AWS rather than configured. */
export async function homeAccountId(): Promise<string> {
  if (homeIdCache) return homeIdCache;
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: REGION });
  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  homeIdCache = Account ?? "unknown";
  return homeIdCache!;
}

/**
 * Every account to run against, home first.
 *
 * The home account is synthesised rather than required in the table, so an
 * installation that has never opened the accounts page still gets swept. If it
 * *has* been registered — to rename it, restrict its regions, or turn it off —
 * those settings win, but it still needs no role: an account cannot lock the
 * app out of itself by mistyping an ARN.
 */
export async function resolveAccounts(): Promise<AwsAccount[]> {
  const [home, registered] = await Promise.all([homeAccountId(), listRegisteredAccounts().catch(() => [])]);

  const stored = registered.find(a => a.accountId === home);
  const homeAccount: AwsAccount = {
    accountId: home,
    name: stored?.name || "This account",
    regions: stored?.regions?.length ? stored.regions : [REGION],
    enabled: stored ? stored.enabled : true,
    isHome: true,
    roleArn: undefined,
    createdBy: stored?.createdBy ?? "system",
    createdAt: stored?.createdAt ?? new Date(0).toISOString(),
    updatedAt: stored?.updatedAt ?? new Date(0).toISOString(),
  };

  const others = registered
    .filter(a => a.accountId !== home)
    .map(a => ({ ...a, isHome: false, regions: a.regions?.length ? a.regions : [REGION] }));

  return [homeAccount, ...others];
}

interface CachedCredentials {
  credentials: AwsCredentials;
  expiresAt: number;
}
const credentialCache = new Map<string, CachedCredentials>();

/**
 * Credentials for an account, assuming its role if it has one.
 *
 * Cached until shortly before they expire: a sweep across four accounts and two
 * regions each asks eight times, and eight AssumeRole calls for one hour's work
 * is noise in CloudTrail that makes real access harder to spot.
 */
export async function credentialsFor(account: AwsAccount): Promise<AwsCredentials | undefined> {
  if (!account.roleArn) return undefined;   // home account: ambient role

  const cached = credentialCache.get(account.accountId);
  if (cached && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.credentials;

  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: REGION });
  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: account.roleArn,
    RoleSessionName: SESSION_NAME,
    ...(account.externalId && { ExternalId: account.externalId }),
  }));

  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey) {
    throw new Error(`Assumed ${account.roleArn} but got no credentials back`);
  }

  const credentials: AwsCredentials = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretAccessKey,
    sessionToken: Credentials.SessionToken,
    expiration: Credentials.Expiration,
  };
  credentialCache.set(account.accountId, {
    credentials,
    expiresAt: Credentials.Expiration?.getTime() ?? Date.now() + 3_600_000,
  });
  return credentials;
}

/** Every (account, region) pair to visit, in a stable order. */
export function scopesFor(accounts: AwsAccount[]): Omit<Scope, "credentials">[] {
  return accounts
    .filter(a => a.enabled)
    .flatMap(a => (a.regions.length ? a.regions : [REGION])
      .map(region => ({ accountId: a.accountId, accountName: a.name, region })));
}

/**
 * Can we actually reach this account?
 *
 * Called when an account is added, so a role that was never created — or whose
 * trust policy names the wrong principal — is reported to the person typing the
 * ARN rather than discovered as an empty findings list three hours later.
 *
 * Also confirms the role lands in the account they said it would: an ARN
 * pointing somewhere else would silently sweep the wrong estate under the right
 * name.
 */
export async function verifyAccess(account: AwsAccount): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const credentials = await credentialsFor(account);
    if (!credentials) return { ok: true };   // home account, nothing to assume

    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region: account.regions[0] || REGION, credentials });
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));

    if (Account && Account !== account.accountId) {
      return {
        ok: false,
        error: `That role lands in account ${Account}, not ${account.accountId}. ` +
          `Check the account id — sweeping the wrong estate under the right name is worse than not sweeping it.`,
      };
    }
    return { ok: true };
  } catch (err: any) {
    const name = err?.name ?? "";
    if (name === "AccessDenied" || name === "AccessDeniedException") {
      return {
        ok: false,
        error: `Not allowed to assume ${account.roleArn}. The role's trust policy has to name this app's Lambda role as a principal` +
          (account.externalId ? ", and require exactly the external ID given here." : "."),
      };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Forget cached credentials for an account — used when its role changes. */
export function forgetCredentials(accountId: string): void {
  credentialCache.delete(accountId);
}
