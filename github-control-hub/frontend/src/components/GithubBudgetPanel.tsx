import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchGithubBudget, type Bucket, type UsageRow } from "../api/githubBudget";
import { Spinner, Note, SURFACE, TYPE } from "../design";

/**
 * What has been spent of the GitHub allowance, and by what.
 *
 * Both halves are measured. The allowances come from GitHub; the per-feature
 * counts come from a counter this app increments on every request it makes,
 * because GitHub reports that a request happened and never which feature made
 * it.
 *
 * This page used to publish estimates — requests-per-run times runs-per-hour,
 * derived from the code. They described a hypothetical organization, sat in the
 * same visual voice as the real numbers beside them, and gave nobody anything
 * to act on.
 */

const BUCKET: Record<Bucket, { label: string; icon: string; tone: string; bar: string; blurb: string }> = {
  core: {
    label: "Core", icon: "ph-cube", tone: "text-sky-500", bar: "bg-sky-500",
    blurb: "Ordinary REST reads and writes. The biggest allowance, and the one "
      + "almost everything draws on.",
  },
  search: {
    label: "Search", icon: "ph-magnifying-glass", tone: "text-amber-500", bar: "bg-amber-500",
    blurb: "Metered per minute rather than per hour, which makes it the "
      + "smallest budget in the app by a wide margin.",
  },
  graphql: {
    label: "GraphQL", icon: "ph-graph", tone: "text-violet-500", bar: "bg-violet-500",
    blurb: "Charged in points against its own allowance, so a GraphQL walk "
      + "never eats into core.",
  },
};

/**
 * How long GitHub's own window has been open.
 *
 * The two halves of this page count over different periods, and saying "this
 * hour" on both made them look like the same number disagreeing with itself.
 * GitHub's allowance refills on a rolling clock of its own: a window that reset
 * a minute ago reports almost nothing used, while the counter below still holds
 * everything since the top of the hour. Naming both periods is the difference
 * between a contradiction and two facts.
 */
function windowAge(iso: string, window: string): string {
  const resets = new Date(iso).getTime();
  if (!Number.isFinite(resets)) return "";
  // Search refills every minute, everything else every hour.
  const span = window.includes("minute") ? 60_000 : 3_600_000;
  const mins = Math.round((span - (resets - Date.now())) / 60_000);
  if (mins <= 0) return "just now";
  if (mins === 1) return "a minute ago";
  return `${mins} min ago`;
}

function untilReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "any moment";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * One feature's measured spend, expandable.
 *
 * Collapsed it answers "what is spending my allowance"; opened it answers "and
 * where do I go to change it". The endpoints and files are what make this
 * checkable rather than a claim, so they are one click away and not buried.
 */
