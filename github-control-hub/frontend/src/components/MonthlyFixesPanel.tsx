import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Note, ConfirmDialog } from "../design";
import { usePermissionSet } from "../hooks/usePermissionSet";
import {
  fetchMonthlyFixes, saveMonthlyFixes, runMonthlyFixesNow,
  type MonthlyView, type MonthlyRun,
} from "../api/dependencies";

/**
 * Dependabot security fixes, held back and released once a month.
 *
 * GitHub opens a security-fix pull request as soon as an alert appears, and
 * nothing in dependabot.yml changes that. So repositories in this batch have
 * their fixes switched off, and on the 1st an hourly job in AWS switches them
 * on for 24 hours — which is when GitHub raises the month's pull requests —
 * and then off again. See backend/src/services/dependabotMonthly.ts.
 *
 * Lives in the Dependabot manager because the batch is chosen from the same
 * ticked repositories every other action there uses.
 */

const plural = (n: number, one = "repository", many = "repositories") => `${n} ${n === 1 ? one : many}`;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** The next 1st, in the schedule's own time zone, said as a date. */
function nextRelease(timeZone: string, lastOpenedMonth?: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const [y, m, d] = [get("year"), get("month"), get("day")];
  const thisMonth = `${y}-${String(m).padStart(2, "0")}`;
  if (d === 1 && lastOpenedMonth !== thisMonth) return "today";
  const next = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 12));
  return next.toLocaleDateString(undefined, { day: "numeric", month: "long", timeZone: "UTC" });
}

const KIND: Record<MonthlyRun["kind"], string> = {
  open: "Fixes switched on",
  close: "Fixes switched off",
  join: "Added to the batch",
  leave: "Taken out of the batch",
};

