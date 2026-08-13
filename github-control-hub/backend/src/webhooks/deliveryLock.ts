import { docClient, tableName, PutCommand, DeleteCommand } from "../utils/dynamo";

/**
 * Replay protection, and the deduplication SQS requires of anything reading a
 * standard queue.
 *
 * The in-memory Map this replaces worked on a long-lived server and does
 * nothing across Lambda invocations.
 */

/**
 * How long a claim is held. Matches the queue's visibility timeout, so it
 * outlives the worker's own 600-second timeout — a lease equal to the function
 * timeout would expire at the moment a maximally slow invocation was still
 * running, letting a second worker claim a delivery the first had not released.
 */
const LEASE_SEC = 660;

/**
 * How long a completed delivery is remembered.
 *
 * Longer than the lease, which is the counter-intuitive part. The obvious value
 * is 300 — the replay window the in-memory Map used — and it is wrong here: a
 * worker can succeed and have the message deletion not register, which is
 * ordinary at-least-once behaviour, and the redelivery arrives one visibility
 * timeout later at 660 seconds. A 300-second marker has expired by then, so the
 * delivery would be claimed again and its templates applied a second time.
 *
 * The cost is that a manual redelivery from GitHub's UI is ignored for fifteen
 * minutes rather than five.
 */
const DONE_SEC = 900;

function table(): string {
  return tableName("WEBHOOK_DELIVERIES_TABLE");
}

/**
 * Take the delivery, or report that someone already has it.
 *
 * The condition treats a logically expired row as absent, because DynamoDB's
 * TTL sweep is lazy and a row can outlive its own expiry by hours. Same
 * reasoning as the one-time auth codes in routes/auth.ts, expressed for a
 * conditional put rather than a delete.
 */
export async function claimDelivery(deliveryId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await docClient.send(new PutCommand({
      TableName: table(),
      Item: { deliveryId, state: "processing", expiresAt: now + LEASE_SEC, ttl: now + LEASE_SEC },
      ConditionExpression: "attribute_not_exists(deliveryId) OR expiresAt < :now",
      ExpressionAttributeValues: { ":now": now },
    }));
    return true;
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function completeDelivery(deliveryId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await docClient.send(new PutCommand({
    TableName: table(),
    Item: { deliveryId, state: "done", expiresAt: now + DONE_SEC, ttl: now + DONE_SEC },
  }));
}

/** Hand the delivery back so SQS's retry can re-take it. */
export async function releaseDelivery(deliveryId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: table(), Key: { deliveryId } }));
}
