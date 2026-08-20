import { Guardrail, AwsExclusionList, Finding } from "./types";
import { awsRegion } from "../utils/region";

/**
 * DynamoDB access for the guardrail engine.
 *
 * Deliberately does not import ../utils/dynamo: this module is bundled into the
 * Lambda, and that helper pulls in the whole app's table configuration. Here we
 * only need three tables and a plain client.
 */

const REGION = awsRegion();
const PREFIX = process.env.STACK_NAME || "github-control-hub";

export const GUARDRAILS_TABLE = process.env.GUARDRAILS_TABLE || `${PREFIX}-aws-guardrails`;
export const AWS_EXCLUSIONS_TABLE = process.env.GUARDRAIL_EXCLUSIONS_TABLE || `${PREFIX}-aws-exclusions`;
export const FINDINGS_TABLE = process.env.GUARDRAIL_FINDINGS_TABLE || `${PREFIX}-aws-findings`;

let cached: any;

/**
 * Forget the client, so the next read builds one with the credentials in use now.
 *
 * This module keeps its own client rather than sharing utils/dynamo's, which
 * was harmless while an AWS account was chosen once at launch. Switching
 * accounts from inside the app made it the reason the AWS tab kept showing the
 * first account's guardrails for the life of the process: the credentials in
 * the environment changed, and this client — already constructed, holding
 * resolved credentials of its own — never heard about it. Neither direction of
 * the switch worked, and refreshing could not help, because every refresh asked
 * the same client the same question.
 */
export function resetGuardrailStore(): void {
  cached = undefined;
}

async function docClient() {
  if (cached) return cached;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cached;
}

/**
 * The errors that mean "this client's credentials are no longer any good",
 * rather than "DynamoDB said no".
 *
 * Matched by name where the SDK gives a useful one, and by message where it
 * does not — the SSO and credential-chain failures are the ones that arrive as
 * a generic Error with the reason only in the text.
 */
const STALE_CREDENTIALS = new Set([
  "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId",
  "UnrecognizedClientException", "CredentialsProviderError",
  "TokenRefreshRequired", "SSOTokenProviderFailure", "InvalidIdentityTokenException",
]);

function credentialsWentStale(err: any): boolean {
  if (STALE_CREDENTIALS.has(err?.name ?? "")) return true;
  const message = String(err?.message ?? "").toLowerCase();
  return message.includes("security token") && message.includes("expired")
    || message.includes("token has expired")
    || message.includes("could not load credentials");
}

/**
 * One send, with a second attempt on fresh credentials.
 *
 * This module's client is built once and then held, which is ordinary — except
 * that it is used only when somebody opens the AWS tab. The rest of the app's
 * DynamoDB traffic keeps its own client warm every thirty seconds through the
 * health check, so its credentials are refreshed continuously and never sit
 * expired. This one can go an hour untouched, and a laptop that slept through
 * that hour wakes with a client holding credentials that are long gone.
 *
 * The symptom was specific and misleading: every other tab worked, the AWS tab
 * showed no rules — not an error, because a failed load and an account with no
 * rules render the same — and switching tabs could not help, because every
 * attempt asked the same client. Restarting the app fixed it, which is what
 * building a new client does.
 *
 * Retrying is safe for every command here: a read repeated is a read, and the
 * writes are `Put` and `Delete` by key, which land in the same place twice. The
 * retry only happens when the first attempt never reached DynamoDB at all.
 */
async function send<T = any>(command: any): Promise<T> {
  try {
    return await send(command);
  } catch (err: any) {
    if (!credentialsWentStale(err)) throw err;
    // Logged, because this is the evidence that the theory above is right. A
    // silent recovery would leave the next person guessing at the same symptom.
    console.warn(
      `[guardrails] credentials had gone stale (${err?.name || "no name"}: ${err?.message}) — ` +
      `rebuilding the client and trying once more`);
    resetGuardrailStore();
    const fresh = await docClient();
    return await fresh.send(command);
  }
}