function UsageLine({ row, biggest, open, onToggle }: {
  row: UsageRow; biggest: number; open: boolean; onToggle: () => void;
}) {
  const b = BUCKET[row.bucket];
  const width = biggest > 0 ? Math.max(2, (row.count / biggest) * 100) : 0;

  return (
    <div className="border-b border-slate-100 dark:border-ink/[0.06] last:border-0">
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        className="w-full text-left px-5 py-3 flex items-center gap-3
                   hover:bg-slate-50 dark:hover:bg-ink/[0.03] transition-colors"
      >
        <i className={`ph-bold ${b.icon} ${b.tone} text-[15px] shrink-0`} aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-slate-900 dark:text-ink truncate">
              {row.feature}
            </span>
            <span className={`${TYPE.label} ${b.tone} shrink-0`}>{b.label}</span>
          </div>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 truncate mt-0.5">
            {row.about?.trigger ?? "No description for this label yet"}
          </p>
          <div className="h-1 rounded-full bg-slate-100 dark:bg-ink/[0.07] mt-1.5 overflow-hidden">
            <div className={`h-full  ${b.bar} opacity-70`} style={{ width: `${width}%` }} />
          </div>
        </div>

        <div className="text-right shrink-0">
          <p className="display text-[0.9375rem] tabular-nums text-ink leading-none">
            {row.count.toLocaleString()}
          </p>
          <p className="text-[10.5px] text-slate-400 dark:text-slate-500 mt-0.5 tabular-nums">
            {(row.share * 100).toFixed(row.share < 0.1 ? 1 : 0)}% of measured
          </p>
        </div>

        <i className={`ph-bold ${open ? "ph-caret-up" : "ph-caret-down"}
                       text-[12px] text-slate-300 dark:text-slate-600 shrink-0`} aria-hidden="true" />
      </button>

      {open && (
        <div className="px-5 pb-4 pt-1 grid gap-3 bg-slate-50/60 dark:bg-ink/[0.02]">
          {/* Which process wrote these. Above the description, because on an
              Unattributed row it is the answer: a name other than "app" means a
              Lambda running a build from before that label existed, which is
              fixed by deploying rather than by editing anything. */}
          {(row.sources ?? []).length > 0 && (
            <div>
              <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Recorded by</p>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {row.sources.map(src => (
                  <span key={src.name}
                    className={`text-[10.5px] font-semibold px-1.5 py-0.5 rounded tabular-nums ${
                      src.name === "app"
                        ? "bg-slate-200/70 dark:bg-ink/[0.08] text-slate-600 dark:text-slate-300"
                        : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>
                    {src.name === "app" ? "this app" : src.name} · {src.count.toLocaleString()}
                  </span>
                ))}
              </div>
              {row.feature === "Unattributed"
                && row.sources.some(x => x.name !== "app") && (
                <p className="text-[11.5px] text-amber-700 dark:text-amber-400 mt-1.5 leading-relaxed">
                  A process other than this app recorded these. That build predates
                  the labels, so redeploying it is what moves them into named rows.
                </p>
              )}
            </div>
          )}

          {row.about ? (
            <>
              {row.about.note && (
                <p className="text-[12px] text-slate-600 dark:text-slate-300 leading-relaxed max-w-[75ch]">
                  {row.about.note}
                </p>
              )}
              <div>
                <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Grows with</p>
                <p className="text-[12px] text-slate-700 dark:text-slate-200 mt-0.5">
                  {row.about.scalesWith}
                </p>
              </div>
              {row.about.endpoints.length > 0 && (
                <div>
                  <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Endpoints</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {row.about.endpoints.map(e => (
                      <code key={e} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded
                                               bg-slate-200/70 dark:bg-ink/[0.08]
                                               text-slate-600 dark:text-slate-300">
                        {e}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              {row.about.files.length > 0 && (
                <div>
                  <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Made in</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {row.about.files.map(f => (
                      <code key={f} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded
                                               bg-slate-200/70 dark:bg-ink/[0.08]
                                               text-slate-500 dark:text-slate-400">
                        {f}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* A label in the code with no write-up here. Said plainly rather
               than left as an empty panel, because the fix is a one-line edit
               and nobody will make it if the gap is invisible. */
            <p className="text-[12px] text-slate-500 dark:text-slate-400 leading-relaxed">
              These requests are counted under a label that has no description
              yet. The count is real; the explanation is missing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function GithubBudgetPanel() {
  const [open, setOpen] = useState<string | null>(null);
  const [hours, setHours] = useState(1);

  /**
   * Held on for a moment after the request finishes.
   *
   * A cached answer comes back in single-digit milliseconds, so the spinner
   * appeared and vanished inside one frame and the button looked dead. The
   * floor is about feedback, not about the work.
   */
  const [spinning, setSpinning] = useState(false);
  const refresh = async () => {
    setSpinning(true);
    const done = refetch();
    await Promise.all([done, new Promise(r => setTimeout(r, 600))]);
    setSpinning(false);
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["github", "budget", hours],
    queryFn: () => fetchGithubBudget(hours),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  if (isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>;

  if (isError) {
    return (
      <Note intent="warn">
        The GitHub budget could not be read: {(error as Error)?.message}. Nothing
        else on this tab depends on it.
      </Note>
    );
  }
  if (!data) return null;

  /**
   * Read defensively, because this page can outlive its own backend.
   *
   * A desktop build ships a frontend and a backend together, but a cached entry
   * document can boot an older frontend against a newer server. When that
   * happened here the whole Activity tab went to a stack trace, because the
   * panel read `.usage[0]` on a response that no longer had a `usage`. The
   * caching is fixed; this is the other half, since a screen that dies on an
   * unexpected payload takes the tab down with it.
   */
  const usage = Array.isArray(data.usage) ? data.usage : [];
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const totals = data.totals ?? { core: 0, search: 0, graphql: 0 };
  const stale = !Array.isArray(data.usage);

  const biggest = usage[0]?.count ?? 0;
  const measured = Object.values(totals).reduce((a: number, n) => a + (Number(n) || 0), 0);
  const viaUser = usage.reduce((a, r) => a + (r.viaUser ?? 0), 0);

  /**
   * How many of each allowance's requests went out on a signed-in account.
   *
   * The reason a count of five thousand can sit beside an allowance GitHub
   * reports as untouched: those requests spent the person's own budget, not the
   * app's. Without this the pair looks like a bug, which is exactly how it was
   * read.
   *
   * A plain reduce, not a memo. Everything above this point can return early,
   * so a hook here runs on some renders and not others, which is what React
   * refuses. Memoising a loop over a few dozen rows would have bought nothing
   * and cost the whole tab.
   */
  const userByBucket: Record<string, number> = {};
  for (const row of usage) {
    userByBucket[row.bucket] = (userByBucket[row.bucket] ?? 0) + (row.viaUser ?? 0);
  }
  // Named exactly. "This hour" was read as "the last sixty minutes", which is
  // not what the counters bucket by and is where the confusion started.
  const windowLabel = hours === 1
    ? "since the top of the hour"
    : `over the last ${hours} hours`;

  return (
    <div className="grid gap-4">
      {stale && (
        <Note intent="warn">
          This screen is older than the server answering it, so some of it may be
          blank. Restarting the app picks up the matching version.
        </Note>
      )}
      {/* ── what was spent, per allowance ──────────────────────────────
          The figure a reader takes for "what I have used" has to be the one the
          rows below add up to. This led with GitHub's own used-of-limit, which
          is measured over a different window and was routinely a hundred times
          smaller, so the page appeared to contradict itself. What GitHub knows
          that this app cannot is how much room is left, and that is what its
          number is used for now. */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="display text-[1.1875rem] text-ink">
                What this app spent, {windowLabel}
              </h3>
              {/* One measurement on this page, not two.
                  GitHub's own "used" figure sat here as the headline beside
                  these counts, and the two never matched: GitHub meters over a
                  rolling window of its own that can have opened a minute ago,
                  while these cover the clock hour. Both were right and the pair
                  read as a contradiction, which is a worse outcome than showing
                  one of them. GitHub's number is still here, as the headroom it
                  is, underneath. */}
              <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                Counted by this app, per allowance. The three do not share, so
                running out of one leaves the others untouched.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* Counters are written every thirty seconds and by each job at
                  the end of its pass, so a request made a moment ago may not be
                  here yet. The button says so rather than leaving somebody
                  reloading the whole app to find out. */}
              <button type="button" onClick={refresh} disabled={spinning}
                title="Read the counters again"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold
                           border border-slate-200 dark:border-ink/10 text-slate-600 dark:text-slate-300
                           hover:bg-slate-50 dark:hover:bg-ink/[0.05] transition-colors
                           disabled:opacity-50">
                <i className={`ph-bold ph-arrows-clockwise text-[12px] ${
                  spinning || isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
                {spinning || isFetching ? "Reading…" : "Refresh"}
              </button>
            <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-ink/10">
              {[1, 6, 24].map(h => (
                <button key={h} type="button" onClick={() => setHours(h)}
                  className={`px-2.5 py-1 text-[12px] font-bold transition-colors ${
                    h === hours
                      ? "bg-slate-900 dark:bg-white text-reverse dark:text-slate-900"
                      : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-ink/[0.05]"}`}>
                  {h}h
                </button>
              ))}
            </div>
            </div>
          </div>
          <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3" />
        </div>

        {data.error ? (
          <div className="p-5"><Note intent="info">{data.error}. The measured half below still stands.</Note></div>
        ) : (
          <div className="p-5 grid sm:grid-cols-3 gap-5">
            {limits.map(l => {
              const b = BUCKET[l.bucket];
              const onUser = userByBucket[l.bucket] ?? 0;
              return (
                <div key={l.bucket}>
                  <div className="flex items-center gap-1.5">
                    <i className={`ph-bold ${b.icon} ${b.tone} text-[13px]`} aria-hidden="true" />
                    <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
                      {b.label} · {l.window}
                    </span>
                  </div>
                  {/* The number the list below adds up to. Anything else here
                      invites the reader to reconcile two figures that were
                      never measuring the same thing. */}
                  <p className="display text-[1.5rem] tabular-nums text-ink leading-none mt-1">
                    {(totals[l.bucket] ?? 0).toLocaleString()}
                    <span className="text-[13px] font-bold text-slate-400 dark:text-slate-500">
                      {" "}request{(totals[l.bucket] ?? 0) === 1 ? "" : "s"}
                    </span>
                  </p>

                  {/* No bar. It measured GitHub's headroom while sitting under
                      a count of requests, so it read as a progress bar of that
                      count and sat at full while the number above said five
                      thousand. A bar under a number it is not a fraction of is
                      worse than no bar. */}
                  {onUser > 0 && (
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
                      <span className="font-semibold text-slate-600 dark:text-slate-300 tabular-nums">
                        {onUser.toLocaleString()}
                      </span>{" "}
                      of those went out on your own sign-in, so they spent your
                      allowance rather than the app's.
                    </p>
                  )}
                  {/* Headroom is not in this box, and that is the fix rather
                      than an omission. A count over a period and a reading of
                      this instant are different quantities, and side by side in
                      one box they read as one number contradicting itself:
                      eight requests beside "30 of 30 available" looks like a
                      bug however carefully each half is labelled. Search makes
                      it worst, because its allowance refills every minute and
                      is therefore nearly always full. It has its own row
                      below. */}
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
                    {b.blurb}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── headroom, on its own ────────────────────────────────────
          One row for all three, away from the counts, because it answers a
          different question: not what has been spent, but whether there is
          room right now. */}
      {limits.length > 0 && (
        <section className={`${SURFACE.card} px-5 py-4`}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
              Room left right now
            </span>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              read from GitHub, this instant, for the app's own credentials
            </span>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 mt-2">
            {limits.map(l => {
              const b = BUCKET[l.bucket];
              const left = l.limit > 0 ? l.remaining / l.limit : 0;
              return (
                <div key={l.bucket} className="flex items-baseline gap-1.5">
                  <i className={`ph-bold ${b.icon} ${b.tone} text-[12px]`} aria-hidden="true" />
                  <span className="text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">
                    {b.label}
                  </span>
                  <span className={`text-[12.5px] font-bold tabular-nums ${
                    left > 0.5 ? "text-emerald-600 dark:text-emerald-400"
                      : left > 0.2 ? "text-amber-600 dark:text-amber-400"
                      : "text-rose-600 dark:text-rose-400"}`}>
                    {l.remaining.toLocaleString()}
                  </span>
                  <span className="text-[11.5px] text-slate-400 dark:text-slate-500">
                    of {l.limit.toLocaleString()}, refills in {untilReset(l.resetsAt)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* The sentence that stops somebody reading a full allowance as a
              contradiction of the counts above it. */}
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2.5 leading-relaxed max-w-[85ch]">
            These refill on GitHub's own clock rather than at the top of the
            hour, and search refills every minute, so a full reading here is
            normal even after a busy hour. It is also per token: requests made on
            your own sign-in never appear against the app's allowance.
          </p>
        
          {/* Why a full budget and a refusal are not a contradiction.
              Somebody reading "14,999 of 15,000" and then being told to wait a
              few minutes reasonably concludes this page is wrong. It is not
              measuring the thing that refused them. */}
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-3 leading-relaxed max-w-[85ch]">
            These are the hourly budgets. GitHub also applies <strong className="font-semibold">secondary</strong>{" "}
            limits, on the shape of the traffic rather than its total: too many requests at once,
            too fast against one endpoint, or too much created too quickly. Those are not reported
            here and are not visible in any number on this page, so a request can be refused with
            "wait a few minutes" while every figure above still reads nearly full. Anything that
            meets one is waited out and retried rather than shown to you.
          </p>
        </section>
      )}

      {/* ── who spent it ───────────────────────────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="display text-[1.1875rem] text-ink">
              Which feature spent it
            </h3>
            {measured > 0 && (
              <span className="text-[12px] font-bold tabular-nums text-slate-500 dark:text-slate-400">
                {measured.toLocaleString()} requests counted
                {viaUser > 0 && (
                  <span className="font-semibold text-slate-400 dark:text-slate-500">
                    {" "}· {viaUser.toLocaleString()} on a signed-in account
                  </span>
                )}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5 max-w-[80ch]">
            Counted as each request is made, by the feature that made it. Open a
            row for what it does, the endpoints it calls, and the files to change.
          </p>
          {/* The question this page kept raising: somebody reloads a tab, the
              numbers do not move, and the counter looks broken when it is
              working exactly as designed. */}
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-1.5 max-w-[80ch] leading-relaxed">
            Reloading a tab often adds nothing here, and that is the point: most
            checks are computed from stored data and never reach GitHub, and the
            alert sweep and the Renovate search are held for a minute and shared,
            so a second look inside that minute costs nothing.
          </p>
          <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3" />
        </div>

        {data.empty || usage.length === 0 ? (
          /* Nothing recorded and nothing happening look identical in the
             numbers and are completely different situations. */
          <div className="p-5">
            <Note intent="info">
              Nothing has been counted yet for {windowLabel}. Counters are written
              every thirty seconds by the app, and at the end of each run by the
              alarm and graph jobs, so a freshly started install has nothing to
              show until the next pass finishes. Requests this app made a moment
              ago are written before this page is drawn, so Refresh picks them up
              at once.
            </Note>
          </div>
        ) : (
          <div>
            {usage.map(row => (
              <UsageLine key={`${row.feature}:${row.bucket}`} row={row} biggest={biggest}
                open={open === `${row.feature}:${row.bucket}`}
                onToggle={() => setOpen(o => (o === `${row.feature}:${row.bucket}`
                  ? null : `${row.feature}:${row.bucket}`))} />
            ))}
          </div>
        )}
      </section>

      <p className="text-[11.5px] text-slate-400 dark:text-slate-500 px-1 leading-relaxed max-w-[85ch]">
        Every number on this page is counted by this app, over the window
        chosen above, so the totals and the rows always agree. The only figure
        that comes from GitHub is how much is still available, which is a fact
        about this moment rather than a count over a period: GitHub meters on a
        rolling window of its own, and comparing it against these totals is
        comparing two different questions. Requests made outside a named feature
        are counted under{" "}
        <span className="font-semibold">Unattributed</span> rather than dropped.
        Drawing this page costs one request to{" "}
        <code className="font-mono text-[11px]">GET /rate_limit</code>, the one
        endpoint GitHub does not charge against the limit it reports.
      </p>
    </div>
  );
}
