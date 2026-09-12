import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { bulkDependabot, type BulkAction, type BulkSummary } from "../api/dependencies";
import {
  Button, Note, ConfirmDialog, ProgressDialog, SURFACE, TYPE,
  type ProgressLine, type Intent,
} from "../design";
import {
  rolloutDependabotConfig, closeDependabotPrs,
  type RolloutSummary, type CloseSummary,
} from "../api/dependencies";

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

/**
 * How many repositories go in one request.
 *
 * The whole run used to be a single call, which the route itself capped at two
 * hundred because "a list of a thousand would outlive the connection waiting
 * for it". Sending it in batches fixes that and buys the thing this was asked
 * for: the run reports itself as it goes instead of saying nothing for a minute
 * and then everything at once.
 *
 * Four rather than one. Each repository is one or more paced writes, and a
 * request per repository would spend more time in round trips than in work,
 * while a batch this size still lands often enough that the bar moves.
 */
const CHUNK = 4;

/** "one repository" / "40 repositories", said once rather than at every call. */
const plural = (n: number) => `${n} repositor${n === 1 ? "y" : "ies"}`;

/** What is on screen while a run is going, and after it has finished. */
interface Progress {
  title: string;
  done: number;
  total: number;
  lines: ProgressLine[];
  running: boolean;
  footer?: React.ReactNode;
  intent: Intent;
  /** What the stop button offers, where stopping is meaningful. */
  cancel?: { label: string; note?: string } | null;
}

/** A confirmation waiting to be answered. */
interface Confirming {
  title: string;
  body: React.ReactNode;
  label: string;
  intent: Intent;
  go: () => void;
}

interface RepoRow {
  repo: string;
  /** Dependabot is switched off entirely: nothing is being scanned. */
  off: boolean;
  /** Watched, and currently reporting nothing. */
  clean: boolean;
  /** Open findings, and how bad the worst of them is. */
  findings: number;
  worst?: string;
  /**
   * GitHub refuses every settings change on an archived repository, whatever
   * access somebody has, so these are worth saying before a button is pressed
   * rather than after sixty-six of them have failed.
   */
  archived: boolean;
}

/**
 * What stopping a run halfway can honestly offer, per action.
 *
 * Only the switches have a true inverse. Turning alerts on is undone by turning
 * them off, and the repositories it already reached are known exactly, so
 * "cancel and undo" is a promise that can be kept.
 *
 * The others cannot be undone from here and must not pretend to be. A config
 * pull request could be closed, a commit to the default branch has to be
 * reverted, and a closed Dependabot pull request is the worst of the three:
 * GitHub treats the close as `@dependabot close` and will not raise it again,
 * so "undo" would mean reopening each one by hand. For those, stopping stops,
 * and the window says what stays done.
 *
 * `retrigger` is the odd one. It ends where it began, switched on, so there is
 * nothing to undo; what a half-finished one needs is the assurance that every
 * repository it touched is back on, which is `fixes-on` over the same set.
 */
const UNDO: Partial<Record<BulkAction, { action: BulkAction; label: string; title: string }>> = {
  "alerts-on": { action: "alerts-off", label: "Cancel and undo", title: "Undoing: turning alerts back off" },
  "alerts-off": { action: "alerts-on", label: "Cancel and undo", title: "Undoing: turning alerts back on" },
  "fixes-on": { action: "fixes-off", label: "Cancel and undo", title: "Undoing: turning fixes back off" },
  "fixes-off": { action: "fixes-on", label: "Cancel and undo", title: "Undoing: turning fixes back on" },
  retrigger: { action: "fixes-on", label: "Cancel", title: "Making sure fixes are back on" },
};

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

