import { listDevAlerts, digestDue, putDevAlerts } from "../services/devAlertService";
import { buildDigest } from "../services/devAlertContent";
import { readPrSnapshot } from "../services/alarmService";
import { sendToPerson } from "../services/teamsClient";
import { getOrgConfig } from "../services/orgConfigService";

/**
 * The scheduled half of a developer's notifications.
 *
 * Runs on the five-minute alarm tick rather than on a schedule of its own,
 * because people choose their own hour and their own timezone and a cron for
 * each would be one EventBridge rule per person. Twelve ticks fall inside any
 * chosen hour, so `digestDue` is what makes it one message a day.
 *
 * Reads the stored pull request snapshot rather than walking GitHub. That walk
 * has already happened earlier in the same pass, and a digest that paid for its
 * own would multiply the organization's request cost by the number of people
 * who turned it on, which is exactly backwards, since the feature getting more
 * popular should not make it more expensive.
 */
export interface DigestSummary {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Write down that today's digest is dealt with.
 *
 * The only thing standing between one message a day and one every five minutes,
 * so a failure here is shouted about rather than swallowed. It was swallowed,
 * with a comment reasoning that the worst case was one extra attempt. That was
 * wrong: the worst case is every tick concluding the digest is still due,
 * forever, and the cause invisible because nothing said the write had failed.
 *
 * Most likely cause when it does fail is the function's role not being allowed
 * to write this table, which is a deployment problem and reads as one.
 */
async function recordSent(person: any, stamp: string): Promise<void> {
  try {
    await putDevAlerts({ ...person, lastDigestAt: stamp });
  } catch (err: any) {
    console.error(
      `[DevDigest] Could not record the digest for ${person.login} as sent, so it will be `
      + `sent again on the next tick. Check the function's write access to the org-config `
      + `table: ${err?.message ?? err}`);
  }
}

export async function runDigestPass(now = Date.now()): Promise<DigestSummary> {
  const out: DigestSummary = { considered: 0, sent: 0, skipped: 0, failed: 0 };

  const everyone = await listDevAlerts().catch(err => {
    console.warn("[DevDigest] Could not read who wants a digest:", err?.message ?? err);
    return [];
  });
  const due = everyone.filter(a => digestDue(a, now));
  out.considered = due.length;
  if (due.length === 0) return out;

  // One flow for the whole organization. Without it nothing can be delivered,
  // and saying so once beats failing per person with the same message.
  const flowUrl = (await getOrgConfig().catch(() => null))?.teamsFlow?.url;
  if (!flowUrl) {
    console.warn("[DevDigest] No Teams flow is configured; nothing can be sent");
    return { ...out, skipped: due.length };
  }

  const snapshot = await readPrSnapshot().catch(() => null);
  if (!snapshot) {
    // Nothing to summarise, and nothing recorded as sent, so the next tick
    // inside the same hour tries again rather than skipping the day.
    console.warn("[DevDigest] No pull request snapshot; skipping this tick");
    return { ...out, skipped: due.length };
  }

  for (const person of due) {
    const digest = buildDigest(person, snapshot.prs, now);

    // Nothing to say, and they asked not to be told so. Recorded as sent
    // anyway: the decision was made for today, and leaving it unrecorded would
    // re-ask every five minutes until the hour passed.
    if (!digest.card) {
      await recordSent(person, new Date(now).toISOString());
      out.skipped++;
      continue;
    }

    const result = await sendToPerson(flowUrl, person.teamsAddress!, digest.card);
    const stamp = new Date(now).toISOString();

    if (result.ok) {
      out.sent++;
      await recordSent({ ...person, lastSentAt: stamp, lastError: undefined, lastErrorAt: undefined }, stamp);
    } else {
      out.failed++;
      // `lastDigestAt` is still moved. Retrying a broken webhook every five
      // minutes for the rest of the hour is twelve failures instead of one,
      // and the error is recorded where the person can see it.
      await recordSent({ ...person, lastError: result.error, lastErrorAt: stamp }, stamp);
      console.warn(`[DevDigest] ${person.login}: ${result.error}`);
    }
  }

  return out;
}
