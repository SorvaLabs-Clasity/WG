import { AwsAccount, AwsCredentials, Scope, AwsAccessMethod } from "./types";
import { ActionableError } from "../utils/errorSanitizer";

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

/** Session name on the assumed role, so CloudTrail in the target account says who. */
const SESSION_NAME = "control-hub-guardrails";

/**
 * Assumed credentials are good for an hour; renew with five minutes to spare so
 * a sweep that starts just before expiry does not fail halfway through.
 */
const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * Roles to try in an account reached through AWS Organizations, in order.
 *
 * These already exist. AWS creates OrganizationAccountAccessRole in every
 * account opened through Organizations, and Control Tower creates its own
 * equivalent — so an organisation's accounts are reachable with nothing
 * deployed into them and no ARN to copy anywhere.
 *
 * The scoped role remains first because it is the one worth having: the others
 * carry AdministratorAccess, and using them means this app can do anything in
 * those accounts rather than the nine calls it actually makes.
 */
const ORGANIZATION_ROLES = [
  process.env.GUARDRAIL_ROLE_NAME || `${PREFIX}-guardrail-access`,
  "OrganizationAccountAccessRole",
  "AWSControlTowerExecution",
];

/** What `access` to assume for a record written before the field existed. */
export function accessMethod(account: AwsAccount): AwsAccessMethod {
  if (account.isHome) return "home";
  if (account.access) return account.access;
  if (account.roleArn) return "role";
  if (account.secretId) return "keys";
  return "organization";
}

/**
 * Accounts live as one row in the table the app already has, not in a table of
 * their own.
 *
 * A new table would have to be created before this feature worked at all, by
 * running a script — which is the exact setup step this feature exists to
 * remove. org-config is keyed on a single string and already holds more than
 * one kind of row, so one more costs nothing and works on an installation that
 * has changed nothing.
 *
 * The whole registry is one item. At roughly 300 bytes per account that is a
 * thousand accounts before DynamoDB's 400KB item limit is anywhere close, and
 * an organisation with a thousand AWS accounts has bigger questions than this.
 */
export const ACCOUNTS_TABLE = process.env.ORG_CONFIG_TABLE || `${PREFIX}-org-config`;
const ACCOUNTS_KEY = "aws-accounts";

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
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  try {
    const { Item } = await client.send(new GetCommand({
      TableName: ACCOUNTS_TABLE, Key: { org: ACCOUNTS_KEY },
    }));
    const accounts = (Item?.accounts ?? []) as AwsAccount[];
    return accounts.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err: any) {
    // No table means no accounts have ever been added, which is a legitimate
    // state and not a reason to fail. Sweeping the home account still works.
    if (err?.name === "ResourceNotFoundException") return [];
    throw err;
  }
}

async function writeAll(accounts: AwsAccount[]): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  try {
    await client.send(new PutCommand({
      TableName: ACCOUNTS_TABLE,
      Item: { org: ACCOUNTS_KEY, accounts, updatedAt: new Date().toISOString() },
    }));
  } catch (err: any) {
    if (err?.name === "ResourceNotFoundException") {
      throw new ActionableError(
        `The table "${ACCOUNTS_TABLE}" does not exist in this AWS account, so there is nowhere to save this. ` +
        `Run scripts/setup-aws-account.sh to create the app's tables.`,
      );
    }
    if (err?.name === "AccessDeniedException") {
      throw new ActionableError(
        `This app is not allowed to write to "${ACCOUNTS_TABLE}". Deploy the CDK stack to update its IAM role.`,
      );
    }
    throw err;
  }
}

export async function putAccount(account: AwsAccount): Promise<void> {
  const existing = await listRegisteredAccounts();
  const next = existing.filter(a => a.accountId !== account.accountId);
  next.push(account);
  await writeAll(next);
}

export async function deleteAccount(accountId: string): Promise<void> {
  const existing = await listRegisteredAccounts();
  await writeAll(existing.filter(a => a.accountId !== accountId));
}

let homeIdCache: string | undefined;

/** The account we are running in, asked of AWS rather than configured. */
export async function homeAccountId(): Promise<string> {
  if (homeIdCache) return homeIdCache;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region: REGION });
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    homeIdCache = Account ?? "unknown";
  } catch (err: any) {
    // Every finding is stamped with the account it came from, so this failing
    // silently would label the whole estate "unknown" and quietly make two
    // accounts look like one.
    throw new Error(
      `Could not work out which AWS account this app is running in: ${err?.message ?? err}. ` +
      `Check that the app has AWS credentials.`
    );
  }
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
  const method = accessMethod(account);
  if (method === "home") return undefined;   // ambient role

  const cached = credentialCache.get(account.accountId);
  if (cached && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.credentials;

  const credentials = method === "keys"
    ? await keysFromSecret(account)
    : await assumeFirstRoleThatWorks(account, method);

  credentialCache.set(account.accountId, {
    credentials,
    // Static keys do not expire, but re-reading the secret every hour is how a
    // rotated key takes effect without anyone restarting anything.
    expiresAt: credentials.expiration?.getTime() ?? Date.now() + 3_600_000,
  });
  return credentials;
}

/**
 * Try each candidate role until one lets us in.
 *
 * For an explicitly named role there is exactly one candidate and a failure is
 * a failure. For an organisation account the list is the point: we do not know
 * which of the standard roles that account has, and asking the user to find out
 * is the setup step this is meant to remove.
 */
