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

/**
 * Whole days, for a line somebody reads.
 *
 * The age is fractional on purpose: the nudge threshold is compared in
 * seconds, so rounding it where it is computed would coarsen which pull
 * requests count as stale. It has to be rounded here instead, and it was not,
 * which is how a card came to say "quiet 10.742989347923849 days".
 *
 * Floored, because that is what "quiet 10 days" claims. Rounding 10.7 up to 11
 * counts a day that has not happened yet.
 */
const wholeDays = (days: number) => Math.max(0, Math.floor(days));

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

  /**
   * Drop what this section has been told is too old to matter.
   *
   * Zero means no limit. Applied per section because they age differently, and
   * counted after filtering so the heading never says twelve over a list of
   * three, which is the sort of quiet disagreement that makes somebody stop
   * trusting the whole message.
   */
  const within = (rows: typeof work.mine, days: number) =>
    days > 0 ? rows.filter(p => p.idleDays <= days) : rows;

  if (prefs.digest.include.toReview) {
    const rows = within(work.toReview, prefs.digest.maxAgeDays?.toReview ?? 0);
    sections.push({
      heading: `Waiting for your review (${rows.length})`,
      emptyText: "Nobody is waiting on you.",
      links: rows.slice(0, 10).map(pr => ({
        title: pr.title,
        url: pr.url,
        detail: `${pr.repo}#${pr.number} · ${pr.author} · `
          + (wholeDays(pr.idleDays) === 0 ? "updated today" : `quiet ${plural(wholeDays(pr.idleDays), "day")}`),
      })),
    });
  }

  if (prefs.digest.include.mergeable) {
    const ready = within(work.mine.filter(p => p.waiting === "nobody"),
      prefs.digest.maxAgeDays?.mergeable ?? 0);
    sections.push({
      heading: `Ready to merge (${ready.length})`,
      emptyText: "None of yours are ready.",
      // The age belongs here as much as anywhere else. Something ready to merge
      // and untouched for three weeks is a different thing from one ready since
      // this morning, and the section that omits it is the one people scan
      // fastest.
      links: ready.slice(0, 10).map(pr => ({
        title: pr.title,
        url: pr.url,
        detail: `${pr.repo}#${pr.number} · `
          + (wholeDays(pr.idleDays) === 0 ? "updated today" : `quiet ${plural(wholeDays(pr.idleDays), "day")}`),
      })),
    });
  }

  if (prefs.digest.include.mine) {
    // The ones already reported as ready are left out of this section: a pull
    // request appearing twice in one message makes the counts look wrong.
    const rest = within(
      work.mine.filter(p => !(prefs.digest.include.mergeable && p.waiting === "nobody")),
      prefs.digest.maxAgeDays?.mine ?? 0);
    sections.push({
      heading: `Your open pull requests (${rest.length})`,
      emptyText: "You have nothing open.",
      links: rest.slice(0, 10).map(pr => ({
        title: pr.title,
        url: pr.url,
        detail: `${pr.repo}#${pr.number} · ${describe(pr.waiting)} · `
          + (wholeDays(pr.idleDays) === 0 ? "updated today" : `quiet ${plural(wholeDays(pr.idleDays), "day")}`),
      })),
    });
  }

  // Recomputed from what survived the filters. The counts at the top of this
  // function are the totals; the lead has to describe the message somebody is
  // actually about to read.
  counts.toReview = sections.find(s => s.heading.startsWith("Waiting for your review"))?.links.length
    ?? counts.toReview;
  counts.mergeable = sections.find(s => s.heading.startsWith("Ready to merge"))?.links.length
    ?? counts.mergeable;

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

/**
 * The title is the first thing in the card and the first thing in the toast, so
 * it is written to be read at a glance rather than as a sentence. "Review
 * requested" tells somebody whether to switch to Teams; "You have been asked to
 * review" makes them read to the end of a line to learn the same thing.
 */
const EVENT_TEXT: Record<EventKind, { title: string; line: (e: DevEvent) => string }> = {
  reviewRequested: {
    title: "Review requested",
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
  // `Review requested: web#42` rather than the repository on its own line: the
  // toast has room for one line, and which pull request it is belongs in it.
  return buildCard(`${text.title}: ${event.repo}#${event.number}`, text.line(event), [{
    heading: "",
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
  return !!prefs.teamsAddress && prefs.events[kind] === true;
}
