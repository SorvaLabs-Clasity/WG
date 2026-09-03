import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { bulkDependabot, type BulkAction, type BulkSummary } from "../api/dependencies";
import { Button, Note, SURFACE, TYPE } from "../design";
import { rolloutDependabotConfig, type RolloutSummary } from "../api/dependencies";

/**
 * Turning Dependabot on and off across the organization, in one place.
 *
 * The tab it sits in answers "what is vulnerable". This answers the question
 * that follows and had no home: which repositories are being watched at all,
 * and switching the ones that are not. Doing that a repository at a time meant
 * finding each one, and doing it quickly meant GitHub refusing the burst.
 *
 * Built from the rows the tab already has, so opening it costs nothing. Every
 * repository the sweep saw is here, whether or not it has a finding.
 */

type Filter = "all" | "watched" | "off";

interface RepoRow {
  repo: string;
  /** Dependabot is switched off entirely: nothing is being scanned. */
  off: boolean;
  /** Watched, and currently reporting nothing. */
  clean: boolean;
  /** Open findings, and how bad the worst of them is. */
  findings: number;
  worst?: string;
}

const ACTIONS: Array<{ id: BulkAction; label: string; hint: string; danger?: boolean }> = [
  { id: "alerts-on", label: "Turn alerts on",
    hint: "Start scanning these repositories for vulnerable dependencies." },
  { id: "fixes-on", label: "Open fix pull requests",
    hint: "Turns on Dependabot security updates, which is what opens a pull request per vulnerability. Alerts are turned on too, since GitHub will not raise updates on a repository it is not scanning." },
  { id: "alerts-off", label: "Turn alerts off", danger: true,
    hint: "Stops scanning. Existing findings disappear from this tab." },
  { id: "fixes-off", label: "Stop opening pull requests", danger: true,
    hint: "Leaves alerts on, so you still see what is vulnerable." },
];

