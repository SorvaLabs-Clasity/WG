import { getDevAlerts, putDevAlerts } from "../services/devAlertService";
import {
  buildEventCard, wants, withinReviewerLimit,
  type DevEvent, type EventKind,
} from "../services/devAlertContent";
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
export function recipientsFor(event: string, payload: any): Array<{
  login: string; kind: EventKind; actor?: string;
  /** Everybody else currently asked, and any teams. Absent where it does not apply. */
  reviewers?: string[]; reviewerTeams?: string[];
}> {
  const pr = payload?.pull_request;
  if (!pr) return [];
  const actor = payload?.sender?.login as string | undefined;
  const author = pr.user?.login as string | undefined;
  const out: Array<{
    login: string; kind: EventKind; actor?: string;
    reviewers?: string[]; reviewerTeams?: string[];
  }> = [];

  if (event === "pull_request" && payload.action === "review_requested") {
    // GitHub sends either a person or a team; a team request names no
    // individual, so there is nobody to notify and guessing the members would
    // message people who were not asked.
    const asked = payload.requested_reviewer?.login as string | undefined;
    if (asked && asked !== actor) {
      /**
       * Everybody still awaiting review, taken from the pull request rather
       * than from the event.
       *
       * The event names the one person just added; `requested_reviewers` is the
       * whole outstanding list at this moment, which is what "am I the only
       * one" needs. Anybody who has already reviewed has left it, and that is
       * correct: they are no longer who this is waiting on.
       *
       * Left undefined when the payload carries no list at all, so a request
       * whose size could not be read is notified rather than silently withheld.
       */
      const all = Array.isArray(pr.requested_reviewers)
        ? (pr.requested_reviewers as any[]).map(r => r?.login).filter(Boolean) as string[]
        : undefined;
      const teams = Array.isArray(pr.requested_teams)
        ? (pr.requested_teams as any[]).map(t => t?.slug ?? t?.name).filter(Boolean) as string[]
        : undefined;

      out.push({
        login: asked, kind: "reviewRequested", actor,
        // Their own name removed: the card lists who *else* is on it, and a
        // person reading their own name back in that list reads as a bug.
        ...(all ? { reviewers: all.filter(l => l !== asked) } : {}),
        ...(teams ? { reviewerTeams: teams } : {}),
      });
    }
    return out;
  }

  if (event === "pull_request_review" && payload.action === "submitted") {
    /**
     * Both halves of a submitted review, told to the author.
     *
     * `COMMENTED` is deliberately not here. A review with no verdict is a
     * conversation, not a decision, and it arrives in the same shape as the two
     * that are, so notifying on it would make the approval message the one
     * people learn to ignore.
     *
     * Neither is aged out. The digest limits how old a pull request may be
     * before it appears in a pile somebody works through; an approval is the
     * moment a thing stopped being blocked, and it matters most on the oldest
     * pull request, which is the one an age limit would silence.
     */
    const state = String(payload.review?.state ?? "").toUpperCase();

    // Never to the person who did it. GitHub does not let somebody approve
    // their own pull request, but an integration acting as the author can, and
    // "you approved your own work" is the fastest way to make somebody turn
    // this off.
    if (!author || author === actor) return out;

    if (state === "CHANGES_REQUESTED") {
      out.push({ login: author, kind: "changesRequested", actor });
    } else if (state === "APPROVED") {
      out.push({ login: author, kind: "approved", actor });
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

  /**
   * Logged even when there is nothing to do.
   *
   * This is the only trace that the event arrived at all. Without it, an App
   * that is not subscribed to `pull_request_review` and an event that was
   * correctly ignored produce exactly the same evidence: none. One line in the
   * worker's log is what separates "GitHub never told us" from "we decided not
   * to".
   */
  console.log(`[DevEvent] ${event}/${payload?.action}: ${targets.length} to consider`);
  if (targets.length === 0) return 0;

  const pr = payload.pull_request;
  const subject = `${payload?.repository?.name ?? "?"}#${pr?.number ?? "?"}`;

  const flowUrl = (await getOrgConfig().catch(() => null))?.teamsFlow?.url;
  if (!flowUrl) {
    // Recorded against each person, because this is the one cause they cannot
    // fix or even see from their own settings screen.
    console.warn("[DevEvent] No Teams flow is set up for this organization; nothing can be sent.");
    for (const t of targets) {
      await note(t.login, t.kind, subject, "skipped",
        "No Teams flow is set up for this organization yet. An administrator sets it up once, in Alarms.");
    }
    return 0;
  }

  let sent = 0;

  for (const target of targets) {
    try {
      const prefs = await getDevAlerts(target.login);

      if (!prefs.teamsAddress) {
        await note(target.login, target.kind, subject, "skipped",
          "You have not set your Teams address yet.");
        continue;
      }
      if (!wants(prefs, target.kind)) {
        await note(target.login, target.kind, subject, "skipped",
          `The "${target.kind}" switch is off.`);
        continue;
      }

      // Asked for by somebody who only wants the requests that are theirs to
      // do. A preference, not a failure, and it is still in the daily digest,
      // but it is recorded: "I turned it on and got nothing" is exactly what
      // this looks like from the outside.
      if (target.kind === "reviewRequested" && !withinReviewerLimit(prefs, target)) {
        await note(target.login, target.kind, subject, "skipped",
          "More reviewers were asked than your limit allows. It is still in the daily summary.");
        continue;
      }

      const devEvent: DevEvent = {
        kind: target.kind,
        repo: payload.repository?.name ?? "",
        number: Number(pr.number) || 0,
        title: String(pr.title ?? "Untitled"),
        url: String(pr.html_url ?? ""),
        actor: target.actor,
        ...(target.reviewers ? { reviewers: target.reviewers } : {}),
        ...(target.reviewerTeams ? { reviewerTeams: target.reviewerTeams } : {}),
      };

      const result = await sendToPerson(flowUrl, prefs.teamsAddress!, buildEventCard(devEvent));
      const now = new Date().toISOString();
      if (result.ok) {
        sent++;
        await putDevAlerts({
          ...prefs, lastSentAt: now, lastError: undefined, lastErrorAt: undefined,
          lastEvent: { at: now, kind: target.kind, subject, outcome: "sent" },
        });
      } else {
        // Recorded, not retried. The settings screen reads this, which is the
        // only way somebody finds out their webhook stopped working.
        await putDevAlerts({
          ...prefs, lastError: result.error, lastErrorAt: now,
          lastEvent: { at: now, kind: target.kind, subject, outcome: "failed", detail: result.error },
        });
        console.warn(`[DevEvent] ${target.login}: ${result.error}`);
      }
    } catch (err: any) {
      console.warn(`[DevEvent] Could not notify ${target.login}:`, err?.message ?? err);
      await note(target.login, target.kind, subject, "failed", err?.message ?? String(err));
    }
  }

  return sent;
}

/**
 * Write down what happened to one person's event, and never fail the delivery.
 *
 * This runs inside webhook delivery, where a throw releases the claim and
 * re-runs every other effect of the same event. A note about a notification is
 * not worth that, so its own failure is swallowed and logged.
 */
async function note(
  login: string,
  kind: EventKind,
  subject: string,
  outcome: "sent" | "skipped" | "failed",
  detail?: string,
): Promise<void> {
  try {
    const prefs = await getDevAlerts(login);
    await putDevAlerts({
      ...prefs,
      lastEvent: { at: new Date().toISOString(), kind, subject, outcome, detail },
    });
  } catch (err: any) {
    console.warn(`[DevEvent] Could not record the outcome for ${login}:`, err?.message ?? err);
  }
}
