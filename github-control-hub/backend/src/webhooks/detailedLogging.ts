/**
 * Which GitHub traffic counts as "detailed", and whether to record it.
 *
 * The activity feed's Organization tab always records changes to *structure and
 * access*: repositories appearing, disappearing, or going public; protection
 * and rulesets changing. Those are why the feed exists and no switch governs
 * them.
 *
 * Everything here is the other kind: the routine traffic of people working.
 * Branches come and go, commits land, pull requests open and merge. Recording
 * it is sometimes exactly what an admin wants and sometimes pure noise, so it
 * is a toggle, with each kind individually uncheckable under it.
 *
 * The toggle governs collection, never display. A row written while the toggle
 * was on stays in the feed for its full retention after the toggle goes off:
 * turning it off means "stop writing these", not "pretend they never happened".
 *
 * Every kind below is built from webhook events the app already subscribes to.
 * Adding a kind that needs a new event means ticking a new box on the GitHub
 * App as well; none of these do.
 */
import { getDetailedLogging, type DetailedLoggingSettings } from "../services/orgConfigService";

export interface DetailedLogKind {
  id: string;
  label: string;
  /** What turning this kind off stops recording. */
  description: string;
  /** The webhook event it is derived from, for the docs and the curious. */
  event: string;
}

export const DETAILED_LOG_KINDS: DetailedLogKind[] = [
  { id: "branch-created", label: "Branch created", event: "create",
    description: "A branch was created, on github.com or by tooling." },
  { id: "branch-deleted", label: "Branch deleted", event: "delete",
    description: "A branch was deleted. Deletions made through this app are always recorded, since those can be undone." },
  { id: "tag-created", label: "Tag created", event: "create",
    description: "A tag was created, usually a release being cut." },
  { id: "tag-deleted", label: "Tag deleted", event: "delete",
    description: "A tag was deleted." },
  { id: "push", label: "Commits pushed", event: "push",
    description: "Commits landed on a branch: who pushed, where, and how many." },
  { id: "pr-opened", label: "Pull request opened", event: "pull_request",
    description: "A pull request was opened or reopened." },
  { id: "pr-merged", label: "Pull request merged", event: "pull_request",
    description: "A pull request was merged." },
  { id: "pr-closed", label: "Pull request closed", event: "pull_request",
    description: "A pull request was closed without being merged." },
];

/**
 * The settings, cached briefly.
 *
 * The worker handles deliveries in bursts (one push fans out to several
 * events) and a config read per delivery would be a DynamoDB read for an
 * answer that changes a few times a year. Thirty seconds is long enough to
 * collapse a burst and short enough that flipping the toggle takes effect
 * before anyone wonders whether it worked.
 */
let cached: { at: number; value: DetailedLoggingSettings } | null = null;
const CACHE_MS = 30_000;

/** Test seam: forget the cache so the next call re-reads. */
export function __resetDetailedLoggingCache(): void {
  cached = null;
}

/**
 * Should this kind be recorded right now?
 *
 * False when the toggle is off, when the kind is unchecked, and, deliberately,
 * when the settings cannot be read at all. A detailed row is additive
 * telemetry: wrongly skipping one loses a line of routine history, while
 * wrongly writing one ignores an admin's explicit off switch. The failure is
 * logged so a broken config read does not masquerade as "turned off".
 */
export async function shouldLogDetailed(kindId: string): Promise<boolean> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    try {
      cached = { at: now, value: await getDetailedLogging() };
    } catch (err: any) {
      console.warn("[DetailedLogging] Could not read settings; skipping detailed row:",
        err?.message ?? err);
      return false;
    }
  }
  const s = cached.value;
  return s.enabled && !s.disabledKinds.includes(kindId);
}