export default function DependabotManager({ rows, prCounts, onDone }: {
  /** Every alert row the tab holds, findings and markers alike. */
  rows: Array<{
    repo: string; clean?: boolean; disabled?: boolean; scanning?: boolean;
    severity?: string;
    /** Archived. Stamped by the view from the same query that reads the switches. */
    archived?: boolean;
  }>;
  /**
   * Open Dependabot pull requests per repository, or null where the search
   * could not be made.
   *
   * Only used to say how many a close would actually affect. Null keeps the
   * confirmation honest: "close every open pull request on 5 repositories" is
   * true whatever the count, where a fabricated number is not.
   */
  prCounts: Record<string, number> | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rollout, setRollout] = useState<RolloutSummary | null>(null);
  const [rollingOut, setRollingOut] = useState<"pr" | "commit" | null>(null);
  const [closeResult, setCloseResult] = useState<CloseSummary | null>(null);
  const [closing, setClosing] = useState(false);
  /**
   * The confirmation, in the page rather than in a native dialog.
   *
   * This was `window.prompt`, which Electron does not implement: `alert` and
   * `confirm` open, `prompt` does not, so the guard returned null and the
   * whole feature silently did nothing. No dialog, no request, no error. It
   * was the only `window.prompt` in the codebase, which is why this was the
   * only button that appeared dead.
   *
   * Typing is still required, because every other control on this panel is
   * undone by pressing its opposite and this one is not.
   */
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<BulkAction | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  /**
   * A ref, not state, because the loop reads it between batches.
   *
   * State read inside a running async function is the value it closed over when
   * it started, which would be `false` for the whole run however many times the
   * button was pressed.
   */
  const cancelRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);

  /** One row per repository, from the many alert rows each one produces. */
  const repos = useMemo<RepoRow[]>(() => {
    const worstRank: Record<string, number> = { critical: 4, high: 3, medium: 3, moderate: 2, low: 1 };
    const byRepo = new Map<string, RepoRow>();
    for (const r of rows) {
      const row = byRepo.get(r.repo)
        ?? { repo: r.repo, off: false, clean: false, findings: 0, archived: false };
      if (r.archived) row.archived = true;
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

  /**
   * Run something over the selection, a batch at a time, reporting as it goes.
   *
   * The progress it shows is real: the bar advances when a batch actually comes
   * back, and each repository's row appears with it. Nothing is on a timer, so a
   * run stuck on the nineteenth repository looks stuck rather than looking like
   * one that is nearly done.
   *
   * A batch that fails outright is recorded per repository rather than thrown.
   * Stopping there would leave the run having changed some repositories and
   * reported none of them, and the rest of the selection silently untouched.
   */
  async function runBatched<S>(
    title: string,
    intent: Intent,
    repos: string[],
    call: (batch: string[]) => Promise<S>,
    toLines: (batch: string[], summary: S) => ProgressLine[],
    cancel?: { label: string; note?: string },
  ): Promise<{ parts: S[]; lines: ProgressLine[]; stopped: boolean }> {
    const parts: S[] = [];
    const lines: ProgressLine[] = [];
    let stopped = false;
    setProgress({
      title, done: 0, total: repos.length, lines: [], running: true, intent,
      cancel: cancel ?? null,
    });

    for (let i = 0; i < repos.length; i += CHUNK) {
      // Checked between batches rather than mid-batch. A batch already sent is
      // going to be carried out whatever this screen does, and pretending
      // otherwise would leave the undo working from a list that is wrong.
      if (cancelRef.current) { stopped = true; break; }

      const batch = repos.slice(i, i + CHUNK);
      try {
        const summary = await call(batch);
        parts.push(summary);
        lines.push(...toLines(batch, summary));
      } catch (e: any) {
        const note = e?.message ?? "The request failed";
        lines.push(...batch.map(repo => ({ repo, ok: false, note })));
      }
      const done = Math.min(i + CHUNK, repos.length);
      setProgress(p => (p ? { ...p, done, lines: [...lines] } : p));
    }

    setProgress(p => (p ? { ...p, running: false } : p));
    return { parts, lines, stopped };
  }

  /** Only the ones that failed stay ticked, so pressing again retries those. */
  const keepFailures = (lines: ProgressLine[]) =>
    setSelected(new Set(lines.filter(l => !l.ok).map(l => l.repo)));

  /**
   * Switch on grouped security updates by writing the configuration file.
   *
   * Separated from the settings actions above because it is a different kind
   * of thing: those flip a switch, this writes to the repository. The
   * confirmation says which repositories and how the file lands, because a
   * mistake here is a commit somebody has to revert across an organization.
   */
  const startRollout = async (mode: "pr" | "commit") => {
    setError(""); setRollout(null); setRollingOut(mode);

    cancelRef.current = false; setCancelling(false);

    const { parts, lines, stopped } = await runBatched<RolloutSummary>(
      mode === "pr" ? "Open config pull requests" : "Commit config to default branch",
      mode === "commit" ? "warn" : "info",
      [...selected],
      batch => rolloutDependabotConfig(batch, mode),
      // The outcome is the interesting part here: "already configured" and
      // "no ecosystem" are not failures, and counting them as such would make
      // a clean run look half broken.
      (_batch, s) => s.results.map(r => ({
        repo: r.repo,
        ok: r.outcome !== "failed",
        note: r.detail ?? r.outcome.replace(/-/g, " "),
      })),
      // Stop only. This writes to the repository, and neither half can be taken
      // back from here: a pull request would have to be closed and a commit
      // reverted, one repository at a time.
      { label: "Stop", note: mode === "pr"
        ? "Stopping leaves the pull requests already opened; close them on GitHub."
        : "Stopping leaves the commits already made; they have to be reverted." },
    );

    const merged: RolloutSummary = {
      results: parts.flatMap(p => p.results),
      opened: parts.reduce((n, p) => n + p.opened, 0),
      committed: parts.reduce((n, p) => n + p.committed, 0),
      skipped: parts.reduce((n, p) => n + p.skipped, 0),
      failed: lines.filter(l => !l.ok).length,
    };

    setRollout(merged);
    setRollingOut(null);
    setCancelling(false);
    setProgress(p => (p ? {
      ...p,
      footer: `${stopped ? "Stopped. " : ""}`
        + `${merged.opened + merged.committed} written, ${merged.skipped} skipped, `
        + `${merged.failed} failed`,
    } : p));
  };

  /**
   * Close every open Dependabot pull request on the selected repositories.
   *
   * The confirmation carries the consequence rather than the count alone,
   * because the count is the part that looks harmless. GitHub treats a manual
   * close as `@dependabot close` and will not raise that pull request again,
   * so this suppresses fixes rather than deferring them, and undoing it is one
   * comment per pull request.
   *
   * Typed confirmation rather than a click. Every other control here is
   * recoverable by pressing the opposite one; this one is not, and a dialog
   * somebody can dismiss by reflex is not a guard against that.
   */
  /**
   * How many pull requests a close would actually affect.
   *
   * Null when the pull request search could not be made, and the button says
   * so rather than showing a zero: "Close 0 PRs" on a selection that has some
   * is the worst of the three possible labels.
   */
  const closeCount = prCounts === null
    ? null
    : [...selected].reduce((n, r) => n + (prCounts[r] ?? 0), 0);

  const startClose = async () => {
    setError(""); setCloseResult(null); setClosing(true);

    cancelRef.current = false; setCancelling(false);

    const { parts, stopped } = await runBatched<CloseSummary>(
      "Close Dependabot pull requests", "danger",
      [...selected],
      batch => closeDependabotPrs(batch),
      // Reported against the repositories that were asked for, not only the
      // ones that had something: a repository with nothing open is a real
      // answer and leaving it out would make the list look short.
      (batch, s) => batch.map(repo => {
        const failed = s.failures.filter(f => f.repo === repo);
        const closed = s.byRepo[repo] ?? 0;
        return {
          repo,
          ok: failed.length === 0,
          note: failed.length > 0 ? failed[0].error
            : closed === 0 ? "none open" : `${closed} closed`,
        };
      }),
      // Stop only, and this is the one where it matters most. GitHub treats a
      // manual close as `@dependabot close` and will not raise that pull
      // request again, so the ones already closed cannot be undone from here.
      { label: "Stop",
        note: "Stopping leaves the ones already closed; Dependabot will not raise those again." },
    );

    const merged: CloseSummary = {
      closed: parts.reduce((n, p) => n + p.closed, 0),
      byRepo: Object.assign({}, ...parts.map(p => p.byRepo)),
      failed: parts.reduce((n, p) => n + p.failed, 0),
      failures: parts.flatMap(p => p.failures),
      sleptSeconds: parts.reduce((n, p) => n + p.sleptSeconds, 0),
    };

    setCloseResult(merged);
    setArmed(false);
    setTyped("");
    setClosing(false);
    setCancelling(false);
    setProgress(p => (p ? {
      ...p,
      footer: `${stopped ? "Stopped. " : ""}${merged.closed} closed, ${merged.failed} could not be`,
    } : p));
    onDone();
    qc.invalidateQueries({ queryKey: ["dependencies", "fix-prs"] });
  };

  /** One batch of switch flips, described the same way wherever it is run. */
  const switchLines = (_batch: string[], s: BulkSummary): ProgressLine[] =>
    s.results.map(r => ({
      repo: r.repo,
      ok: r.ok,
      note: (r as any).leftOff ? "left switched off" : r.error,
    }));

  const start = async (action: BulkAction) => {
    setError(""); setSummary(null); setRunning(action);
    cancelRef.current = false; setCancelling(false);

    const label = ACTIONS.find(a => a.id === action)?.label
      ?? (action === "retrigger" ? "Re-trigger fixes" : "Working");
    const undo = UNDO[action];

    const { parts, lines, stopped } = await runBatched<BulkSummary>(
      label, action === "alerts-off" || action === "fixes-off" ? "warn" : "info",
      [...selected],
      batch => bulkDependabot(batch, action),
      // Reported per repository from the batch's own answer, so a repository
      // the server declined is named rather than counted.
      switchLines,
      undo && {
        label: undo.label,
        note: action === "retrigger"
          ? "Stopping puts fixes back on everywhere it reached."
          : "Stopping undoes what it has already changed.",
      },
    );

    /**
     * Stopped, so put back exactly what was changed.
     *
     * The list is the repositories that actually succeeded, not the selection:
     * one that failed was never changed and switching it the other way would be
     * a change nobody asked for.
     */
    if (stopped) {
      const changed = lines.filter(l => l.ok).map(l => l.repo);
      if (undo && changed.length > 0) {
        // Cleared before the undo runs. The flag is still set from the press
        // that stopped the first run, and the undo checks the same flag, so
        // without this it would break on its first batch and put nothing back,
        // having just told somebody it would.
        cancelRef.current = false;
        const back = await runBatched<BulkSummary>(
          undo.title, "warn", changed,
          batch => bulkDependabot(batch, undo.action),
          switchLines,
        );
        const restored = back.lines.filter(l => l.ok).length;
        setProgress(p => (p ? {
          ...p,
          footer: restored === changed.length
            ? `Stopped. All ${plural(changed.length)} put back.`
            : `Stopped. ${restored} of ${changed.length} put back; the rest are named above.`,
        } : p));
      } else {
        setProgress(p => (p ? { ...p, footer: "Stopped. Nothing had been changed yet." } : p));
      }
      setRunning(null); setCancelling(false);
      qc.invalidateQueries({ queryKey: ["dependencies"] });
      onDone();
      return;
    }

    const merged: BulkSummary = {
      results: parts.flatMap(p => p.results),
      changed: parts.reduce((n, p) => n + p.changed, 0),
      failed: lines.filter(l => !l.ok).length,
      sleptSeconds: parts.reduce((n, p) => n + p.sleptSeconds, 0),
      leftOff: parts.reduce((n, p) => n + p.leftOff, 0),
      leftOffRepos: parts.flatMap(p => p.leftOffRepos ?? []),
    };

    setSummary(merged);
    setRunning(null);
    keepFailures(lines);
    setProgress(p => (p ? {
      ...p,
      footer: `${merged.changed} changed, ${merged.failed} failed`
        + (merged.sleptSeconds > 0 ? `, ${merged.sleptSeconds}s waiting on GitHub` : ""),
    } : p));
    qc.invalidateQueries({ queryKey: ["dependencies"] });
    onDone();
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
                ? "bg-slate-900 dark:bg-white text-reverse dark:text-slate-900"
                : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-ink/[0.06]"}`}>
            {label}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Filter by name" className={`${SURFACE.input} max-w-[220px] ml-auto`} />
      </div>

      <div className="pb-2 flex items-center gap-2 flex-wrap border-b border-slate-200/70 dark:border-ink/[0.07]">
        <label className="inline-flex items-center gap-2 text-[12.5px] font-semibold
                          text-slate-600 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown}
            className="w-4 h-4 rounded border-slate-300 dark:border-rule" />
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

      <div className="max-h-[380px] overflow-y-auto divide-y divide-slate-100 dark:divide-ink/[0.06]">
        {shown.length === 0 ? (
          <p className="py-6 text-[12.5px] text-slate-400 dark:text-slate-500">
            Nothing matches.
          </p>
        ) : shown.map(r => (
          <label key={r.repo}
            className="flex items-center gap-3 px-2 -mx-2 rounded-lg py-2.5 cursor-pointer
                       hover:bg-slate-50 dark:hover:bg-ink/[0.03] transition-colors">
            <input type="checkbox" checked={selected.has(r.repo)} onChange={() => toggle(r.repo)}
              className="w-4 h-4 rounded border-slate-300 dark:border-rule shrink-0" />
            <span className="text-[13px] font-medium text-slate-800 dark:text-slate-200 truncate flex-1">
              {r.repo}
            </span>
            {/* Said before the button is pressed, not after it fails. GitHub
                refuses every settings change on an archived repository however
                much access somebody has, and the refusal used to read as a
                permission problem, which sent people looking for one. */}
            {r.archived && (
              <span title="GitHub refuses settings changes on an archived repository. Unarchive it to change this."
                className="text-[10.5px] font-bold px-1.5 py-0.5 rounded shrink-0
                           bg-slate-200/70 dark:bg-ink/[0.08] text-slate-500 dark:text-slate-400">
                archived
              </span>
            )}
            {r.off ? (
              <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded shrink-0
                               bg-slate-200/70 dark:bg-ink/[0.08] text-slate-500 dark:text-slate-400">
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

      <div className="pt-4 mt-1 grid gap-2.5 border-t border-slate-200/70 dark:border-ink/[0.07]">
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map(a => (
            <Button key={a.id}
              variant={a.id === "fixes-on" ? "primary"
                : a.danger ? "caution" : undefined}
              disabled={selected.size === 0 || !!running}
              onClick={() => {
                if (!a.danger) { void start(a.id); return; }
                setConfirming({
                  title: a.label,
                  label: a.label,
                  intent: "warn",
                  body: <p>{a.hint} This applies to {plural(selected.size)}.</p>,
                  go: () => void start(a.id),
                });
              }}>
              {running === a.id ? "Working…" : a.label}
            </Button>
          ))}
        </div>

        {/* The second kind of action, kept visually apart from the switches
            above, because this one writes a file into the repository and that
            is not something to press by accident. */}
        <div className="mt-1 pt-3.5 border-t border-slate-100 dark:border-ink/[0.06]">
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
              onClick={() => setConfirming({
                title: "Re-trigger fixes",
                label: "Re-trigger",
                intent: "warn",
                body: (
                  <>
                    <p>
                      Security updates go off and straight back on for {plural(selected.size)}, which
                      asks GitHub to look at the backlog again. Nothing is written and no approval
                      is needed.
                    </p>
                    <p className="mt-2">
                      They are briefly unprotected while this runs, and a repository that cannot be
                      switched back on is named rather than counted: it is then less protected than
                      before you pressed anything.
                    </p>
                  </>
                ),
                go: () => void start("retrigger"),
              })}>
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
              onClick={() => setConfirming({
                title: "Open config pull requests",
                label: "Open pull requests",
                intent: "info",
                body: (
                  <p>
                    Opens one pull request per repository adding
                    <span className="font-mono text-[12px]"> .github/dependabot.yml</span>, on
                    {" "}{plural(selected.size)}. Each still needs review and merge before any fix
                    arrives. Repositories that already have the file are left alone.
                  </p>
                ),
                go: () => void startRollout("pr"),
              })}>
              {rollingOut === "pr" ? "Opening…" : "Open config PRs"}
            </Button>
            <Button variant="caution"
              disabled={selected.size === 0 || !!rollingOut || !!running}
              onClick={() => setConfirming({
                title: "Commit to the default branch",
                label: "Commit",
                intent: "warn",
                body: (
                  <>
                    <p>
                      Commits <span className="font-mono text-[12px]">.github/dependabot.yml</span>
                      {" "}straight to the default branch of {plural(selected.size)}.
                    </p>
                    <p className="mt-2">
                      There is no review step. Undoing it is a revert per repository, and any branch
                      that is protected against direct pushes will refuse it.
                    </p>
                  </>
                ),
                go: () => void startRollout("commit"),
              })}>
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

        {/* Apart from everything above, and last.

            Every other control here is recoverable by pressing the opposite
            one. This is not: GitHub treats closing a Dependabot pull request as
            telling it not to raise that one again, so the undo is a comment on
            each closed pull request rather than a button on this panel. It gets
            its own rule, its own colour, and a typed confirmation. */}
        <div className="mt-2 pt-3.5 border-t border-rose-200/70 dark:border-rose-500/20">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-rose-800 dark:text-rose-300">
                Close open Dependabot pull requests
              </p>
              <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-[70ch] mt-1">
                Closes every open Dependabot pull request on the selected repositories.
                GitHub reads a close as <span className="font-mono text-[11px]">@dependabot close</span>,
                so it stops raising those fixes again until the dependency moves on.
                Reopening is one comment per pull request, so this is not a way to
                clear the list for now.
              </p>
            </div>
            <Button variant="caution"
              disabled={selected.size === 0 || closing || !!running || !!rollingOut || armed}
              onClick={() => { setArmed(true); setTyped(""); setError(""); }}>
              {closing
                ? "Closing…"
                : closeCount === null
                  ? "Close all their PRs"
                  : `Close ${closeCount} PR${closeCount === 1 ? "" : "s"}`}
            </Button>
          </div>

          {/* The guard, in the page. Electron does not implement window.prompt,
              so the native version of this silently did nothing at all. */}
          {armed && (
            <div className="mt-2.5 rounded-xl border border-rose-300 dark:border-rose-500/40
                            bg-rose-50/70 dark:bg-rose-950/20 p-3.5">
              <p className="text-[12.5px] font-bold text-rose-900 dark:text-rose-200">
                {closeCount === null
                  ? `Close every open Dependabot pull request on ${selected.size} `
                    + `repositor${selected.size === 1 ? "y" : "ies"}?`
                  : `Close ${closeCount} open Dependabot pull request${closeCount === 1 ? "" : "s"} `
                    + `across ${selected.size} repositor${selected.size === 1 ? "y" : "ies"}?`}
              </p>
              <p className="text-[11.5px] text-rose-800/80 dark:text-rose-300/70 leading-relaxed mt-1">
                GitHub reads a close as telling Dependabot not to raise that pull request again,
                so these fixes stop coming back on their own. Reopening is one comment per pull
                request.
              </p>
              <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                <input
                  value={typed} onChange={e => setTyped(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && typed === "CLOSE") startClose(); }}
                  placeholder="Type CLOSE"
                  autoFocus
                  className="w-36 px-2.5 py-1.5 text-[12.5px] rounded-lg bg-white dark:bg-ink/[0.06]
                             border border-rose-300 dark:border-rose-500/40
                             text-slate-800 dark:text-slate-100 placeholder:text-slate-400
                             focus:outline-none focus:ring-2 focus:ring-rose-500/30" />
                <Button variant="caution" disabled={typed !== "CLOSE" || closing}
                  onClick={startClose}>
                  {closing ? "Closing…" : "Close them"}
                </Button>
                <button onClick={() => { setArmed(false); setTyped(""); }}
                  className="text-[12px] text-slate-500 dark:text-slate-400 px-2">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {closing && (
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-2">
              One at a time with a pause between, so GitHub does not refuse the burst.
            </p>
          )}

          {closeResult && (
            <div className="mt-2">
              <Note intent={closeResult.failed ? "warn" : "good"}>
                {closeResult.closed} closed
                {closeResult.failed > 0 && <>, {closeResult.failed} could not be</>}.
                {closeResult.sleptSeconds > 0 && (
                  <> GitHub asked us to pause for about {closeResult.sleptSeconds}s along the way.</>
                )}
                {closeResult.failed > 0 && (
                  <ul className="mt-1.5 grid gap-0.5">
                    {closeResult.failures.slice(0, 8).map(f => (
                      <li key={`${f.repo}#${f.number}`} className="text-[11.5px]">
                        <span className="font-mono">{f.repo}#{f.number}</span>: {f.error}
                      </li>
                    ))}
                  </ul>
                )}
                {closeResult.closed > 0 && (
                  <p className="text-[11.5px] mt-1.5">
                    To bring any of them back, comment{" "}
                    <span className="font-mono">@dependabot reopen</span> on it.
                  </p>
                )}
              </Note>
            </div>
          )}
        </div>

        <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
          Runs with your own GitHub account, so it can only change repositories
          you administer.
        </p>
      </div>
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming?.title ?? ""}
        body={confirming?.body ?? null}
        confirmLabel={confirming?.label ?? "Confirm"}
        intent={confirming?.intent ?? "info"}
        onConfirm={() => { const c = confirming; setConfirming(null); c?.go(); }}
      />

      {/* Opened by the run itself rather than by a button, so it covers every
          one of these actions without each having to remember to show it. */}
      <ProgressDialog
        open={progress !== null}
        onClose={() => setProgress(null)}
        title={progress?.title ?? ""}
        done={progress?.done ?? 0}
        total={progress?.total ?? 0}
        lines={progress?.lines ?? []}
        running={progress?.running ?? false}
        footer={progress?.footer}
        intent={progress?.intent ?? "info"}
        cancel={progress?.cancel ? {
          label: progress.cancel.label,
          note: progress.cancel.note,
          pending: cancelling,
          run: () => { cancelRef.current = true; setCancelling(true); },
        } : undefined}
      />

    </div>
  );
}