async function scanAll<T>(table: string): Promise<T[]> {
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const items: T[] = [];
  let key: any;
  do {
    const page: any = await send<any>(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    items.push(...((page.Items ?? []) as T[]));
    key = page.LastEvaluatedKey;
  } while (key);
  return items;
}

/**
 * A BatchWrite that actually writes everything it was given.
 *
 * BatchWriteItem does not throw when it cannot keep up. It succeeds, and hands
 * back whatever it declined in `UnprocessedItems` — throttling, a hot
 * partition, a burst past the on-demand ramp. Every call here used to discard
 * that field, so a throttled batch was a set of violations the engine found,
 * logged, and never stored: the AWS tab shows fewer findings than exist, and
 * nothing says so. Under-reporting is the one failure a compliance sweep may
 * not have.
 *
 * Written out here rather than imported from ../utils/dynamo for the reason at
 * the top of this file: this module is bundled into the Lambda on its own, and
 * that helper carries the whole application's table configuration with it.
 */
const BATCH_LIMIT = 25;
const BATCH_RETRIES = 5;

async function batchWriteAll(table: string, requests: any[]): Promise<void> {
  if (requests.length === 0) return;
  const { BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");

  for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
    let chunk = requests.slice(i, i + BATCH_LIMIT);
    for (let attempt = 0; ; attempt++) {
      const result: any = await send<any>(new BatchWriteCommand({
        RequestItems: { [table]: chunk },
      }));
      const left = (result?.UnprocessedItems?.[table] ?? []) as any[];
      if (left.length === 0) break;
      if (attempt >= BATCH_RETRIES) {
        throw new Error(
          `BatchWrite to ${table}: ${left.length} of ${chunk.length} items were still ` +
          `unprocessed after ${BATCH_RETRIES} retries, so they would have been lost.`,
        );
      }
      // 100ms, 200, 400, 800, 1600. The rejection almost always means "too
      // fast", so retrying immediately asks the same question again.
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
      chunk = left;
    }
  }
}

export async function listGuardrails(): Promise<Guardrail[]> {
  return (await scanAll<Guardrail>(GUARDRAILS_TABLE))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGuardrail(id: string): Promise<Guardrail | undefined> {
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const { Item } = await send(new GetCommand({ TableName: GUARDRAILS_TABLE, Key: { id } }));
  return Item as Guardrail | undefined;
}

export async function putGuardrail(rule: Guardrail): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  await send(new PutCommand({ TableName: GUARDRAILS_TABLE, Item: rule }));
}

export async function deleteGuardrail(id: string): Promise<void> {
  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  await send(new DeleteCommand({ TableName: GUARDRAILS_TABLE, Key: { id } }));
}

export async function listAwsExclusions(): Promise<AwsExclusionList[]> {
  return (await scanAll<AwsExclusionList>(AWS_EXCLUSIONS_TABLE))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function putAwsExclusion(list: AwsExclusionList): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  await send(new PutCommand({ TableName: AWS_EXCLUSIONS_TABLE, Item: list }));
}

export async function deleteAwsExclusion(id: string): Promise<void> {
  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  await send(new DeleteCommand({ TableName: AWS_EXCLUSIONS_TABLE, Key: { id } }));
}

/**
 * Findings are keyed by account, region, rule and resource so a re-run
 * overwrites in place rather than accumulating history — the table answers
 * "what is true now", and the activity log carries the history of what changed.
 *
 * Account and region are in the key because names are not unique across an
 * organization: two accounts routinely have a log group called
 * /aws/lambda/api, and keying on the name alone would have prod's verdict and
 * dev's overwrite each other on alternate sweeps.
 *
 * Findings written before accounts existed have no accountId and use the old
 * two-part key. They are not migrated — they are deleted on the next sweep by
 * dropLegacyFindings, because the sweep rewrites the same facts under the new
 * key within the same run.
 */
export function findingKey(f: Finding): string {
  return f.accountId
    ? `${f.accountId}#${f.region ?? "-"}#${f.ruleId}#${f.resourceId}`
    : `${f.ruleId}#${f.resourceId}`;
}

/**
 * Write a sweep's findings, all of them.
 *
 * BatchWriteItem does not throw when it cannot keep up — it returns what it
 * declined in `UnprocessedItems`, and this loop used to discard that. A
 * throttled batch was therefore a set of violations the engine found, reported
 * in its logs, and never stored: the AWS tab shows fewer findings than exist,
 * and nothing anywhere says so. `batchWriteAll` retries and then throws, so a
 * sweep that could not record what it found fails loudly instead.
 *
 * Deduplicated first, because two rules of the same kind can produce a finding
 * for the same resource within one sweep — findingKey does not include the
 * rule for the legacy form — and DynamoDB rejects a batch containing two writes
 * to one key outright.
 */
export async function putFindings(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return;
  const unique = new Map<string, Finding>();
  for (const f of findings) unique.set(findingKey(f), f);
  await batchWriteAll(FINDINGS_TABLE, [...unique.entries()].map(([sk, f]) => ({
    PutRequest: { Item: { pk: "FINDING", sk, ...f } },
  })));
}

/**
 * Remove findings from before accounts existed.
 *
 * Run at the end of a full sweep, once the same resources have been written
 * under their account-qualified keys — otherwise the UI shows every finding
 * twice, once with an account and once without, and the one without looks like
 * a resource nobody can place.
 */
export async function dropLegacyFindings(): Promise<number> {
  const legacy = (await listFindings()).filter(f => !f.accountId);
  const keys = new Map<string, string>();
  for (const f of legacy) keys.set(`${f.ruleId}#${f.resourceId}`, "");
  await batchWriteAll(FINDINGS_TABLE, [...keys.keys()].map(sk => ({
    DeleteRequest: { Key: { pk: "FINDING", sk } },
  })));
  return legacy.length;
}

export async function listFindings(): Promise<Finding[]> {
  const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const items: Finding[] = [];
  let key: any;
  do {
    const page: any = await send<any>(new QueryCommand({
      TableName: FINDINGS_TABLE,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": "FINDING" },
      ExclusiveStartKey: key,
    }));
    items.push(...((page.Items ?? []) as Finding[]));
    key = page.LastEvaluatedKey;
  } while (key);
  return items;
}

/** Drop findings for a rule that no longer exists, so the UI does not show ghosts. */
export async function deleteFindingsForRule(ruleId: string): Promise<void> {
  const stale = (await listFindings()).filter(f => f.ruleId === ruleId);
  // findingKey, not the literal, so rows written per-account are removed too —
  // computing the old key here would leave every account's copy behind as a
  // ghost of a rule that no longer exists.
  const keys = new Set(stale.map(findingKey));
  await batchWriteAll(FINDINGS_TABLE, [...keys].map(sk => ({
    DeleteRequest: { Key: { pk: "FINDING", sk } },
  })));
}