export default function DependabotManager({ rows, onDone }: {
  /** Every alert row the tab holds, findings and markers alike. */
  rows: Array<{ repo: string; clean?: boolean; disabled?: boolean; scanning?: boolean; severity?: string }>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rollout, setRollout] = useState<RolloutSummary | null>(null);
  const [rollingOut, setRollingOut] = useState<"pr" | "commit" | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<BulkAction | null>(null);

  /** One row per repository, from the many alert rows each one produces. */
  const repos = useMemo<RepoRow[]>(() => {
    const worstRank: Record<string, number> = { critical: 4, high: 3, medium: 3, moderate: 2, low: 1 };
    const byRepo = new Map<string, RepoRow>();
    for (const r of rows) {
      const row = byRepo.get(r.repo) ?? { repo: r.repo, off: false, clean: false, findings: 0 };
      if (r.disabled) row.off = true;
      if (r.clean) row.clean = true;
      if (!r.disabled && !r.clean && !r.scanning) {
        row.findings++;
        if (!row.worst || (worstRank[r.severity ?? ""] ?? 0) > (worstRank[row.worst] ?? 0)) {
          row.worst = r.severity;
        }
      }
      byRepo.set(r.repo, row);
    }
    return [...byRepo.values()].sort((a, b) =>
      // Off first, then the ones with the most to fix: both are the reason
      // somebody opened this.
      Number(b.off) - Number(a.off) || b.findings - a.findings || a.repo.localeCompare(b.repo));
  }, [rows]);

  const shown = useMemo(() => repos.filter(r => {
    if (filter === "off" && !r.off) return false;
    if (filter === "watched" && r.off) return false;
    return !search.trim() || r.repo.toLowerCase().includes(search.trim().toLowerCase());
  }), [repos, filter, search]);

  const allShownSelected = shown.length > 0 && shown.every(r => selected.has(r.repo));

  const toggle = (repo: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(repo)) next.delete(repo); else next.add(repo);
    return next;
  });

  // Acts on what is on screen, not on everything. A tick box above a filtered
  // list that quietly selected the rest would be the worst possible surprise
  // on a control that turns scanning off.
  const toggleAllShown = () => setSelected(prev => {
    const next = new Set(prev);
    if (allShownSelected) shown.forEach(r => next.delete(r.repo));
    else shown.forEach(r => next.add(r.repo));
    return next;
  });

  const run = useMutation({
    mutationFn: ({ action }: { action: BulkAction }) =>
      bulkDependabot([...selected], action),
    onSuccess: (result) => {
      setSummary(result);
      setRunning(null);
      // Only the ones that failed stay ticked, so pressing again retries
      // exactly those rather than redoing the whole list.
      setSelected(new Set(result.results.filter(r => !r.ok).map(r => r.repo)));
      qc.invalidateQueries({ queryKey: ["dependencies"] });
      onDone();
    },
    onError: (e) => { setError((e as Error).message); setRunning(null); },
  });

  /**
   * Switch on grouped security updates by writing the configuration file.
   *
   * Separated from the settings actions above because it is a different kind
   * of thing: those flip a switch, this writes to the repository. The
   * confirmation says which repositories and how the file lands, because a
   * mistake here is a commit somebody has to revert across an organization.
   */
  const startRollout = async (mode: "pr" | "commit") => {
    const n = selected.size;
    const what = mode === "pr"
      ? `Open a pull request adding .github/dependabot.yml on ${n} repositor${n === 1 ? "y" : "ies"}?`
      : `Commit .github/dependabot.yml straight to the default branch of ${n} `
        + `repositor${n === 1 ? "y" : "ies"}? There is no review step.`;
    if (!confirm(what)) return;

    setError(""); setRollout(null); setRollingOut(mode);
    try {
      setRollout(await rolloutDependabotConfig([...selected], mode));
    } catch (e: any) {
      setError(e?.message ?? "Could not write the configuration");
    } finally {
      setRollingOut(null);
    }
  };

  const start = (action: BulkAction) => {
    setError(""); setSummary(null); setRunning(action);
    run.mutate({ action });
  };

  const counts = useMemo(() => ({
    off: repos.filter(r => r.off).length,
    watched: repos.filter(r => !r.off).length,
  }), [repos]);

  return (
    <div>
      <div className="pb-3 flex items-center gap-2 flex-wrap">
        {([["all", `All ${repos.length}`], ["off", `Not watched ${counts.off}`],
           ["watched", `Watched ${counts.watched}`]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setFilter(id as Filter)}
            aria-pressed={filter === id}
            className={`px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-colors ${
              filter === id
                ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900"
                : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.06]"}`}>
            {label}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Filter by name" className={`${SURFACE.input} max-w-[220px] ml-auto`} />
      </div>

      <div className="pb-2 flex items-center gap-2 flex-wrap border-b border-slate-200/70 dark:border-white/[0.07]">
        <label className="inline-flex items-center gap-2 text-[12.5px] font-semibold
                          text-slate-600 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown}
            className="w-4 h-4 rounded border-slate-300 dark:border-slate-600" />
          Select all {shown.length === repos.length ? "" : `${shown.length} shown`}
        </label>
        <span className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
          {selected.size} selected
        </span>
        {selected.size > 0 && (
          <button type="button" onClick={() => setSelected(new Set())}
            className="text-[12px] font-semibold text-slate-400 hover:text-slate-700
                       dark:hover:text-slate-200 transition-colors">
            Clear
          </button>
        )}
      </div>

      <div className="max-h-[380px] overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.06]">
        {shown.length === 0 ? (
          <p className="py-6 text-[12.5px] text-slate-400 dark:text-slate-500">
            Nothing matches.
          </p>
        ) : shown.map(r => (
          <label key={r.repo}
            className="flex items-center gap-3 px-2 -mx-2 rounded-lg py-2.5 cursor-pointer
                       hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
            <input type="checkbox" checked={selected.has(r.repo)} onChange={() => toggle(r.repo)}
              className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 shrink-0" />
            <span className="text-[13px] font-medium text-slate-800 dark:text-slate-200 truncate flex-1">
              {r.repo}
            </span>
            {r.off ? (
              <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded shrink-0
                               bg-slate-200/70 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400">
                not watched
              </span>
            ) : r.findings > 0 ? (
              <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded shrink-0 tabular-nums ${
                r.worst === "critical"
                  ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>
                {r.findings} open
              </span>
            ) : (
              <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded shrink-0
                               bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                clear
              </span>
            )}
          </label>
        ))}
      </div>

      <div className="pt-4 mt-1 grid gap-2.5 border-t border-slate-200/70 dark:border-white/[0.07]">
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map(a => (
            <Button key={a.id}
              variant={a.id === "fixes-on" ? "primary"
                : a.danger ? "caution" : undefined}
              disabled={selected.size === 0 || !!running}
              onClick={() => {
                if (a.danger && !confirm(
                  `${a.label} on ${selected.size} repositor${selected.size === 1 ? "y" : "ies"}?`)) return;
                start(a.id);
              }}>
              {running === a.id ? "Working…" : a.label}
            </Button>
          ))}
        </div>

        {/* The second kind of action, kept visually apart from the switches
            above, because this one writes a file into the repository and that
            is not something to press by accident. */}
        <div className="mt-1 pt-3.5 border-t border-slate-100 dark:border-white/[0.06]">
          <p className="text-[12px] font-bold text-slate-700 dark:text-slate-200">
            Findings with patches and no pull requests
          </p>
          <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-[80ch] mt-1">
            Where the switch is already on and nothing has arrived, GitHub never
            scheduled the work, and no API asks it to try again. Turning on
            grouped security updates is the one thing GitHub documents as
            immediately retrying every open alert that has a patch. That needs a
            <span className="font-mono text-[11px]"> .github/dependabot.yml</span>,
            built here from each repository's own alerts. Fixes arrive grouped
            into one pull request per ecosystem and manifest rather than one per
            alert. Repositories that already have that file are left alone.
          </p>
          {/* The obvious wrong conclusion from everything above: that the file
              replaces the switches. GitHub lists them as prerequisites for it,
              not alternatives to it. */}
          <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-[80ch] mt-1.5">
            This does not replace the two switches. Dependabot alerts and security
            updates both still have to be on: the file decides how fixes are
            grouped, the switches decide whether there are any.
          </p>
          {/* First, because it needs nobody's permission. Under branch
              protection the two buttons below it are a pull request and an
              approval per repository before a single fix arrives. */}
          <div className="flex flex-wrap gap-2 mt-2.5">
            <Button variant="primary"
              disabled={selected.size === 0 || !!rollingOut || !!running}
              onClick={() => {
                if (!confirm(
                  `Switch security updates off and straight back on for ${selected.size} `
                  + `repositor${selected.size === 1 ? "y" : "ies"}? They are briefly off `
                  + `while this runs.`)) return;
                start("retrigger");
              }}>
              {running === "retrigger" ? "Re-triggering…" : "Re-trigger fixes"}
            </Button>
          </div>
          <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-[80ch] mt-2">
            Try this one first: it writes nothing and needs no approval. Security
            updates go briefly off and back on, which asks GitHub to look at the
            backlog again. GitHub does not document this as a re-trigger, so it
            may do nothing, and that is the whole reason to try it before the
            two below. If a repository cannot be switched back on it is named
            loudly rather than counted, because it is then less protected than
            before you pressed anything.
          </p>

          <p className="text-[11.5px] font-bold text-slate-600 dark:text-slate-300 mt-3.5">
            If that changes nothing, write the config instead
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Button variant="primary"
              disabled={selected.size === 0 || !!rollingOut || !!running}
              onClick={() => startRollout("pr")}>
              {rollingOut === "pr" ? "Opening…" : "Open config PRs"}
            </Button>
            <Button variant="caution"
              disabled={selected.size === 0 || !!rollingOut || !!running}
              onClick={() => startRollout("commit")}>
              {rollingOut === "commit" ? "Committing…" : "Commit to default branch"}
            </Button>
          </div>
          {rollingOut && (
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-2">
              Four or five writes per repository, paced so GitHub does not refuse
              the burst. This takes a while.
            </p>
          )}
          {rollout && (
            <Note intent={rollout.failed ? "warn" : "good"}>
              {rollout.opened > 0 && <>{rollout.opened} pull request{rollout.opened === 1 ? "" : "s"} opened. </>}
              {rollout.committed > 0 && <>{rollout.committed} committed. </>}
              {rollout.skipped > 0 && <>{rollout.skipped} skipped, already configured or with no configurable ecosystem. </>}
              {rollout.failed > 0 && <>{rollout.failed} could not be written.</>}
              {rollout.opened > 0 && (
                <ul className="mt-1.5 grid gap-0.5">
                  {rollout.results.filter(r => r.url).slice(0, 10).map(r => (
                    <li key={r.repo} className="text-[11.5px]">
                      <a href={r.url} target="_blank" rel="noreferrer"
                        className="font-mono underline underline-offset-2">{r.repo}</a>
                    </li>
                  ))}
                </ul>
              )}
              {rollout.failed > 0 && (
                <ul className="mt-1.5 grid gap-0.5">
                  {rollout.results.filter(r => r.outcome === "failed").slice(0, 8).map(r => (
                    <li key={r.repo} className="text-[11.5px]">
                      <span className="font-mono">{r.repo}</span>: {r.detail}
                    </li>
                  ))}
                </ul>
              )}
              {/* A file that landed and will do nothing is not a failure and
                  not a success, and it is the outcome somebody would otherwise
                  walk away from believing. */}
              {rollout.results.some(r => r.warning) && (
                <p className="text-[11.5px] mt-2">
                  {rollout.results.filter(r => r.warning).length} of these have security
                  updates switched off, so the file will produce nothing there until it is
                  on. Select them above and press <strong>Auto-fix PRs</strong> first.
                </p>
              )}
            </Note>
          )}
        </div>

        {/* Said before it is pressed, not after. Somebody expecting a pull
            request per vulnerability should know GitHub raises them on its own
            schedule rather than while they watch. */}
        <p className="text-[11.5px] text-slate-400 dark:text-slate-500 leading-relaxed max-w-[80ch]">
          {ACTIONS.find(a => a.id === (running ?? "fixes-on"))?.hint}
          {" "}GitHub opens the pull requests itself once security updates are on,
          usually within a few minutes, rather than at the moment you press this.
        </p>

        {running && (
          <p className="text-[12px] text-slate-500 dark:text-slate-400">
            Working through {selected.size} repositor{selected.size === 1 ? "y" : "ies"}, a few at
            a time. This is deliberately unhurried.
          </p>
        )}

        {error && <Note intent="danger">{error}</Note>}

        {summary && summary.leftOff > 0 && (
          <Note intent="danger">
            Security updates are now OFF on {summary.leftOffRepos.join(", ")} and could
            not be switched back on. Those repositories are less protected than before
            this ran. Turn them back on with the button above, or in their settings.
          </Note>
        )}

        {summary && (
          <Note intent={summary.failed ? "warn" : "good"}>
            {summary.changed} changed{summary.failed ? `, ${summary.failed} could not be` : ""}.
            {summary.sleptSeconds > 0 && (
              <> GitHub asked us to pause for about {summary.sleptSeconds}s along the way.</>
            )}
            {summary.failed > 0 && (
              <ul className="mt-1.5 grid gap-0.5">
                {summary.results.filter(r => !r.ok).slice(0, 8).map(r => (
                  <li key={r.repo} className="text-[11.5px]">
                    <span className="font-mono">{r.repo}</span>: {r.error}
                  </li>
                ))}
              </ul>
            )}
            {summary.failed > 0 && (
              <p className="text-[11.5px] mt-1.5">
                Those are still selected, so pressing again retries only them.
              </p>
            )}
          </Note>
        )}

        <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
          Runs with your own GitHub account, so it can only change repositories
          you administer.
        </p>
      </div>
    </div>
  );
}