export default function MonthlyFixesPanel({ selected }: {
  /** The repositories ticked in the manager. */
  selected: string[];
}) {
  const qc = useQueryClient();
  const { can, holds } = usePermissionSet();
  const mayChange = can("deps.dependabot.bulk");
  const [confirm, setConfirm] = useState<"run" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["dependabot", "monthly"],
    queryFn: fetchMonthlyFixes,
    enabled: holds("deps.dependabot.read"),
    staleTime: 30_000,
  });

  const settle = (next: MonthlyView) => {
    qc.setQueryData(["dependabot", "monthly"], next);
    qc.invalidateQueries({ queryKey: ["dependencies"] });
    setError(null);
  };
  const save = useMutation({
    mutationFn: ({ enabled, repos }: { enabled: boolean; repos: string[] }) => saveMonthlyFixes(enabled, repos),
    onSuccess: settle,
    onError: (e: Error) => setError(e.message),
  });
  const run = useMutation({
    mutationFn: runMonthlyFixesNow,
    onSuccess: settle,
    onError: (e: Error) => setError(e.message),
  });

  if (!data) return null;
  const { schedule, missed } = data;
  const busy = save.isPending || run.isPending;
  const inBatch = new Set(schedule.enabled ? schedule.repos : []);
  const adding = selected.filter(r => !inBatch.has(r));
  const windowOpen = !!schedule.openUntil && Date.parse(schedule.openUntil) > Date.now();

  return (
    <div className="mt-1 pt-3.5 border-t border-slate-100 dark:border-ink/[0.06]">
      <p className="text-[0.75rem] font-bold text-slate-700 dark:text-slate-200">Monthly security fixes</p>
      <p className="text-[0.7188rem] text-slate-500 dark:text-slate-400 leading-relaxed max-w-[80ch] mt-1">
        GitHub opens a fix pull request as soon as a vulnerability is found, and that cannot be scheduled.
        Repositories in this batch have their fixes switched off instead, and on the 1st of each month
        they are switched on for {schedule.windowHours} hours, which is when the month's pull requests
        arrive together. A new vulnerability can wait up to a month for its fix. GitHub does not document
        that switching fixes on raises them, so try it with one repository first.
      </p>

      {missed.length > 0 && (
        <Note intent="danger">
          {plural(missed.length)} in the batch did not get this month's fixes, and their security
          fixes are still off:
          <ul className="mt-1.5 space-y-0.5">
            {missed.slice(0, 8).map(m => (
              <li key={m.repo}><span className="font-mono">{m.repo}</span>{m.error ? ` — ${m.error}` : ""}</li>
            ))}
          </ul>
        </Note>
      )}

      <div className="mt-2.5 text-[0.75rem] text-slate-700 dark:text-slate-200">
        {!schedule.enabled || schedule.repos.length === 0 ? (
          <span>Off. Every repository gets fixes as soon as they are found.</span>
        ) : windowOpen ? (
          <span>
            Fixes are on for {plural(schedule.repos.length)} until {when(schedule.openUntil!)}, then off
            until the next 1st.
          </span>
        ) : (
          <span>
            {plural(schedule.repos.length)} held back. Next release: {nextRelease(schedule.timeZone, schedule.lastOpenedMonth)}.
          </span>
        )}
      </div>

      {schedule.repos.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {schedule.repos.map(repo => (
            <span key={repo} className="inline-flex items-center gap-1.5 border border-rule px-2 py-0.5 font-mono text-[0.6875rem]">
              {repo}
              {mayChange && (
                <button aria-label={`Take ${repo} out of the batch`} disabled={busy}
                  onClick={() => save.mutate({ enabled: true, repos: schedule.repos.filter(r => r !== repo) })}
                  className="text-ink-3 hover:text-crimson">×</button>
              )}
            </span>
          ))}
        </div>
      )}

      {mayChange && (
        <div className="flex flex-wrap gap-2 mt-2.5">
          <Button disabled={adding.length === 0 || busy}
            onClick={() => save.mutate({ enabled: true, repos: [...(schedule.enabled ? schedule.repos : []), ...adding] })}>
            {save.isPending ? "Saving…" : adding.length > 0
              ? `Put ${plural(adding.length)} in the monthly batch` : "Tick repositories to add them"}
          </Button>
          {schedule.enabled && schedule.repos.length > 0 && (
            <>
              <Button disabled={busy || windowOpen} onClick={() => setConfirm("run")}>
                {run.isPending ? "Switching on…" : "Run now"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirm("off")}>
                Turn monthly off
              </Button>
            </>
          )}
        </div>
      )}
      <p className="text-[0.7188rem] text-slate-400 dark:text-slate-500 leading-relaxed max-w-[80ch] mt-2">
        Adding a repository switches its fixes off now; taking one out switches them back on. The monthly
        switch-on is done by the app's job in AWS, as the GitHub App, which needs Administration: write.
      </p>
      {error && <Note intent="danger">{error}</Note>}

      {schedule.history.length > 0 && (
        <ul className="mt-2.5 space-y-1 text-[0.7188rem] text-slate-500 dark:text-slate-400">
          {schedule.history.slice(0, 5).map(h => {
            const failed = h.results.filter(r => !r.ok);
            return (
              <li key={`${h.at}-${h.kind}`}>
                {when(h.at)} · {KIND[h.kind]} · {h.trigger === "schedule" ? "by the monthly job" : `by ${h.by}`} ·{" "}
                {h.results.length - failed.length} of {h.results.length} done
                {failed.length > 0 && (
                  <span className="text-crimson"> — {failed.slice(0, 3).map(f => `${f.repo}: ${f.error ?? "failed"}`).join("; ")}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirm === "run"}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); run.mutate(); }}
        title="Release this month's fixes now"
        confirmLabel="Switch fixes on"
        intent="warn"
        busy={run.isPending}
        body={<p>
          Security fixes go on for {plural(schedule.repos.length)} now, and the monthly job switches them off
          again after {schedule.windowHours} hours. GitHub should open the fix pull requests during that time.
          This does not use up the 1st's own release.
        </p>}
      />
      <ConfirmDialog
        open={confirm === "off"}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); save.mutate({ enabled: false, repos: [] }); }}
        title="Turn monthly fixes off"
        confirmLabel="Turn off"
        intent="warn"
        busy={save.isPending}
        body={<p>
          Security fixes are switched back on for {plural(schedule.repos.length)}, so GitHub opens fix pull
          requests as soon as vulnerabilities are found, the way it did before.
        </p>}
      />
    </div>
  );
}
