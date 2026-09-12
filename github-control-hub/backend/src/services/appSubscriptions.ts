import { Octokit } from "octokit";
import { getAppJwt } from "../github/client";

/**
 * Which webhook events the GitHub App is actually subscribed to.
 *
 * Every notification in this app that arrives "within seconds" depends on a
 * checkbox on GitHub's App settings page, and an unticked box is completely
 * silent: GitHub simply never delivers, nothing errors, and nothing anywhere
 * records a non-event. Somebody who turns on "tell me when my pull request is
 * approved" and hears nothing has no way to tell that apart from the feature
 * being broken — which is exactly the report this was written for.
 *
 * The subscription list belongs to the App rather than to the installation, so
 * it is one of the few things GitHub will only tell the App's own JWT. The
 * token manager already holds the key; this borrows it.
 *
 * Every failure answers `null`, never an empty list. "We could not ask" and
 * "you are subscribed to nothing" are opposite messages, and rendering the
 * second when the first is true would send somebody to re-tick boxes that were
 * never untiked.
 */

/** How long an answer is reused. The list changes by hand, perhaps twice a year. */
const TTL_MS = 10 * 60 * 1000;

let cache: { at: number; events: string[] | null } | null = null;

export async function subscribedEvents(now = Date.now()): Promise<string[] | null> {
  if (cache && now - cache.at < TTL_MS) return cache.events;

  const jwt = await getAppJwt();
  if (!jwt) {
    // No App credentials in this process at all — a desktop build pointed at an
    // AWS account with no GitHub half, most often. Not cached: the account can
    // be switched underneath us, and a wrong "cannot tell" that stuck for ten
    // minutes would be its own small mystery.
    return null;
  }

  try {
    const octokit = new Octokit({ auth: jwt });
    const { data } = await octokit.request("GET /app");
    const events = Array.isArray((data as any)?.events)
      ? ((data as any).events as string[])
      : null;
    cache = { at: now, events };
    return events;
  } catch {
    cache = { at: now, events: null };
    return null;
  }
}

/** Forget the cached answer, so a re-tick shows up without waiting ten minutes. */
export function forgetSubscribedEvents(): void {
  cache = null;
}

/**
 * Which of the events a feature needs are missing.
 *
 * Returns null when the subscription could not be read, so a caller can keep
 * saying "cannot tell" rather than inventing an answer.
 */
export async function missingEvents(needed: string[]): Promise<string[] | null> {
  const have = await subscribedEvents();
  if (!have) return null;
  const set = new Set(have);
  return needed.filter(e => !set.has(e));
}
