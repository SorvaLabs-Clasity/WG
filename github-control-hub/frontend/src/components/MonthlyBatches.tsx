import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Note, ConfirmDialog, Drawer, Empty, Pill, SearchInput, SURFACE, Spinner,
} from "../design";
import { usePermissionSet } from "../hooks/usePermissionSet";
import { useBatchedProgress } from "../hooks/useBatchedProgress";
import {
  fetchBatches, createBatch, updateBatch, deleteBatch, addToBatch, removeFromBatch, runBatchNow,
  type BatchesView, type MonthlyBatch, type BatchRun,
} from "../api/dependencies";

/**
 * Monthly fixes: Dependabot security fixes held back and released once a
 * month, in named batches.
 *
 * GitHub opens a fix pull request as soon as a vulnerability is found, and that
 * cannot be scheduled. So repositories in a batch have their fixes switched
 * off, and on the batch's day an hourly job in AWS switches them on for 24
 * hours — when the month's pull requests arrive — and then off again. Rules:
 * backend/src/services/dependabotMonthly.ts.
 *
 * Every action that touches repositories runs a few at a time in the progress
 * window the rest of the tab uses.
 */

export interface Candidate {
  repo: string;
  /** Whether fix pull requests are on; undefined when GitHub would not say. */
  fixesEnabled?: boolean;
  archived?: boolean;
}

const plural = (n: number, one = "repository", many = "repositories") => `${n} ${n === 1 ? one : many}`;

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function longDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

const KIND: Record<BatchRun["kind"], string> = {
  open: "Fixes switched on",
  close: "Fixes switched off",
  join: "Repositories added",
  leave: "Repositories taken out",
};

