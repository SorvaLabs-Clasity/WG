import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { awsRegion } from "./region";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

let rawClient = new DynamoDBClient({
  region: awsRegion(),
});
export let docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export function resetDynamoClient(credentials?: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): void {
  rawClient.destroy();
  rawClient = new DynamoDBClient({
    region: awsRegion(),
    ...(credentials ? { credentials } : {}),
  });
  docClient = DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Swap the client for a fake, and put it back.
 *
 * The paging loop is the thing worth testing and it cannot be reached without
 * one: a scan either talks to DynamoDB or it does not run. Reassigning the
 * exported binding from a test does not work — `export let` compiles to a
 * getter — so the seam has to live in here, next to the binding it replaces.
 */
export function __setDocClientForTests(client: unknown): () => void {
  const previous = docClient;
  docClient = client as typeof docClient;
  return () => { docClient = previous; };
}

export function tableName(envVar: string): string {
  const name = process.env[envVar];
  if (!name) {
    throw new Error(`Missing required DynamoDB table env var: ${envVar}`);
  }
  return name;
}

export function usesDynamo(): boolean {
  return !!process.env.ACTIVITY_TABLE;
}

/**
 * Every item in a table, following DynamoDB's paging to the end.
 *
 * A bare `ScanCommand` returns **at most 1MB** and then stops. It does not fail
 * and it does not warn — it hands back a short list and a `LastEvaluatedKey`
 * nobody read. Everything downstream then works perfectly on the wrong data:
 * alarms that vanish stop firing, email groups that vanish read as deleted,
 * buffered notifications are never sent, and pull request rows that vanish take
 * their mutes and pauses with them, so a muted person starts being reminded
 * again. Every one of those is silent, and none of them appears until the table
 * crosses a size nobody is watching.
 *
 * The `Limit: 1` health-check scans elsewhere are deliberately not this — they
 * ask "can I reach the table", and one item is the whole question.
 */
export async function scanAll<T>(
  table: string,
  opts: {
    filter?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
    /** Attributes to return. Cuts transfer; it does not cut what is read. */
    project?: string;
  } = {},
): Promise<T[]> {
  const items: T[] = [];
  let key: Record<string, unknown> | undefined;
  // A ceiling rather than `while (key)`. A paging bug that never clears the key
  // would otherwise scan forever, and an unbounded loop against a paid API is a
  // worse failure than a truncated read. 10,000 pages is far past any table
  // here and is only reached if something is wrong.
  for (let page = 0; page < 10_000; page++) {
    const result: any = await docClient.send(new ScanCommand({
      TableName: table,
      ExclusiveStartKey: key as any,
      ...(opts.filter ? { FilterExpression: opts.filter } : {}),
      ...(opts.names ? { ExpressionAttributeNames: opts.names } : {}),
      ...(opts.values ? { ExpressionAttributeValues: opts.values } : {}),
      ...(opts.project ? { ProjectionExpression: opts.project } : {}),
    }));
    items.push(...((result.Items || []) as T[]));
    key = result.LastEvaluatedKey;
    if (!key) return items;
  }
  throw new Error(`Scan of ${table} did not finish within 10,000 pages`);
}

/**
 * A BatchWrite that actually writes everything it was given.
 *
 * `BatchWriteItem` does not throw when it cannot keep up. It succeeds, and
 * returns whatever it declined in `UnprocessedItems` — throttling, a hot
 * partition, a burst past the on-demand ramp. Ignoring that field loses rows
 * silently, which for this application means a graph edge that never appears
 * and a guardrail finding that is never stored: a security report that is
 * quietly shorter than the truth, which is the one failure mode the rest of
 * this codebase is built to avoid.
 *
 * `audit/ingest.ts` already got this right for the audit log. This is the same
 * loop, in one place, for everybody else.
 *
 * Requests are chunked to DynamoDB's limit of 25 here rather than by each
 * caller, and the backoff is exponential because the reason for a rejection is
 * almost always "too fast" — retrying immediately asks the same question again.
 *
 * Throws when items remain after the retries. A caller that would rather log
 * and continue can catch it; one that silently dropped them could not.
 */
const BATCH_LIMIT = 25;
const BATCH_RETRIES = 5;

export async function batchWrite(
  table: string,
  requests: Record<string, unknown>[],
  opts: { retries?: number; delay?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (requests.length === 0) return;
  const retries = opts.retries ?? BATCH_RETRIES;
  const sleep = opts.delay ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
    let chunk = requests.slice(i, i + BATCH_LIMIT);

    for (let attempt = 0; ; attempt++) {
      const result: any = await docClient.send(new BatchWriteCommand({
        RequestItems: { [table]: chunk as any },
      }));
      const left = (result?.UnprocessedItems?.[table] ?? []) as Record<string, unknown>[];
      if (left.length === 0) break;

      if (attempt >= retries) {
        throw new Error(
          `BatchWrite to ${table}: ${left.length} of ${chunk.length} items were still ` +
          `unprocessed after ${retries} retries. Nothing here retries them later, so they ` +
          `would have been lost.`,
        );
      }
      // 100ms, 200, 400, 800, 1600 — long enough to outlast an on-demand ramp,
      // short enough that a sweep does not stall on a transient dip.
      await sleep(100 * Math.pow(2, attempt));
      chunk = left;
    }
  }
}

export {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
};
