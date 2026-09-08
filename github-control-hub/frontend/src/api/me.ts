import { apiGet, apiPut, apiPost } from "./client";

/** Why a pull request sits where it does, from the reader's point of view. */
export type Waiting = "you" | "reviewers" | "nobody" | "checks";

export interface MyPull {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  isDraft: boolean;
  reason: string;
  waiting: Waiting;
  idleDays: number;
  pending: string[];
  approvals: number;
}

export interface MyWork {
  mine: MyPull[];
  toReview: MyPull[];
  mergeable: number;
  onYou: number;
  /**
   * False when the pull request walk has never run.
   *
   * The difference between this and an empty list is the difference between
   * "nothing is waiting on you" and "nobody has looked", which are opposite
   * messages built from the same empty array.
   */
  collected: boolean;
  cachedAt: string | null;
  truncated?: boolean;
}

export interface PushRule {
  label: string;
  detail: string;
  gate: "push" | "merge";
}

export interface PushCheck {
  repo: string;
  branch: string;
  reachable: boolean;
  /** Set when the caller has no access at all, or cannot read the rules. */
  message?: string;
  unreadable?: boolean;
  protected?: boolean;
  cannotPushBecause?: PushRule[];
  mergeNeeds?: PushRule[];
  canBypass?: boolean;
  bypassNote?: string;
  approvers?: { login: string; role: string }[];
}

export interface ShipEntry {
  id: string;
  action: string;
  actor: string;
  repo: string;
  target?: string;
  details?: string;
  timestamp: string;
  /**
   * The pull request this row is about, when it is about one.
   *
   * Recorded by the webhook that wrote the row. Absent on older rows and on
   * pushes, which is why the view falls back to the repository rather than
   * building a link to `/pull/undefined`.
   */
  prNumber?: number;
}

export interface Shipped {
  login: string;
  days: number;
  merged: ShipEntry[];
  pushes: number;
  /** False means merges are not being recorded, which is why `merged` is empty. */
  detailedLogging: boolean;
  exhausted: boolean;
  /**
   * When this answer was computed, which is not when it was asked for.
   *
   * It is served from a stored row and refreshed behind the reader, so the page
   * has to be able to say how old what it is showing is. Absent only on a row
   * written before this existed.
   */
  computedAt?: string;
  /** True while a fresher answer is being computed for the next open. */
  refreshing?: boolean;
}

export const fetchMyWork = () => apiGet<MyWork>("/me/work");

export const fetchPushCheck = (repo: string, branch: string) =>
  apiGet<PushCheck>(`/me/push-check?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);

export const fetchShipped = (days: number, login?: string) =>
  apiGet<Shipped>(`/me/ship?days=${days}${login ? `&login=${encodeURIComponent(login)}` : ""}`);

/** What the signed-in person can reach, and where they can write. */
export interface MyAccess {
  login: string;
  orgRole: string;
  /**
   * True when the access graph holds nothing about this person.
   *
   * Everything below is then empty for want of data rather than as an answer,
   * and a caller must not read the empty `writableRepos` as "writes nowhere".
   */
  unknown: boolean;
  teams: { slug: string; name: string }[];
  totals: { repos: number; writable: number; admin: number; direct: number };
  directRepos: { repo: string; role: string }[];
  /** Repositories this person can write to, by name. */
  writableRepos: string[];
}

export const fetchMyAccess = () => apiGet<MyAccess>("/me/access");

// ── Microsoft Teams notifications ────────────────────────────────────

export interface EventPrefs {
  reviewRequested: boolean;
  changesRequested: boolean;
  /** Somebody approved one of yours. Never aged out, whatever the summary does. */
  approved: boolean;
}

export interface DigestPrefs {
  enabled: boolean;
  hour: number;
  /** Minutes past the hour. The pass ticks every five, so this is a floor. */
  minute: number;
  timeZone: string;
  /** 0 is Sunday. Empty means every day. */
  days: number[];
  include: { toReview: boolean; mine: boolean; mergeable: boolean };
  /** Days of silence each section reaches back. Zero means no limit. */
  maxAgeDays: { toReview: number; mine: number; mergeable: number };
  /**
   * Cap on how many people are on a review before it stops being yours.
   * Null means no cap. Only applies to the reviews section.
   */
  reviewerLimit?: number | null;
  skipWhenEmpty: boolean;
}

export interface DevAlerts {
  login: string;
  /**
   * Where to DM you in Teams: your work email.
   *
   * Shown back, unlike the webhook it replaces. It is not a credential, and
   * being unable to see what you typed is how a typo survives.
   */
  teamsAddress?: string;
  /**
   * Only tell me about a review request when at most this many people were
   * asked, counting me and counting each team as one.
   *
   * Unset means every request, which is what everybody had before this existed
   * and so is what an absent value has to mean.
   */
  reviewerLimit?: number;
  /** Whether an administrator has set the shared flow up. Nothing sends without it. */
  teamsReady: boolean;
  events: EventPrefs;
  digest: DigestPrefs;
  lastSentAt?: string;
  /** When the scheduled summary last went out. One per local day. */
  lastDigestAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export const fetchDevAlerts = () => apiGet<DevAlerts>("/me/alerts");

export const saveDevAlerts = (body: Partial<{
  teamsAddress: string; events: Partial<EventPrefs>; digest: Partial<DigestPrefs>;
}>) => apiPut<DevAlerts>("/me/alerts", body);

export const testDevAlerts = () =>
  apiPost<{
    sent: boolean;
    /** Power Automate answered 202: accepted, not yet run. */
    queued: boolean;
    counts: { toReview: number; mine: number; mergeable: number };
  }>("/me/alerts/test", {});