export default function MonthlyBatches({ candidates }: { candidates: Candidate[] }) {
  const qc = useQueryClient();
  const { can, holds } = usePermissionSet();
  const mayChange = can("deps.dependabot.bulk");
  const progress = useBatchedProgress();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "new" } | { mode: "edit"; batch: MonthlyBatch } | null>(null);
  const [name, setName] = useState("");
  const [day, setDay] = useState(1);
  const [picking, setPicking] = useState<MonthlyBatch | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "run" | "delete"; batch: MonthlyBatch } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ["dependabot", "batches"],
    queryFn: fetchBatches,
    enabled: holds("deps.dependabot.read"),
    staleTime: 30_000,
  });

  const refresh = (next?: BatchesView) => {
    if (next) qc.setQueryData(["dependabot", "batches"], { timeZone: next.timeZone, batches: next.batches });
    else qc.invalidateQueries({ queryKey: ["dependabot", "batches"] });
    qc.invalidateQueries({ queryKey: ["dependencies"] });
  };

  /** Runs a per-repository action through the progress window. */
  const runOver = async (title: string, repos: string[], call: (slice: string[]) => Promise<BatchesView>,
    intent: "info" | "warn" = "info") => {
    setError(null);
    let last: BatchesView | undefined;
    await progress.run(title, repos, async slice => {
      last = await call(slice);
      return last.results ?? [];
    }, { intent });
    refresh(last);
  };

  const saveForm = async () => {
    setError(null);
    try {
      const next = form?.mode === "edit"
        ? await updateBatch(form.batch.id, { name, dayOfMonth: day })
        : await createBatch(name, day);
      refresh(next);
      setForm(null);
    } catch (e: any) {
      setError(e?.message ?? "Could not save the batch");
    }
  };

  const openForm = (f: typeof form) => {
    setForm(f);
    setName(f?.mode === "edit" ? f.batch.name : "");
    setDay(f?.mode === "edit" ? f.batch.dayOfMonth : 1);
  };

  const remove = (b: MonthlyBatch, repos: string[]) =>
    runOver(`Taking ${plural(repos.length)} out of "${b.name}"`, repos, s => removeFromBatch(b.id, s), "warn");

  const doDelete = async (b: MonthlyBatch) => {
    if (b.repos.length > 0) await remove(b, b.repos);
    try {
      refresh(await deleteBatch(b.id));
    } catch (e: any) {
      // Something could not be switched back on: the batch stays, with those in it.
      setError(e?.message ?? "Could not delete the batch");
      refresh();
    }
  };

  // `can`, not `holds`: "yes" while the answer loads, so this does not flash.
  if (!can("deps.dependabot.read")) {
    return <Empty title="Not open to you" body="Seeing the monthly batches needs the permission to read Dependabot state." />;
  }
  if (isLoading || !data) {
    return loadError ? <Note intent="danger">{(loadError as Error).message}</Note> : <Spinner />;
  }

  const inBatch = new Map(data.batches.flatMap(b => b.repos.map(r => [r, b.name] as const)));
  const missedAll = data.batches.flatMap(b => b.missed.map(m => ({ ...m, batch: b.name })));

  return (
    <div className="space-y-5">
      <div className="max-w-[80ch] text-[0.8125rem] text-ink-2 leading-relaxed space-y-2">
        <p>
          GitHub opens a fix pull request as soon as a vulnerability is found, and that cannot be scheduled.
          Repositories in a batch have their fixes switched off instead, and on the batch's day they are
          switched on for 24 hours, which is when that month's pull requests arrive together. A new
          vulnerability can wait up to a month for its fix.
        </p>
        <p className="text-ink-3 text-[0.75rem]">
          Only repositories whose fix pull requests are on can join, and each can be in one batch. The monthly
          switch is made by the app's job in AWS as the GitHub App, which needs Administration: write. GitHub
          does not document that switching fixes on raises the pull requests, so try a batch of one with
          Run now first.
        </p>
      </div>

      {missedAll.length > 0 && (
        <Note intent="danger">
          {plural(missedAll.length)} did not get their fixes the last time their batch was released, and
          their security fixes are still off:
          <ul className="mt-1.5 space-y-0.5">
            {missedAll.slice(0, 8).map(m => (
              <li key={m.repo}><span className="font-mono">{m.repo}</span> ({m.batch}){m.error ? ` — ${m.error}` : ""}</li>
            ))}
          </ul>
        </Note>
      )}
      {error && <Note intent="danger">{error}</Note>}

      {mayChange && (
        <div><Button variant="primary" onClick={() => openForm({ mode: "new" })}>New batch</Button></div>
      )}

      {data.batches.length === 0 ? (
        <Empty title="No batches yet"
          body={mayChange
            ? "Create a batch, give it a release day, and add the repositories whose fixes should arrive once a month."
            : "Nobody has set one up yet. Every repository gets its security fixes as soon as they are found."} />
      ) : data.batches.map(b => {
        const open = expanded.has(b.id);
        const toggle = () => setExpanded(s => { const n = new Set(s); n.has(b.id) ? n.delete(b.id) : n.add(b.id); return n; });
        return (
          <section key={b.id} className={`${SURFACE.card} p-5`}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <h3 className="display text-[1.25rem] text-ink">{b.name}</h3>
                <p className="text-[0.8125rem] text-ink-2 mt-1">
                  Releases on the {ordinal(b.dayOfMonth)} of each month · {plural(b.repos.length)}
                </p>
                <div className="mt-2">
                  {b.open && b.openUntil
                    ? <Pill intent="good">Fixes on until {when(b.openUntil)}</Pill>
                    : b.repos.length > 0
                      ? <Pill intent="info">Held back · next release {longDate(b.nextRelease)}</Pill>
                      : <Pill intent="neutral">Empty</Pill>}
                </div>
              </div>
              {mayChange && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setPicking(b)} disabled={progress.busy}>Add repositories</Button>
                  <Button onClick={() => setConfirm({ kind: "run", batch: b })}
                    disabled={progress.busy || b.repos.length === 0 || b.open}>
                    Run now
                  </Button>
                  <Button variant="ghost" onClick={() => openForm({ mode: "edit", batch: b })}>Edit</Button>
                  <Button variant="ghost" onClick={() => setConfirm({ kind: "delete", batch: b })} disabled={progress.busy}>
                    Delete
                  </Button>
                </div>
              )}
            </div>

            {b.missed.length > 0 && (
              <div className="mt-3"><Note intent="danger">
                Last release could not switch on {plural(b.missed.length)}: {b.missed.slice(0, 3).map(m => m.repo).join(", ")}
                {b.missed[0]?.error ? ` — ${b.missed[0].error}` : ""}
              </Note></div>
            )}

            {b.repos.length > 0 && (
              <ul className="mt-4 border-t border-rule divide-y divide-rule">
                {b.repos.map(repo => (
                  <li key={repo} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-mono text-[0.8125rem] text-ink truncate">{repo}</span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="caps text-ink-3">{b.open ? "fixes on" : "held back"}</span>
                      {mayChange && (
                        <button className="textlink caps" disabled={progress.busy}
                          onClick={() => remove(b, [repo])}>Take out</button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {b.history.length > 0 && (
              <div className="mt-3">
                <button className="textlink caps" onClick={toggle}>{open ? "Hide" : "Show"} recent runs</button>
                {open && (
                  <ul className="mt-2 space-y-1 text-[0.75rem] text-ink-2">
                    {b.history.slice(0, 10).map(h => {
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
              </div>
            )}
          </section>
        );
      })}

      <RepoPicker
        batch={picking}
        candidates={candidates}
        inBatch={inBatch}
        onClose={() => setPicking(null)}
        onAdd={async repos => {
          const b = picking!;
          setPicking(null);
          await runOver(`Adding ${plural(repos.length)} to "${b.name}"`, repos, s => addToBatch(b.id, s));
        }}
      />

      <ConfirmDialog
        open={form !== null}
        onClose={() => setForm(null)}
        onConfirm={saveForm}
        title={form?.mode === "edit" ? `Edit "${form.batch.name}"` : "New batch"}
        confirmLabel={form?.mode === "edit" ? "Save" : "Create batch"}
        body={
          <div className="space-y-3">
            <label className="block">
              <span className="caps">Name</span>
              <input className="field-line w-full mt-1" value={name} maxLength={60} autoFocus
                placeholder="e.g. Billing services" onChange={e => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="caps">Release day</span>
              <select className="field-line w-full mt-1" value={day} onChange={e => setDay(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                  <option key={d} value={d}>The {ordinal(d)} of each month</option>
                ))}
              </select>
              <span className="text-[0.75rem] text-ink-3">Up to the 28th, so every month has one. New York time.</span>
            </label>
          </div>
        }
      />

      <ConfirmDialog
        open={confirm?.kind === "run"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const b = confirm!.batch; setConfirm(null);
          void runOver(`Releasing "${b.name}" now`, b.repos, s => runBatchNow(b.id, s));
        }}
        title={confirm ? `Release "${confirm.batch.name}" now` : ""}
        confirmLabel="Switch fixes on"
        intent="warn"
        body={confirm && <p>
          Security fixes go on for {plural(confirm.batch.repos.length)} now, and the monthly job switches them
          off again after 24 hours. GitHub should open the fix pull requests during that time. This does not
          use up the batch's own release on the {ordinal(confirm.batch.dayOfMonth)}.
        </p>}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onClose={() => setConfirm(null)}
        onConfirm={() => { const b = confirm!.batch; setConfirm(null); void doDelete(b); }}
        title={confirm ? `Delete "${confirm.batch.name}"` : ""}
        confirmLabel="Delete batch"
        intent="danger"
        body={confirm && <p>
          {confirm.batch.repos.length > 0
            ? <>Its {plural(confirm.batch.repos.length)} are taken out first, which switches their security fixes
              back on, so GitHub opens fix pull requests for them as soon as vulnerabilities are found. </>
            : null}
          The batch and its history are then removed.
        </p>}
      />

      {progress.dialog}
    </div>
  );
}

/**
 * Choosing repositories for a batch. Only those whose fix pull requests are on
 * can be chosen; the rest say why not, rather than failing after the press.
 */
function RepoPicker({ batch, candidates, inBatch, onClose, onAdd }: {
  batch: MonthlyBatch | null;
  candidates: Candidate[];
  inBatch: Map<string, string>;
  onClose: () => void;
  onAdd: (repos: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const rows = useMemo(() => candidates
    .filter(c => !query || c.repo.toLowerCase().includes(query.toLowerCase()))
    .map(c => {
      const other = inBatch.get(c.repo);
      const reason = other ? (other === batch?.name ? "Already in this batch" : `In "${other}"`)
        : c.archived ? "Archived"
        : c.fixesEnabled === false ? "Fix pull requests are off — turn them on in Manage first"
        : c.fixesEnabled === undefined ? "Fix pull request status unknown — you may not administer it"
        : null;
      return { ...c, reason };
    })
    .sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || a.repo.localeCompare(b.repo)),
  [candidates, query, inBatch, batch]);

  const choosable = rows.filter(r => !r.reason);
  const close = () => { setChosen(new Set()); setQuery(""); onClose(); };

  return (
    <Drawer
      open={batch !== null}
      onClose={close}
      title={batch ? `Add repositories to "${batch.name}"` : ""}
      subtitle="Adding one switches its security fixes off until the batch's release day."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[0.8125rem] text-ink-2">{plural(chosen.size)} chosen</span>
          <Button variant="primary" disabled={chosen.size === 0}
            onClick={() => { const list = [...chosen]; setChosen(new Set()); setQuery(""); onAdd(list); }}>
            Add {chosen.size > 0 ? plural(chosen.size) : ""}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Filter by name" />
        <label className="flex items-center gap-2 text-[0.8125rem]">
          <input type="checkbox"
            checked={choosable.length > 0 && choosable.every(r => chosen.has(r.repo))}
            onChange={e => setChosen(e.target.checked ? new Set(choosable.map(r => r.repo)) : new Set())} />
          Select every repository that can be added ({choosable.length})
        </label>
        {rows.length === 0 ? (
          <p className="text-[0.8125rem] text-ink-3">No repositories match.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {rows.map(r => (
              <li key={r.repo}>
                <label className={`flex items-center gap-3 py-2 ${r.reason ? "opacity-55" : "cursor-pointer"}`}>
                  <input type="checkbox" disabled={!!r.reason} checked={chosen.has(r.repo)}
                    onChange={e => setChosen(s => { const n = new Set(s); e.target.checked ? n.add(r.repo) : n.delete(r.repo); return n; })} />
                  <span className="font-mono text-[0.8125rem] text-ink truncate">{r.repo}</span>
                  {r.reason && <span className="ml-auto text-[0.75rem] text-ink-3 text-right">{r.reason}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
