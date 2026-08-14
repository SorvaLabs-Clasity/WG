import { docClient, tableName, PutCommand, DeleteCommand } from "../utils/dynamo";

/**
 * Replay protection, and the deduplication SQS requires of anything reading a
 * standard queue.
 *
 * The in-memory Map this replaces worked on a long-lived server and does
 * nothing across Lambda invocations.
 */

/**
 * How long a claim is held. It sits strictly *between* the worker's own
 * 600-second timeout and the queue's 660-second visibility timeout, and both
 * bounds are load-bearing.
 *
 * Above 600, so a legitimately slow invocation never has its claim stolen: a
 * lease equal to the function timeout would expire at the moment a maximally
 * slow worker was still running.
 *
 * Below 660 — and this is the half that is easy to get wrong — because the two
 * clocks do not start together. The lease starts at claimDelivery; the
 * visibility timeout starts at ReceiveMessage, one pre-claim latency δ earlier
 * (cold start, bootstrapOnce, getSystemTokenAsync). So a redelivery lands at
 * receive + 660 while the lease expires at receive + δ + LEASE_SEC, and
 * re-claiming needs expiresAt < now, i.e. δ + LEASE_SEC < 660. Setting the
 * lease equal to the visibility timeout makes that false for every δ including
 * zero, because the comparison is strict. A worker hard-killed by its timeout,
 * by OOM, or by a releaseDelivery that itself threw would then leave a claim
 * the redelivery cannot re-take: the worker logs "already handled", returns
 * success, SQS deletes the message, and the event is lost with no DLQ entry and
 * no alarm. 630 leaves 30 seconds of headroom for δ.
 */
const LEASE_SEC = 630;

/**
 * How long a completed delivery is remembered.
 *
 * Longer than the lease, which is the counter-intuitive part. The obvious value
 * is 300 — the replay window the in-memory Map used — and it is wrong here: a
 * worker can succeed and have the message deletion not register, which is
 * ordinary at-least-once behavior, and the redelivery arrives one visibility
 * timeout later at 660 seconds. A 300-second marker has expired by then, so the
 * delivery would be claimed again and its activity rows and alerts duplicated.
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
