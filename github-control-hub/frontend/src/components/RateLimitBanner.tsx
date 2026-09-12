import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RateLimitError } from "../api/client";
import { INTENT } from "../design";

/**
 * Says that GitHub is rate-limiting us, and for how much longer.
 *
 * Unlike every other error here, nothing the user did caused it, nothing they
 * can do fixes it, and it affects every page at once, so a per-request message
 * in the corner of one tab is the wrong shape.
 *
 * The countdown is the point. "Try again later" leaves somebody refreshing to
 * find out; a number reaching zero does not.
 *
 * Watches both caches: queries are what usually exhaust the budget, since a
 * page load costs a request per repository, and mutations are what the user is
 * actively waiting on.
 */
/** A limit, with the moment it clears fixed at the time it was seen. */
interface Pending {
  error: RateLimitError;
  endsAt: number;
}

export default function RateLimitBanner() {
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState<Pending | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const note = (error: unknown) => {
      if (!(error instanceof RateLimitError)) return;
      // Fixed once, here. Deriving it on every render made the fallback case
      // a moving target, Date.now() + 60s, recomputed each tick, so the
      // countdown never advanced and the banner never cleared.
      const pending: Pending = { error, endsAt: deadlineFor(error) };
      // Keep whichever clears last: two endpoints can report different waits,
      // and the longer one is when the app is actually usable again.
      setLimit(prev => (!prev || pending.endsAt > prev.endsAt ? pending : prev));
    };

    const unQuery = queryClient.getQueryCache().subscribe(e => {
      if (e.type === "updated" && e.action?.type === "error") note(e.action.error);
    });
    const unMutation = queryClient.getMutationCache().subscribe(e => {
      if (e.type === "updated" && e.action?.type === "error") note(e.action.error);
    });
    return () => { unQuery(); unMutation(); };
  }, [queryClient]);

  // Only tick while something is actually being waited on.
  useEffect(() => {
    if (!limit) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [limit]);

  useEffect(() => {
    if (!limit) return;
    if (limit.endsAt - now > 0) return;
    // The budget has refilled. Clear the banner and let the open pages reload
    // themselves rather than making the user do it.
    setLimit(null);
    queryClient.invalidateQueries();
  }, [limit, now, queryClient]);

  if (!limit) return null;

  const left = Math.max(0, limit.endsAt - now);
  const tone = INTENT.warn;

  return (
    <div className="fixed top-[5.75rem] left-0 right-0 z-[90] flex justify-center px-4 pt-3 pointer-events-none">
      <div
        role="status"
        className={`pointer-events-auto max-w-[640px] w-full border border-ochre-edge ${tone.soft}`}
        style={{ animation: "rise 0.3s cubic-bezier(0.22,1,0.36,1) both" }}
      >
        <span className={`block h-[3px] w-full ${tone.mark}`} aria-hidden="true" />
        <div className="p-4 flex items-start gap-3.5">
        <i className={`ph-bold ph-hourglass-high text-lg shrink-0 mt-0.5 ${tone.text}`}></i>
        <div className="flex-1 min-w-0">
          <p className={`display text-[1.0625rem] ${tone.text}`}>
            {limit.error.kind === "secondary"
              ? "GitHub is asking us to slow down"
              /* Named, because the three budgets are different sizes in
                 different units. A search limit reported as "the request
                 budget" sends somebody to a usage screen showing single
                 digits for the hour, which cannot explain it and looks like
                 the app is lying. */
              : limit.error.resource === "search" ? "GitHub search limit reached"
              : limit.error.resource === "graphql" ? "GitHub GraphQL budget spent"
              : "GitHub request budget spent"}
          </p>
          <p className={`text-[13px] mt-1.5 leading-relaxed ${tone.text}`}>{limit.error.message}</p>
          <p className={`caps mt-2.5 tabular-nums ${tone.text}`}>
            {left > 0 ? <>Retrying in {formatLeft(left)}</> : <>Retrying now…</>}
          </p>
        </div>
        <button onClick={() => setLimit(null)} className={`textlink caps shrink-0 !${tone.text}`}
          aria-label="Dismiss">
          Dismiss
        </button>
        </div>
      </div>
    </div>
  );
}

/**
 * When this limit clears, in epoch ms. Called once, when the error arrives,
 * the last branch reads the clock, so calling it repeatedly would keep pushing
 * the deadline away.
 */
export function deadlineFor(e: RateLimitError, from = Date.now()): number {
  if (e.resetAt) return new Date(e.resetAt).getTime();
  if (e.retryAfter) return from + e.retryAfter * 1000;
  // GitHub told us nothing. A minute is long enough for a secondary limit and
  // short enough not to strand anyone on a banner that will not move.
  return from + 60_000;
}

function formatLeft(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
