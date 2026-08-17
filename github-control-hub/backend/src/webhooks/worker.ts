import type { SQSEvent } from "aws-lambda";
// Statically imported so esbuild follows it and inlines the package into the
// bundle. client.ts's own loader cannot work here: it finds the module with
// require.resolve, and in a bundle there is no file on disk to find. Passing
// the factory in is what gets this function App auth instead of silently
// falling back to the PAT's lower rate limit.
import { createAppAuth } from "@octokit/auth-app";
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
            createAppAuth,
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
  // outside processDelivery's try/catch, failing the whole batch to the DLQ for
  // as long as the container stays warm.
  //
  // So the throw is still caught — but there is nothing to fall back *to*. This
  // used to reach for a SYSTEM_GITHUB_TOKEN personal access token, a second and
  // broader credential kept permanently against this case; it is gone, because
  // an App failure that keeps working on someone's PAT is an App failure nobody
  // notices.
  //
  // An empty token is already understood downstream as "skip GitHub work", so
  // the delivery still records its activity and alerts — which are DynamoDB
  // writes and need no GitHub — and only the parts that call GitHub are missed.
  // Logged loudly, because that is the signal something needs fixing.
  let token = "";
  try {
    token = await getSystemTokenAsync();
  } catch (err) {
    console.error(
      "[Webhook] No GitHub App token for this invocation — anything needing GitHub " +
      "will be skipped for these deliveries. Check the App credentials in Secrets Manager:",
      (err as Error).message,
    );
  }

  for (const record of event.Records) {
    const { deliveryId, event: githubEvent, payload, receivedAt } = JSON.parse(record.body);

    if (!(await claimDelivery(deliveryId))) {
      console.log(`[Webhook] Delivery ${deliveryId} is already handled — skipping`);
      continue;
    }

    try {
      await processDelivery({ event: githubEvent, deliveryId, payload, token, receivedAt });
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
