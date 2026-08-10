import { Guardrail, AwsExclusionList, Finding } from "./types";

/**
 * DynamoDB access for the guardrail engine.
 *
 * Deliberately does not import ../utils/dynamo: this module is bundled into the
 * Lambda, and that helper pulls in the whole app's table configuration. Here we
 * only need three tables and a plain client.
 */

const REGION = process.env.AWS_REGION || "us-east-1";
const PREFIX = process.env.STACK_NAME || "github-control-hub";

export const GUARDRAILS_TABLE = process.env.AWS_GUARDRAILS_TABLE || `${PREFIX}-aws-guardrails`;
export const AWS_EXCLUSIONS_TABLE = process.env.AWS_EXCLUSIONS_TABLE || `${PREFIX}-aws-exclusions`;
export const FINDINGS_TABLE = process.env.AWS_FINDINGS_TABLE || `${PREFIX}-aws-findings`;

let cached: any;
async function docClient() {
  if (cached) return cached;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cached;
}

async function scanAll<T>(table: string): Promise<T[]> {
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  const items: T[] = [];
  let key: any;
  do {
    const page: any = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    items.push(...((page.Items ?? []) as T[]));
    key = page.LastEvaluatedKey;
  } while (key);
  return items;
}

export async function listGuardrails(): Promise<Guardrail[]> {
  return (await scanAll<Guardrail>(GUARDRAILS_TABLE))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGuardrail(id: string): Promise<Guardrail | undefined> {
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  const { Item } = await client.send(new GetCommand({ TableName: GUARDRAILS_TABLE, Key: { id } }));
  return Item as Guardrail | undefined;
}

export async function putGuardrail(rule: Guardrail): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  await client.send(new PutCommand({ TableName: GUARDRAILS_TABLE, Item: rule }));
}

export async function deleteGuardrail(id: string): Promise<void> {
  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  await client.send(new DeleteCommand({ TableName: GUARDRAILS_TABLE, Key: { id } }));
}

export async function listAwsExclusions(): Promise<AwsExclusionList[]> {
  return (await scanAll<AwsExclusionList>(AWS_EXCLUSIONS_TABLE))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function putAwsExclusion(list: AwsExclusionList): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  await client.send(new PutCommand({ TableName: AWS_EXCLUSIONS_TABLE, Item: list }));
}

export async function deleteAwsExclusion(id: string): Promise<void> {
  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  await client.send(new DeleteCommand({ TableName: AWS_EXCLUSIONS_TABLE, Key: { id } }));
}

/**
 * Findings are keyed by rule + resource so a re-run overwrites in place rather
 * than accumulating history — the table answers "what is true now", and the
 * activity log carries the history of what changed.
 */
export async function putFindings(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return;
  const { BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  for (let i = 0; i < findings.length; i += 25) {
    const chunk = findings.slice(i, i + 25);
    await client.send(new BatchWriteCommand({
      RequestItems: {
        [FINDINGS_TABLE]: chunk.map(f => ({
          PutRequest: { Item: { pk: "FINDING", sk: `${f.ruleId}#${f.resourceId}`, ...f } },
        })),
      },
    }));
  }
}

export async function listFindings(): Promise<Finding[]> {
  const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  const items: Finding[] = [];
  let key: any;
  do {
    const page: any = await client.send(new QueryCommand({
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
  const { BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await docClient();
  const stale = (await listFindings()).filter(f => f.ruleId === ruleId);
  for (let i = 0; i < stale.length; i += 25) {
    const chunk = stale.slice(i, i + 25);
    await client.send(new BatchWriteCommand({
      RequestItems: {
        [FINDINGS_TABLE]: chunk.map(f => ({
          DeleteRequest: { Key: { pk: "FINDING", sk: `${f.ruleId}#${f.resourceId}` } },
        })),
      },
    }));
  }
}
