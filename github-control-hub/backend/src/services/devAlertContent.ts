import { myWork } from "./developerService";
import type { PullRequest } from "./prNudgeService";
import { buildCard, type CardSection } from "./teamsClient";
import type { DevAlerts, EventPrefs } from "./devAlertService";

/**
 * What a notification actually says.
 *
 * Kept apart from both the storage and the sending, because this is the part
 * with judgement in it: what is worth interrupting somebody for, what a daily
 * summary should lead with, and when a message should not be sent at all.
 *
 * Everything here is pure.
 */

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

export interface Digest {
  /** Null when there is nothing to say and the person asked not to be told so. */
  card: any | null;
  /** Why nothing was sent, for the log. */
  skipped?: string;
  counts: { toReview: number; mine: number; mergeable: number };
}

/**
 * The daily summary.
 *
 * Reviews other people are waiting on lead, always, because that is the only
 * section where somebody else is blocked. Your own work follows, and what can
 * be merged comes last. It is good news and does not need to be at the top.
 */
export function buildDigest(prefs: DevAlerts, prs: PullRequest[], now = Date.now()): Digest {
  const work = myWork(prs, prefs.login, now);
  const counts = {
    toReview: work.toReview.length,
    mine: work.mine.length,
    mergeable: work.mergeable,
  };

  const sections: CardSection[] = [];

  if (prefs.digest.include.toReview) {
    sections.push({
      heading: `Waiting for your review (${counts.toReview})`,
      emptyText: "Nobody is waiting on you.",
      links: work.toReview.slice(0, 10).map(pr => ({
        title: pr.title,
        url: pr.url,
        detail: `${pr.repo}#${pr.number} · ${pr.author} · `
          + (pr.idleDays === 0 ? "updated today" : `quiet ${plural(pr.idleDays, "day")}`),
      })),
    });
  }

  if (prefs.digest.include.mergeable) {
    const ready = work.mine.filter(p => p.waiting === "nobody");
    sections.push({
      heading: `Ready to merge (${ready.length})`,
      emptyText: "None of yours are ready.",
      links: ready.slice(0, 10).map(pr => ({
        title: pr.title, url: pr.url, detail: `${pr.repo}#${pr.number}`,
      })),
    });
  }

  if (prefs.digest.include.mine) {
    // The ones already reported as ready are left out of this section: a pull
    // request appearing twice in one message makes the counts look wrong.
    const rest = work.mine.filter(p => !(prefs.digest.include.mergeable && p.waiting === "nobody"));
    sections.push({
      heading: `Your open pull requests (${rest.length})`,
      emptyText: "You have nothing open.",
      links: rest.slice(0, 10).map(pr => ({
        title: pr.title,
        url: pr.url,
        detail: `${pr.repo}#${pr.number} · ${describe(pr.waiting)} · `
          + (pr.idleDays === 0 ? "updated today" : `quiet ${plural(pr.idleDays, "day")}`),
      })),
    });
  }

  const nothing = sections.every(s => s.links.length === 0);
  if (nothing && prefs.digest.skipWhenEmpty) {
    return { card: null, skipped: "nothing to report", counts };
  }

  const lead = counts.toReview > 0
    ? `${plural(counts.toReview, "review")} waiting on you`
    : counts.mergeable > 0
      ? `${plural(counts.mergeable, "pull request")} ready to merge`
      : "Nothing is waiting on you";

  return { card: buildCard("Your pull requests", lead, sections), counts };
}

function describe(waiting: string): string {
  switch (waiting) {
    case "you": return "needs your attention";
    case "reviewers": return "waiting on review";
    case "nobody": return "ready to merge";
    default: return "checks running";
  }
}

// ── the moments worth interrupting for ───────────────────────────────

export type EventKind = keyof EventPrefs;

export interface DevEvent {
  kind: EventKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Who caused it, where that is a person and not the system. */
  actor?: string;
}

const EVENT_TEXT: Record<EventKind, { title: string; line: (e: DevEvent) => string }> = {
  reviewRequested: {
    title: "You have been asked to review",
    line: e => e.actor ? `${e.actor} asked you to review this.` : "Your review has been requested.",
  },
  changesRequested: {
    title: "Changes requested",
    line: e => e.actor ? `${e.actor} asked for changes.` : "Somebody asked for changes.",
  },
};

/** One card for one thing that just happened. */
export function buildEventCard(event: DevEvent): any {
  const text = EVENT_TEXT[event.kind];
  return buildCard(text.title, text.line(event), [{
    heading: `${event.repo}#${event.number}`,
    links: [{ title: event.title, url: event.url }],
  }]);
}

/**
 * Whether this person asked to hear about this.
 *
 * Checked here rather than at the send site so that adding a new kind of event
 * cannot accidentally reach people who never opted into it, the default for an
 * unknown key is no.
 */
export function wants(prefs: DevAlerts, kind: EventKind): boolean {
  return !!prefs.webhookUrl && prefs.events[kind] === true;
}
