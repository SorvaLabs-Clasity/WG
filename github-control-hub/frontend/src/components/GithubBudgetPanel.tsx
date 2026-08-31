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
    <div className="border-b border-slate-100 dark:border-white/[0.06] last:border-0">
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        className="w-full text-left px-5 py-3 flex items-center gap-3
                   hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors"
      >
        <i className={`ph-bold ${b.icon} ${b.tone} text-[15px] shrink-0`} aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-slate-900 dark:text-white truncate">
              {row.feature}
            </span>
            <span className={`${TYPE.label} ${b.tone} shrink-0`}>{b.label}</span>
          </div>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 truncate mt-0.5">
            {row.about?.trigger ?? "No description for this label yet"}
          </p>
          <div className="h-1 rounded-full bg-slate-100 dark:bg-white/[0.07] mt-1.5 overflow-hidden">
            <div className={`h-full rounded-full ${b.bar} opacity-70`} style={{ width: `${width}%` }} />
          </div>
        </div>

        <div className="text-right shrink-0">
          <p className="text-[15px] font-bold tabular-nums text-slate-900 dark:text-white leading-none">
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
        <div className="px-5 pb-4 pt-1 grid gap-3 bg-slate-50/60 dark:bg-white/[0.02]">
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
                        ? "bg-slate-200/70 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300"
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
                                               bg-slate-200/70 dark:bg-white/[0.08]
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
                                               bg-slate-200/70 dark:bg-white/[0.08]
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

  const appTotals = data.appTotals ?? { core: 0, search: 0, graphql: 0 };
  const biggest = usage[0]?.count ?? 0;
  const measured = Object.values(totals).reduce((a: number, n) => a + (Number(n) || 0), 0);
  const viaUser = usage.reduce((a, r) => a + (r.viaUser ?? 0), 0);
  const windowLabel = hours === 1 ? "this hour" : `the last ${hours} hours`;

  return (
    <div className="grid gap-4">
      {stale && (
        <Note intent="warn">
          This screen is older than the server answering it, so some of it may be
          blank. Restarting the app picks up the matching version.
        </Note>
      )}
      {/* ── the allowances ─────────────────────────────────────────────
          Used, not remaining. "14,985 / 15,000" is the same fact told
          backwards, and every reader takes the first number for what they have
          spent, because that is what a figure over a total means everywhere
          else. */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
                Used of each allowance
              </h3>
              <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                Read from GitHub. Three separate allowances that do not share, so
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
                           border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300
                           hover:bg-slate-50 dark:hover:bg-white/[0.05] transition-colors
                           disabled:opacity-50">
                <i className={`ph-bold ph-arrows-clockwise text-[12px] ${
                  spinning || isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
                {spinning || isFetching ? "Reading…" : "Refresh"}
              </button>
            <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-white/10">
              {[1, 6, 24].map(h => (
                <button key={h} type="button" onClick={() => setHours(h)}
                  className={`px-2.5 py-1 text-[12px] font-bold transition-colors ${
                    h === hours
                      ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900"
                      : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.05]"}`}>
                  {h}h
                </button>
              ))}
            </div>
            </div>
          </div>
          <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
        </div>

        {data.error ? (
          <div className="p-5"><Note intent="info">{data.error}. The measured half below still stands.</Note></div>
        ) : (
          <div className="p-5 grid sm:grid-cols-3 gap-5">
            {limits.map(l => {
              const b = BUCKET[l.bucket];
              const spent = l.limit > 0 ? l.used / l.limit : 0;
              return (
                <div key={l.bucket}>
                  <div className="flex items-center gap-1.5">
                    <i className={`ph-bold ${b.icon} ${b.tone} text-[13px]`} aria-hidden="true" />
                    <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
                      {b.label} · {l.window}
                    </span>
                  </div>
                  <p className="text-[24px] font-black tabular-nums text-slate-900 dark:text-white leading-none mt-1">
                    {l.used.toLocaleString()}
                    <span className="text-[13px] font-bold text-slate-400 dark:text-slate-500">
                      {" "}used of {l.limit.toLocaleString()}
                    </span>
                  </p>
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-white/[0.07] mt-2 overflow-hidden">
                    <div className={`h-full rounded-full ${
                      spent < 0.5 ? "bg-emerald-500" : spent < 0.8 ? "bg-amber-500" : "bg-rose-500"}`}
                      style={{ width: `${Math.max(1, Math.min(100, spent * 100))}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
                    {l.remaining.toLocaleString()} left, refilling in {untilReset(l.resetsAt)}.
                  </p>
                  {/* The bridge between the two halves of this page. GitHub
                      meters per token and its window is its own, so this app's
                      count of what it spent on the App's credentials is close
                      to, but never exactly, the figure above. Said here rather
                      than left for somebody to notice and disbelieve. */}
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 leading-relaxed">
                    This app counted{" "}
                    <span className="font-semibold text-slate-600 dark:text-slate-300 tabular-nums">
                      {(appTotals[l.bucket] ?? 0).toLocaleString()}
                    </span>{" "}
                    of its own {windowLabel}.
                  </p>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 leading-relaxed">
                    {b.blurb}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── who spent it ───────────────────────────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
              What spent it, {windowLabel}
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
          <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
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
        The two halves will not match exactly, for two reasons worth knowing.
        GitHub meters <span className="font-semibold">per token</span>: the
        allowances above are the app's own, while requests made on a signed-in
        person's account draw on theirs, so only the app's half is comparable.
        And the windows differ — GitHub's refills on its own clock, this counts
        by the hour. Requests made outside a named feature are counted under{" "}
        <span className="font-semibold">Unattributed</span> rather than dropped.
        Drawing this page costs one request to{" "}
        <code className="font-mono text-[11px]">GET /rate_limit</code>, the one
        endpoint GitHub does not charge against the limit it reports.
      </p>
    </div>
  );
}