async function assumeFirstRoleThatWorks(
  account: AwsAccount, method: AwsAccessMethod,
): Promise<AwsCredentials> {
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: REGION });

  const candidates = method === "role" && account.roleArn
    ? [account.roleArn]
    : ORGANIZATION_ROLES.map(name => `arn:aws:iam::${account.accountId}:role/${name}`);

  const refusals: string[] = [];
  for (const roleArn of candidates) {
    try {
      const { Credentials } = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: SESSION_NAME,
        ...(account.externalId && { ExternalId: account.externalId }),
      }));
      if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey) {
        throw new Error("no credentials came back");
      }
      account.reachedVia = roleArn.split("/").pop();
      return {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
        expiration: Credentials.Expiration,
      };
    } catch (err: any) {
      refusals.push(`${roleArn.split("/").pop()}: ${err?.name ?? err?.message ?? "refused"}`);
    }
  }

  throw new Error(
    candidates.length === 1
      ? `Could not assume ${candidates[0]} — ${refusals[0]}`
      : `None of the roles this app knows how to use exist in ${account.accountId}, or none of them trust this app. Tried ${refusals.join("; ")}.`
  );
}

/** An access key pair kept in Secrets Manager, never on the account record. */
async function keysFromSecret(account: AwsAccount): Promise<AwsCredentials> {
  if (!account.secretId) throw new Error(`No stored keys for ${account.accountId}`);
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: REGION });
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: account.secretId }));
  if (!SecretString) throw new Error(`The stored keys for ${account.accountId} are empty`);

  const parsed = JSON.parse(SecretString);
  if (!parsed.accessKeyId || !parsed.secretAccessKey) {
    throw new Error(`The stored keys for ${account.accountId} are not in the expected form`);
  }
  return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
}

/** Write an access key pair to Secrets Manager and return where it went. */
export async function storeKeys(
  accountId: string, accessKeyId: string, secretAccessKey: string,
): Promise<{ secretId: string; keyHint: string }> {
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: REGION });
  const secretId = `${PREFIX}/aws-account/${accountId}`;
  const SecretString = JSON.stringify({ accessKeyId, secretAccessKey });

  try {
    await client.send(new CreateSecretCommand({
      Name: secretId, SecretString,
      Description: `Access keys the GitHub Control Hub uses to read AWS account ${accountId}`,
    }));
  } catch (err: any) {
    if (err?.name !== "ResourceExistsException") throw err;
    await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
  }

  return { secretId, keyHint: accessKeyId.slice(-4) };
}

/**
 * Every account in the AWS Organization, if this account can see one.
 *
 * The point of asking AWS rather than a person: the account ids and names are
 * already recorded somewhere authoritative, and typing twelve digits from
 * memory is how an account ends up watched under the wrong name — or, worse,
 * how a real account quietly never gets added at all.
 */
export async function discoverOrganizationAccounts(): Promise<
  { ok: true; accounts: { accountId: string; name: string; email?: string; status?: string }[] }
  | { ok: false; error: string }
> {
  try {
    const { OrganizationsClient, ListAccountsCommand } = await import("@aws-sdk/client-organizations");
    // Organizations is a global service with its endpoint in us-east-1.
    const orgs = new OrganizationsClient({ region: "us-east-1" });

    const accounts: { accountId: string; name: string; email?: string; status?: string }[] = [];
    let NextToken: string | undefined;
    do {
      const page = await orgs.send(new ListAccountsCommand({ NextToken }));
      for (const a of page.Accounts ?? []) {
        if (!a.Id) continue;
        accounts.push({ accountId: a.Id, name: a.Name ?? a.Id, email: a.Email, status: a.Status });
      }
      NextToken = page.NextToken;
    } while (NextToken);

    return { ok: true, accounts: accounts.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err: any) {
    const name = err?.name ?? "";
    if (name === "AWSOrganizationsNotInUseException") {
      return { ok: false, error: "This account is not part of an AWS Organization, so there is nothing to discover. Add accounts one at a time instead." };
    }
    if (name === "AccessDeniedException") {
      return {
        ok: false,
        error: "This app is not allowed to list the organization's accounts. That permission lives in the management account — if the Control Hub is deployed in a member account, add accounts one at a time instead.",
      };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
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
export async function verifyAccess(
  account: AwsAccount,
): Promise<{ ok: true; via: string } | { ok: false; error: string }> {
  const method = accessMethod(account);
  try {
    const credentials = await credentialsFor(account);
    if (!credentials) return { ok: true, via: "this app's own role" };

    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region: account.regions[0] || REGION, credentials });
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));

    if (Account && Account !== account.accountId) {
      return {
        ok: false,
        error: `That lands in account ${Account}, not ${account.accountId}. Check the account id — sweeping the wrong estate under the right name is worse than not sweeping it.`,
      };
    }
    return {
      ok: true,
      via: method === "keys" ? `an access key ending ${account.keyHint ?? "…"}`
        : account.reachedVia ?? "an assumed role",
    };
  } catch (err: any) {
    const name = err?.name ?? "";
    if (name === "AccessDenied" || name === "AccessDeniedException") {
      return {
        ok: false,
        error: method === "keys"
          ? "Those keys were rejected. Check they are active and belong to a user with read access."
          : `Not allowed to assume ${account.roleArn ?? "a role"} in this account.` +
            (account.externalId ? " The trust policy must require exactly the external ID given here." : ""),
      };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Forget cached credentials for an account — used when its role changes. */
export function forgetCredentials(accountId: string): void {
  credentialCache.delete(accountId);
}
