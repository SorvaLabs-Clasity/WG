import { useRef, useState } from "react";
import { ProgressDialog, type ProgressLine, type Intent } from "../design";

/** How many repositories per request, so the bar moves as GitHub answers. */
const CHUNK = 4;

interface Progress {
  title: string;
  done: number;
  total: number;
  lines: ProgressLine[];
  running: boolean;
  intent: Intent;
  footer?: string;
  canStop: boolean;
}

/**
 * Work over many repositories, a few at a time, in the progress window every
 * bulk action on the Vulnerabilities tab uses — the same bar, the same
 * per-repository lines, the same Stop.
 *
 * The Dependabot manager has its own copy of this loop, tied to its state;
 * this is the reusable one, for anything else that needs it.
 */
export function useBatchedProgress() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);

  async function run<R extends { repo: string; ok: boolean; error?: string }>(
    title: string,
    repos: string[],
    call: (slice: string[]) => Promise<R[]>,
    opts: { intent?: Intent; canStop?: boolean; footer?: (lines: ProgressLine[], stopped: boolean) => string } = {},
  ): Promise<{ lines: ProgressLine[]; stopped: boolean }> {
    stopRef.current = false; setStopping(false);
    const lines: ProgressLine[] = [];
    let stopped = false;
    setProgress({ title, done: 0, total: repos.length, lines: [], running: true,
      intent: opts.intent ?? "info", canStop: opts.canStop ?? true });

    for (let i = 0; i < repos.length; i += CHUNK) {
      // Between slices, not mid-slice: a slice already sent will be carried out.
      if (stopRef.current) { stopped = true; break; }
      const slice = repos.slice(i, i + CHUNK);
      try {
        const results = await call(slice);
        const seen = new Set(results.map(r => r.repo));
        lines.push(...results.map(r => ({ repo: r.repo, ok: r.ok, note: r.error })));
        // A repository the server did not mention is reported, not dropped.
        lines.push(...slice.filter(r => !seen.has(r)).map(repo => ({ repo, ok: true })));
      } catch (e: any) {
        const note = e?.message ?? "The request failed";
        lines.push(...slice.map(repo => ({ repo, ok: false, note })));
      }
      setProgress(p => (p ? { ...p, done: Math.min(i + CHUNK, repos.length), lines: [...lines] } : p));
    }

    const failed = lines.filter(l => !l.ok).length;
    const footer = opts.footer?.(lines, stopped)
      ?? `${stopped ? "Stopped. " : ""}${lines.length - failed} done${failed ? `, ${failed} could not be` : ""}.`;
    setProgress(p => (p ? { ...p, running: false, footer } : p));
    setStopping(false);
    return { lines, stopped };
  }

  const dialog = (
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
      cancel={progress?.canStop && progress.running ? {
        label: "Stop",
        note: "Stops after the repositories already sent. What is done stays done.",
        pending: stopping,
        run: () => { stopRef.current = true; setStopping(true); },
      } : undefined}
    />
  );

  return { run, dialog, busy: !!progress?.running };
}
