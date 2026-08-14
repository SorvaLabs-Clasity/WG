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
 *
 * Only a bootstrap that actually loaded something is memoised. fetchBundle in
 * secret.ts swallows a Secrets Manager failure so a transient error cannot
 * discard a working secret, which means a first-ever fetch that fails returns
 * an empty bundle rather than throwing. Caching that would poison the container
 * for its whole life: nothing re-reads secrets, GITHUB_ORG stays unset, and
 * every delivery that container touches throws at processDelivery's getOrg(),
 * releases its claim and eventually dead-letters.
 */
function bootstrapOnce(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await loadSecretsIntoEnv();

      // Reset before throwing, not after: memoising the rejected promise is the
      // same trap in a different shape — the next invocation would await the
      // cached rejection instead of retrying the load.
      if (!process.env.GITHUB_ORG) {
        bootstrapped = null;
        throw new Error("[Webhook] Secrets did not load — GITHUB_ORG is unset; not caching this bootstrap");
      }

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
  //
  // Not awaited bare: initTokenManager assigns the module-level manager before
  // awaiting its own init(), so a container whose GitHub App init failed is
  // left with a non-null manager whose internal auth() is never set. Every
  // invocation on that container would then have getTokenAsync() throw here,
  // outside processDelivery's try/catch, failing the whole batch to the DLQ
  // for as long as the container stays warm. The Express route this replaced
  // called the synchronous getSystemToken(), which degrades to
  // SYSTEM_GITHUB_TOKEN and never throws; this restores that fallback.
  // Downstream code already treats an empty token as "skip GitHub work".
  let token: string;
  try {
    token = await getSystemTokenAsync();
  } catch (err) {
    console.error(
      "[Webhook] Token resolution failed — degrading to SYSTEM_GITHUB_TOKEN for this invocation:",
      (err as Error).message,
    );
    token = process.env.SYSTEM_GITHUB_TOKEN || "";
  }

  for (const record of event.Records) {
    const { deliveryId, event: githubEvent, payload } = JSON.parse(record.body);

    if (!(await claimDelivery(deliveryId))) {
      console.log(`[Webhook] Delivery ${deliveryId} is already handled — skipping`);
      continue;
    }

    try {
      await processDelivery({ event: githubEvent, deliveryId, payload, token });
    } catch (err) {
      // Hand the claim back before rethrowing, so SQS's retry can re-take it.
      // Swallowing this would delete the message and lose the event.
      await releaseDelivery(deliveryId);
      console.error(`[Webhook] Delivery ${deliveryId} failed:`, (err as Error).message);
      throw err;
    }

    // Deliberately not in the try above, and deliberately swallowed.
    //
    // By here the work is done — activity rows written, alerts generated. A
    // release-and-rethrow would hand the message back to SQS and guarantee it
    // is processed a second time, duplicating exactly that work. Leaving the
    // claim in place instead means the redelivery (if any) is refused by the
    // lease and the delivery lapses quietly, which costs nothing but the
    // shorter `done` window. Losing the marker is much cheaper than duplicate
    // activity rows and duplicate alerts.
    try {
      await completeDelivery(deliveryId);
    } catch (err) {
      console.error(
        `[Webhook] Delivery ${deliveryId} processed, but marking it complete failed:`,
        (err as Error).message,
      );
    }
  }
}
