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
}

export interface Shipped {
  login: string;
  days: number;
  merged: ShipEntry[];
  pushes: number;
  waiting: { repo: string; number: number; title: string; url: string }[];
  /** False means merges are not being recorded, which is why `merged` is empty. */
  detailedLogging: boolean;
  exhausted: boolean;
}

export const fetchMyWork = () => apiGet<MyWork>("/me/work");

export const fetchPushCheck = (repo: string, branch: string) =>
  apiGet<PushCheck>(`/me/push-check?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);

export const fetchShipped = (days: number, login?: string) =>
  apiGet<Shipped>(`/me/ship?days=${days}${login ? `&login=${encodeURIComponent(login)}` : ""}`);

// ── Microsoft Teams notifications ────────────────────────────────────

export interface EventPrefs {
  reviewRequested: boolean;
  changesRequested: boolean;
}

export interface DigestPrefs {
  enabled: boolean;
  hour: number;
  timeZone: string;
  /** 0 is Sunday. Empty means every day. */
  days: number[];
  include: { toReview: boolean; mine: boolean; mergeable: boolean };
  skipWhenEmpty: boolean;
}

export interface DevAlerts {
  login: string;
  /**
   * The URL itself never leaves the server: anyone holding it can post into
   * that channel indefinitely. Only whether one is set.
   */
  webhookConfigured: boolean;
  events: EventPrefs;
  digest: DigestPrefs;
  lastSentAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export const fetchDevAlerts = () => apiGet<DevAlerts>("/me/alerts");

export const saveDevAlerts = (body: Partial<{
  webhookUrl: string; events: Partial<EventPrefs>; digest: Partial<DigestPrefs>;
}>) => apiPut<DevAlerts>("/me/alerts", body);

export const testDevAlerts = () =>
  apiPost<{ sent: boolean; counts: { toReview: number; mine: number; mergeable: number } }>(
    "/me/alerts/test", {});
