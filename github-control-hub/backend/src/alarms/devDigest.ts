import { listDevAlerts, digestDue, putDevAlerts } from "../services/devAlertService";
import { buildDigest } from "../services/devAlertContent";
import { readPrSnapshot } from "../services/alarmService";
import { sendCard } from "../services/teamsClient";

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

export async function runDigestPass(now = Date.now()): Promise<DigestSummary> {
  const out: DigestSummary = { considered: 0, sent: 0, skipped: 0, failed: 0 };

  const everyone = await listDevAlerts().catch(err => {
    console.warn("[DevDigest] Could not read who wants a digest:", err?.message ?? err);
    return [];
  });
  const due = everyone.filter(a => digestDue(a, now));
  out.considered = due.length;
  if (due.length === 0) return out;

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
      await putDevAlerts({ ...person, lastDigestAt: new Date(now).toISOString() })
        .catch(() => { /* the worst case is a second attempt next tick */ });
      out.skipped++;
      continue;
    }

    const result = await sendCard(person.webhookUrl!, digest.card);
    const stamp = new Date(now).toISOString();

    if (result.ok) {
      out.sent++;
      await putDevAlerts({
        ...person, lastDigestAt: stamp, lastSentAt: stamp,
        lastError: undefined, lastErrorAt: undefined,
      }).catch(() => { /* sent is the part that mattered */ });
    } else {
      out.failed++;
      // `lastDigestAt` is still moved. Retrying a broken webhook every five
      // minutes for the rest of the hour is twelve failures instead of one,
      // and the error is recorded where the person can see it.
      await putDevAlerts({
        ...person, lastDigestAt: stamp,
        lastError: result.error, lastErrorAt: stamp,
      }).catch(() => { /* nothing further to do */ });
      console.warn(`[DevDigest] ${person.login}: ${result.error}`);
    }
  }

  return out;
}
