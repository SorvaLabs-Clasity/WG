import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { awsRegion } from "../utils/region";
import { rawBodyBytes, verifyGitHubSignature } from "./verify";
import { getWebhookSecret, refetchWebhookSecret } from "./secret";

/**
 * The internet-facing half.
 *
 * It verifies the signature and puts the delivery on a queue, and that is all
 * it can do: its IAM grants one secret and one queue. Everything with real
 * privileges runs in the worker, which nothing on the internet can reach.
 */

type Sender = (body: string) => Promise<void>;

let send: Sender = async (body: string) => {
  const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
  const client = new SQSClient({ region: awsRegion() });
  await client.send(new SendMessageCommand({
    QueueUrl: process.env.WEBHOOK_QUEUE_URL,
    MessageBody: body,
  }));
};

function header(headers: Record<string, unknown> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const raw = rawBodyBytes(event.body ?? undefined, event.isBase64Encoded === true);
  const signature = header(event.headers, "x-hub-signature-256");

  // A rotated secret would otherwise reject every delivery until the cache
  // expired, and rejected deliveries are lost rather than queued.
  let ok = verifyGitHubSignature(raw, signature, await getWebhookSecret());
  if (!ok) ok = verifyGitHubSignature(raw, signature, await refetchWebhookSecret());

  if (!ok) {
    console.error("Webhook signature verification failed");
    return { statusCode: 401, body: "Unauthorized" };
  }

  const deliveryId = header(event.headers, "x-github-delivery");
  const githubEvent = header(event.headers, "x-github-event");
  if (!deliveryId || !githubEvent) {
    return { statusCode: 400, body: "Missing delivery headers" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { statusCode: 400, body: "Body is not JSON" };
  }

  await send(JSON.stringify({ deliveryId, event: githubEvent, payload }));

  return { statusCode: 202, body: "Accepted" };
}

// ── test seam ──
export function __setQueueSenderForTests(fn: Sender): void {
  send = fn;
}
