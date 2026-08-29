import { getDevAlerts, putDevAlerts } from "../services/devAlertService";
import { buildEventCard, wants, type DevEvent, type EventKind } from "../services/devAlertContent";
import { sendToPerson } from "../services/teamsClient";
import { getOrgConfig } from "../services/orgConfigService";

/**
 * The immediate half of a developer's notifications.
 *
 * Here rather than on the five-minute tick because "right when it happens" is
 * the point: a review request that arrives four minutes later is a review
 * request that arrived while you were already doing something else. The
 * webhook is the only path that is genuinely fast.
 *
 * Only a handful of moments qualify. Everything else somebody might want to
 * know belongs in the digest, and the line between them is whether it is worth
 * interrupting for, a message that is not worth reading immediately teaches
 * people to stop reading the ones that are.
 */

/**
 * Who to tell about a pull request event, and what to tell them.
 *
 * Returns the recipients rather than sending, so the decision is testable
 * without a webhook. The author is never told about their own action: being
 * notified that you requested a review from somebody is noise, and it is the
 * fastest way to make somebody turn the whole thing off.
 */
export function recipientsFor(event: string, payload: any): Array<{ login: string; kind: EventKind; actor?: string }> {
  const pr = payload?.pull_request;
  if (!pr) return [];
  const actor = payload?.sender?.login as string | undefined;
  const author = pr.user?.login as string | undefined;
  const out: Array<{ login: string; kind: EventKind; actor?: string }> = [];

  if (event === "pull_request" && payload.action === "review_requested") {
    // GitHub sends either a person or a team; a team request names no
    // individual, so there is nobody to notify and guessing the members would
    // message people who were not asked.
    const asked = payload.requested_reviewer?.login as string | undefined;
    if (asked && asked !== actor) out.push({ login: asked, kind: "reviewRequested", actor });
    return out;
  }

  if (event === "pull_request_review" && payload.action === "submitted") {
    const state = String(payload.review?.state ?? "").toUpperCase();
    if (state === "CHANGES_REQUESTED" && author && author !== actor) {
      out.push({ login: author, kind: "changesRequested", actor });
    }
    return out;
  }

  return out;
}

/**
 * Deliver, and record a failure against the person it belongs to.
 *
 * Never throws. This runs inside webhook delivery, where an exception releases
 * the claim and re-runs every other effect of the same event, so one stale
 * webhook would turn into duplicated activity rows for everybody.
 */
export async function notifyDevEvents(event: string, payload: any): Promise<number> {
  const targets = recipientsFor(event, payload);
  if (targets.length === 0) return 0;

  const flowUrl = (await getOrgConfig().catch(() => null))?.teamsFlow?.url;
  if (!flowUrl) return 0;

  const pr = payload.pull_request;
  let sent = 0;

  for (const target of targets) {
    try {
      const prefs = await getDevAlerts(target.login);
      if (!wants(prefs, target.kind)) continue;

      const devEvent: DevEvent = {
        kind: target.kind,
        repo: payload.repository?.name ?? "",
        number: Number(pr.number) || 0,
        title: String(pr.title ?? "Untitled"),
        url: String(pr.html_url ?? ""),
        actor: target.actor,
      };

      const result = await sendToPerson(flowUrl, prefs.teamsAddress!, buildEventCard(devEvent));
      const now = new Date().toISOString();
      if (result.ok) {
        sent++;
        await putDevAlerts({ ...prefs, lastSentAt: now, lastError: undefined, lastErrorAt: undefined });
      } else {
        // Recorded, not retried. The settings screen reads this, which is the
        // only way somebody finds out their webhook stopped working.
        await putDevAlerts({ ...prefs, lastError: result.error, lastErrorAt: now });
        console.warn(`[DevEvent] ${target.login}: ${result.error}`);
      }
    } catch (err: any) {
      console.warn(`[DevEvent] Could not notify ${target.login}:`, err?.message ?? err);
    }
  }

  return sent;
}
