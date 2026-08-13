import type { SQSEvent } from "aws-lambda";
import { initTokenManager, getSystemTokenAsync } from "../github/client";
import { loadSecretsIntoEnv } from "./secret";
import { claimDelivery, completeDelivery, releaseDelivery } from "./deliveryLock";
import { processDelivery } from "./processDelivery";

/**
 * The privileged half. Reachable only from the queue.
 */

let bootstrapped: Promise<void> | null = null;

/**
 * Once per container, not once per message. A warm container keeps both the
 * secrets and the App token, which is most of what makes this cheap.
 */
function bootstrapOnce(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await loadSecretsIntoEnv();
      if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
        try {
          await initTokenManager(
            process.env.GITHUB_APP_ID,
            process.env.GITHUB_APP_PRIVATE_KEY,
            process.env.GITHUB_APP_INSTALLATION_ID,
          );
          console.log("[Webhook] GitHub App token manager initialized");
        } catch (err) {
          console.error("[Webhook] GitHub App token manager failed to initialize:", (err as Error).message);
        }
      }
    })();
  }
  return bootstrapped;
}

export async function handler(event: SQSEvent): Promise<void> {
  await bootstrapOnce();

  // Resolved once per invocation rather than read from the module singleton.
  // The refresh timer behind the synchronous getter does not fire on schedule
  // in a frozen container, so this is what keeps the token live.
  const token = await getSystemTokenAsync();

  for (const record of event.Records) {
    const { deliveryId, event: githubEvent, payload } = JSON.parse(record.body);

    if (!(await claimDelivery(deliveryId))) {
      console.log(`[Webhook] Delivery ${deliveryId} is already handled — skipping`);
      continue;
    }

    try {
      await processDelivery({ event: githubEvent, deliveryId, payload, token });
      await completeDelivery(deliveryId);
    } catch (err) {
      // Hand the claim back before rethrowing, so SQS's retry can re-take it.
      // Swallowing this would delete the message and lose the event.
      await releaseDelivery(deliveryId);
      console.error(`[Webhook] Delivery ${deliveryId} failed:`, (err as Error).message);
      throw err;
    }
  }
}
