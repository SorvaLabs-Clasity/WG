import { docClient, hasTable, tableName, GetCommand, UpdateCommand } from "../utils/dynamo";

/**
 * A counter that changes whenever the graph does.
 *
 * The point is to make "has anything changed since I last read the whole
 * graph?" answerable for about one read unit, instead of by reading the whole
 * graph to find out. Every check that draws on the graph starts by loading all
 * of it, and on a large organization that scan is the single largest line in
 * the DynamoDB bill.
 *
 * It lives as one row in the edges table rather than in a table of its own:
 * whatever can write an edge can already write here, so it needs no new
 * permission anywhere, and a counter kept beside the thing it counts cannot be
 * pointed at the wrong table.
 *
 * `ADD` is atomic in DynamoDB, so concurrent writers each increment exactly
 * once and none of them has to read first. The value is never interpreted, only
 * compared: a bigger number means "different", not "newer by that much".
 */
const TABLE = () => tableName("GRAPH_EDGES_TABLE");
const KEY = { pk: "GRAPH", sk: "VERSION" };

/**
 * Say the graph changed.
 *
 * Never throws. A counter that failed to move makes a cached copy look current
 * for longer than it is, which is a stale reading; a counter that took the
 * write down with it would stop the edge being recorded at all, which is a
 * wrong one. Of the two, stale is recoverable and wrong is not.
 */
export async function bumpGraphVersion(): Promise<void> {
  if (!hasTable("GRAPH_EDGES_TABLE")) return;
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(),
      Key: KEY,
      UpdateExpression: "ADD #v :one SET #t = :now",
      ExpressionAttributeNames: { "#v": "version", "#t": "changedAt" },
      ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
    }));
  } catch (err: any) {
    console.warn("[Graph] could not record a graph change:", err?.message ?? err);
  }
}

/**
 * The current version, or null when it cannot be read.
 *
 * Null is deliberately not zero. Zero is a real version, and treating an
 * unreadable counter as a known value would let a cached graph be served
 * against a version nobody actually checked.
 */
export async function readGraphVersion(): Promise<number | null> {
  if (!hasTable("GRAPH_EDGES_TABLE")) return null;
  try {
    const res: any = await docClient.send(new GetCommand({ TableName: TABLE(), Key: KEY }));
    const v = res?.Item?.version;
    // Absent is version 0: a graph nobody has written to since this existed.
    // That is a real state and has to compare equal to itself, or every read
    // would rebuild the cache on an organization that never changes.
    return typeof v === "number" ? v : 0;
  } catch (err: any) {
    console.warn("[Graph] could not read the graph version:", err?.message ?? err);
    return null;
  }
}

/** The row this keeps, so a scan of the edges table can leave it out. */
export const isVersionRow = (e: { pk?: string; sk?: string }) =>
  e?.pk === KEY.pk && e?.sk === KEY.sk;
