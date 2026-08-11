import { useState, useMemo, useEffect, useRef } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { usePermissions } from "../hooks/usePermissions";
import {
  useCatalog, useGuardrails, useFindings, useAwsExclusions,
  useCreateGuardrail, useUpdateGuardrail, useDeleteGuardrail, useRunGuardrails,
  useSaveAwsExclusion, useDeleteAwsExclusion,
} from "../hooks/useAws";
import type { Guardrail, CatalogEntry, Finding, AwsExclusionList, ParamSpec } from "../api/aws";

/**
 * AWS guardrails.
 *
 * Built to the design context in /.impeccable.md: posture is the loudest thing
 * on the page, colour only ever carries meaning, depth shows structure, and
 * motion confirms rather than entertains.
 *
 * The page's dominant surface is a status slab whose colour follows compliance
 * state — deep red while checks are failing, green once they are not. That is
 * the one thing meant to be memorable, and it is functional: you can read the
 * account's state before reading a single word.
 */

const relTime = (iso?: string) => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "moments ago";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/** Counts up to `value`. Confirms a number arrived; never loops. */
function useCountUp(value: number, ms = 650) {
  const [n, setN] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current, b = value;
    if (a === b) return;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min((t - start) / ms, 1);
      // ease-out-quart: fast arrival, gentle settle
      setN(Math.round(a + (b - a) * (1 - Math.pow(1 - p, 4))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return n;
}

type RuleRow = {
  rule: Guardrail; entry?: CatalogEntry; findings: Finding[];
  failing: number; checked: number; excluded: number;
};

export default function AwsPage() {
  const { user } = useAuth();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const adminTeam = permissions?.awsAdminTeam ?? "aws-guardrail-admins";

  const { data: catalog } = useCatalog();
  const { data: rules, isLoading } = useGuardrails();
  const { data: findings } = useFindings();
  const { data: exclusions } = useAwsExclusions();

  const runRules = useRunGuardrails();
  const [view, setView] = useState<{ k: "list" } | { k: "rule"; id: string } | { k: "new" } | { k: "excl" }>({ k: "list" });
  const [search, setSearch] = useState("");
  const [only, setOnly] = useState<"all" | "failing" | "passing">("all");
  const [error, setError] = useState<string | null>(null);

  const rows: RuleRow[] = useMemo(() => {
    const by = new Map<string, Finding[]>();
    (findings ?? []).forEach(f => by.set(f.ruleId, [...(by.get(f.ruleId) ?? []), f]));
    return (rules ?? []).map(rule => {
      const f = by.get(rule.id) ?? [];
      return {
        rule, entry: (catalog ?? []).find(c => c.kind === rule.kind), findings: f,
        failing: f.filter(x => x.verdict === "violation" && !x.excluded).length,
        checked: f.filter(x => !x.excluded).length,
        excluded: f.filter(x => x.excluded).length,
      };
    }).sort((a, b) => b.failing - a.failing || a.rule.name.localeCompare(b.rule.name));
  }, [rules, findings, catalog]);

  const t = useMemo(() => {
    const f = findings ?? [];
    const passing = f.filter(x => x.verdict === "compliant").length;
    const failing = f.filter(x => x.verdict === "violation" && !x.excluded).length;
    const excluded = f.filter(x => x.excluded).length;
    const total = passing + failing;
    return {
      passing, failing, excluded, total,
      pct: total ? Math.round((passing / total) * 100) : 100,
      rulesFailing: rows.filter(r => r.failing > 0).length,
      fixable: rows.filter(r => r.failing > 0 && r.entry?.canRemediate && r.rule.mode === "report")
        .reduce((n, r) => n + r.failing, 0),
      lastRun: f.reduce<string | undefined>((a, x) => (!a || x.checkedAt > a ? x.checkedAt : a), undefined),
    };
  }, [findings, rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (only === "failing" && r.failing === 0) return false;
      if (only === "passing" && (r.failing > 0 || r.checked === 0)) return false;
      if (!q) return true;
      return r.rule.name.toLowerCase().includes(q)
        || (r.entry?.summary ?? "").toLowerCase().includes(q)
        || r.findings.some(f => f.resourceId.toLowerCase().includes(q));
    });
  }, [rows, search, only]);

  const run = async (ids?: string[]) => {
    setError(null);
    try { await runRules.mutateAsync({ ruleIds: ids }); }
    catch (e) { setError((e as Error).message); }
  };

  const active = view.k === "rule" ? rows.find(r => r.rule.id === view.id) : undefined;
  const clean = t.failing === 0 && t.total > 0;
  // Hoisted: a hook must not sit inside JSX, even where the branch always renders.
  const pctShown = useCountUp(t.pct);

  return (
    <div className="min-h-screen pt-14 bg-slate-50 dark:bg-slate-950">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-[1400px] mx-auto px-6 py-6">

        {/* ── Status slab: the page's dominant surface, coloured by posture ── */}
        <section
          className={`relative overflow-hidden rounded-3xl px-8 py-8 sm:px-10 sm:py-9 mb-6 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.35)] transition-colors duration-700 ${
            t.total === 0 ? "bg-slate-800"
              : clean ? "bg-[#0b6b3a]"
                : "bg-[#8d1d2c]"}`}
          style={{ animation: "fadeInUp 0.5s cubic-bezier(0.16,1,0.3,1) both" }}
        >
          {/* Angled wash for depth. Flat colour, no gradient text. */}
          <div className="pointer-events-none absolute inset-0 opacity-[0.22]"
            style={{ background: "linear-gradient(115deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 45%)" }} />
          <div className="pointer-events-none absolute -right-24 -top-24 w-72 h-72 rounded-full bg-white/10" />

          <div className="relative flex flex-wrap items-start justify-between gap-8">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] font-bold text-white/60 mb-3">
                {t.total === 0 ? "Not yet swept" : clean ? "All clear" : "Action required"}
              </p>
              <div className="flex items-end gap-10 sm:gap-14">
                <Metric value={t.failing} label="failing" emphasis />
                <Metric value={t.passing} label="passing" />
                <Metric value={t.excluded} label="excluded" />
              </div>
              <p className="text-sm text-white/70 mt-5">
                {t.rulesFailing > 0
                  ? <>{t.rulesFailing} of {rows.length} rules have findings · swept {relTime(t.lastRun)}</>
                  : <>{rows.filter(r => r.rule.enabled).length} rules active · swept {relTime(t.lastRun)}</>}
              </p>
            </div>

            <div className="flex flex-col items-end gap-4">
              <div className="text-right">
                <p className="text-[64px] sm:text-[76px] leading-[0.85] font-black text-white tabular-nums tracking-tighter">
                  {pctShown}<span className="text-3xl align-top">%</span>
                </p>
                <p className="text-[11px] uppercase tracking-[0.22em] font-bold text-white/60 mt-2">compliant</p>
              </div>
              {isAdmin && (
                <button onClick={() => run()} disabled={runRules.isPending}
                  className="px-5 py-2.5 rounded-full bg-white text-slate-900 text-sm font-bold hover:scale-[1.03] active:scale-[0.98] disabled:opacity-60 transition-transform shadow-lg">
                  {runRules.isPending ? "Sweeping…" : "Sweep now"}
                </button>
              )}
            </div>
          </div>

          {t.fixable > 0 && (
            <div className="relative mt-7 pt-5 border-t border-white/15 flex items-center gap-2.5 text-sm text-white/85">
              <i className="ph-fill ph-wrench text-lg"></i>
              <span><strong className="font-bold">{t.fixable}</strong> of those could be fixed automatically — those rules are set to report only.</span>
            </div>
          )}
        </section>

        {error && <Note tone="bad">{error}</Note>}
        {runRules.isSuccess && !error && (
          <Note tone="ok">
            Swept {runRules.data.findings.length} resources — {runRules.data.violations} failing
            {runRules.data.remediated > 0 && `, ${runRules.data.remediated} fixed`}.
          </Note>
        )}
        {!isAdmin && (
          <Note tone="mute">
            You can view everything here. Changing or running guardrails is limited to the{" "}
            <strong className="font-semibold">{adminTeam}</strong> team — they act on the whole AWS account.
          </Note>
        )}

        {view.k === "excl" ? (
          <ExclusionsView lists={exclusions ?? []} isAdmin={isAdmin} onBack={() => setView({ k: "list" })} />
        ) : view.k === "new" ? (
          <RuleEditor rule={null} catalog={catalog ?? []} exclusions={exclusions ?? []} onClose={() => setView({ k: "list" })} />
        ) : active ? (
          <RuleDetail row={active} catalog={catalog ?? []} exclusions={exclusions ?? []}
            isAdmin={isAdmin} running={runRules.isPending}
            onRun={() => run([active.rule.id])} onBack={() => setView({ k: "list" })} />
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap mb-5">
              <div className="relative flex-1 min-w-[240px] max-w-sm">
                <i className="ph-bold ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search rules and resources"
                  className="w-full pl-10 pr-3 py-2.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 placeholder:text-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:focus:ring-white/20" />
              </div>
              <Segmented value={only} onChange={setOnly} options={[
                ["all", `All ${rows.length}`], ["failing", `Failing ${t.rulesFailing}`], ["passing", "Passing"],
              ]} />
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setView({ k: "excl" })}
                  className="px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-sm hover:shadow transition-shadow">
                  Exclusions <span className="text-slate-400 font-mono ml-0.5">{exclusions?.length ?? 0}</span>
                </button>
                {isAdmin && (
                  <button onClick={() => setView({ k: "new" })}
                    className="px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-bold shadow-sm hover:shadow-md transition-shadow">
                    New rule
                  </button>
                )}
              </div>
            </div>

            {isLoading ? (
              <div className="py-20 flex justify-center">
                <div className="animate-spin rounded-full h-7 w-7 border-2 border-slate-200 dark:border-slate-700 border-t-slate-900 dark:border-t-white"></div>
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState hasRules={rows.length > 0} kinds={catalog?.length ?? 0}
                onNew={isAdmin ? () => setView({ k: "new" }) : undefined} />
            ) : (
              <div className="grid gap-3">
                {filtered.map((r, i) => (
                  <RuleCard key={r.rule.id} row={r} index={i} onOpen={() => setView({ k: "rule", id: r.rule.id })} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── slab pieces ───────────────────────────────────────────────────────

function Metric({ value, label, emphasis }: { value: number; label: string; emphasis?: boolean }) {
  const n = useCountUp(value);
  return (
    <div>
      <p className={`tabular-nums font-black text-white leading-[0.85] tracking-tighter ${emphasis ? "text-[56px] sm:text-[68px]" : "text-[34px] sm:text-[40px] text-white/75"}`}>
        {n}
      </p>
      <p className={`uppercase tracking-[0.18em] font-bold mt-2 ${emphasis ? "text-[11px] text-white/70" : "text-[10px] text-white/50"}`}>
        {label}
      </p>
    </div>
  );
}

// ── rule card ─────────────────────────────────────────────────────────

function RuleCard({ row, index, onOpen }: { row: RuleRow; index: number; onOpen: () => void }) {
  const { rule, entry, failing, checked, excluded } = row;
  const state = !rule.enabled ? "paused" : failing > 0 ? "bad" : checked === 0 ? "idle" : "ok";

  const rail = {
    bad: "bg-rose-500", ok: "bg-emerald-500",
    idle: "bg-slate-300 dark:bg-slate-600", paused: "bg-slate-200 dark:bg-slate-700",
  }[state];

  return (
    <button onClick={onOpen}
      style={{ animation: `fadeInUp 0.45s cubic-bezier(0.16,1,0.3,1) ${Math.min(index * 45, 400)}ms both` }}
      className="group relative w-full text-left bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/70 dark:border-slate-700/70 shadow-sm hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 overflow-hidden">
      <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${rail}`} />
      <div className="pl-7 pr-6 py-5 flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-[17px] font-bold tracking-tight ${rule.enabled ? "text-slate-900 dark:text-white" : "text-slate-400 dark:text-slate-500"}`}>
              {rule.name}
            </h3>
            {rule.mode === "enforce" && (
              <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full bg-blue-600 text-white">auto-fix</span>
            )}
            {!rule.enabled && (
              <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">paused</span>
            )}
          </div>
          <p className="text-[13.5px] text-slate-500 dark:text-slate-400 mt-1">{entry?.summary ?? rule.kind}</p>
        </div>

        <div className="shrink-0 text-right">
          {state === "bad" ? (
            <>
              <p className="text-[30px] font-black text-rose-600 dark:text-rose-400 tabular-nums leading-none">{failing}</p>
              <p className="text-[11px] uppercase tracking-wider font-bold text-rose-600/70 dark:text-rose-400/70 mt-1">failing</p>
            </>
          ) : state === "ok" ? (
            <>
              <p className="text-[30px] font-black text-emerald-600 dark:text-emerald-400 tabular-nums leading-none">{checked}</p>
              <p className="text-[11px] uppercase tracking-wider font-bold text-emerald-600/70 dark:text-emerald-400/70 mt-1">passing</p>
            </>
          ) : (
            <p className="text-[13px] font-semibold text-slate-400">{state === "paused" ? "Paused" : "Not checked"}</p>
          )}
          {excluded > 0 && <p className="text-[11px] text-slate-400 mt-1">{excluded} excluded</p>}
        </div>

        <i className="ph-bold ph-caret-right text-slate-300 dark:text-slate-600 group-hover:text-slate-500 dark:group-hover:text-slate-400 group-hover:translate-x-0.5 transition-all"></i>
      </div>
    </button>
  );
}

function EmptyState({ hasRules, kinds, onNew }: { hasRules: boolean; kinds: number; onNew?: () => void }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 py-20 text-center shadow-sm">
      <p className="text-xl font-bold text-slate-800 dark:text-slate-100">
        {hasRules ? "Nothing matches" : "No guardrails yet"}
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 max-w-sm mx-auto">
        {hasRules ? "Try clearing the search or filter."
          : `A guardrail says how a kind of AWS resource must be configured, and checks it on creation, every 15 minutes, and on demand. ${kinds} types available.`}
      </p>
      {!hasRules && onNew && (
        <button onClick={onNew}
          className="mt-6 px-5 py-2.5 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-bold hover:scale-[1.03] transition-transform">
          Add the first rule
        </button>
      )}
    </div>
  );
}

// ── shared ────────────────────────────────────────────────────────────

function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: [T, string][];
}) {
  return (
    <div className="flex p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-3.5 py-1.5 text-[13px] font-bold rounded-lg transition-all ${
            value === v ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm"
                        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

const NOTE: Record<string, string> = {
  bad: "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300",
  ok: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300",
  mute: "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300",
};

function Note({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <div className={`mb-5 px-4 py-3 rounded-xl border text-sm shadow-sm ${NOTE[tone]}`}>{children}</div>;
}

function Back({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors">
      <i className="ph-bold ph-arrow-left text-xs"></i>{children}
    </button>
  );
}

function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden"
      style={{ animation: "slideUp 0.35s cubic-bezier(0.16,1,0.3,1) both" }}>
      {children}
    </div>
  );
}

function Block({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="px-7 py-6 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-[11px] uppercase tracking-[0.18em] font-bold text-slate-400 dark:text-slate-500">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2 border-b border-slate-50 dark:border-slate-800/60">
      <dt className="text-[14px] text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-[14px] font-semibold text-slate-800 dark:text-slate-200 text-right">{children}</dd>
    </div>
  );
}

function fmt(value: any, spec: ParamSpec): string {
  if (spec.type === "boolean") return value ? "Yes" : "No";
  if (spec.type === "ports") return Array.isArray(value) ? value.join(", ") : String(value);
  if (spec.type === "choice") return spec.options?.find(o => o.value === value)?.label ?? String(value);
  return spec.unit ? `${value} ${spec.unit}` : String(value);
}

const input = "w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:focus:ring-white/20";

// ── detail ────────────────────────────────────────────────────────────

function RuleDetail({ row, catalog, exclusions, isAdmin, running, onRun, onBack }: {
  row: RuleRow; catalog: CatalogEntry[]; exclusions: AwsExclusionList[];
  isAdmin: boolean; running: boolean; onRun: () => void; onBack: () => void;
}) {
  const { rule, entry, findings, failing, checked, excluded } = row;
  const update = useUpdateGuardrail();
  const remove = useDeleteGuardrail();
  const [editing, setEditing] = useState(false);
  const [showPassing, setShowPassing] = useState(false);

  if (editing && isAdmin) {
    return <RuleEditor rule={rule} catalog={catalog} exclusions={exclusions} onClose={() => setEditing(false)} />;
  }

  const bad = findings.filter(f => f.verdict === "violation" && !f.excluded);
  const rest = findings.filter(f => !(f.verdict === "violation" && !f.excluded));
  const shown = showPassing ? [...bad, ...rest] : bad;
  const used = exclusions.filter(l => rule.exclusionLists?.includes(l.id));

  return (
    <>
      <Back onClick={onBack}>All rules</Back>
      <Sheet>
        <div className={`px-7 py-6 ${failing > 0 ? "bg-rose-500" : checked > 0 ? "bg-emerald-600" : "bg-slate-700"}`}>
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-2xl font-black text-white tracking-tight">{rule.name}</h2>
              <p className="text-sm text-white/75 mt-1.5">{entry?.summary}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[44px] font-black text-white leading-none tabular-nums">
                {failing > 0 ? failing : checked}
              </p>
              <p className="text-[11px] uppercase tracking-[0.18em] font-bold text-white/70 mt-1.5">
                {failing > 0 ? "failing" : checked > 0 ? "passing" : "not checked"}
              </p>
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="px-7 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-5 bg-slate-50/70 dark:bg-slate-800/40">
            <button onClick={onRun} disabled={running}
              className="text-sm font-bold text-slate-800 dark:text-slate-100 hover:opacity-70 disabled:opacity-40">
              {running ? "Running…" : "Run now"}
            </button>
            <button onClick={() => setEditing(true)} className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">Edit</button>
            <button onClick={() => update.mutate({ id: rule.id, body: { enabled: !rule.enabled } })}
              className="text-sm font-bold text-slate-800 dark:text-slate-100 hover:opacity-70">
              {rule.enabled ? "Pause" : "Resume"}
            </button>
            <button onClick={() => { if (confirm(`Delete "${rule.name}"? Its findings go too.`)) { remove.mutate(rule.id); onBack(); } }}
              className="text-sm font-bold text-rose-600 dark:text-rose-400 hover:opacity-70 ml-auto">Delete</button>
          </div>
        )}

        <Block title="Configuration">
          <dl className="grid sm:grid-cols-2 gap-x-12">
            <Field label="When it finds a problem">
              {rule.mode === "enforce"
                ? <span className="text-blue-600 dark:text-blue-400">Fixes it automatically</span>
                : "Records it, changes nothing"}
            </Field>
            {(entry?.paramSchema ?? []).map(s => (
              <Field key={s.key} label={s.label}>{fmt(rule.params?.[s.key] ?? s.default, s)}</Field>
            ))}
            <Field label="On resource creation">
              {!entry?.createEvents.length ? "Swept only" : rule.applyOnCreate ? "Checked immediately" : "Waits for the sweep"}
            </Field>
            {used.length > 0 && <Field label="Skipping">{used.map(l => l.name).join(", ")}</Field>}
          </dl>
        </Block>

        <Block
          title={`Resources — ${failing} failing of ${checked} checked${excluded ? `, ${excluded} excluded` : ""}`}
          action={rest.length > 0 && (
            <button onClick={() => setShowPassing(v => !v)}
              className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">
              {showPassing ? "Hide passing" : `Show ${rest.length} passing`}
            </button>
          )}>
          {findings.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Not checked yet. Run this rule to populate it.</p>
          ) : (
            <ul className="space-y-px">
              {shown.slice(0, 200).map((f, i) => (
                <li key={f.resourceId}
                  style={{ animation: `fadeInUp 0.3s cubic-bezier(0.16,1,0.3,1) ${Math.min(i * 18, 300)}ms both` }}
                  className="flex items-start gap-3.5 py-3 px-3 -mx-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
                  <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                    f.remediated ? "bg-blue-500"
                      : f.excluded ? "bg-slate-300 dark:bg-slate-600"
                        : f.verdict === "violation" ? "bg-rose-500" : "bg-emerald-500"}`} />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-mono font-medium text-slate-800 dark:text-slate-100 break-all">{f.resourceId}</p>
                    <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {f.summary}
                      {f.proposedFix && !f.remediated && !f.excluded && (
                        <span className="text-slate-400 dark:text-slate-500"> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
                      )}
                    </p>
                    {f.error && <p className="text-[13px] text-rose-500 mt-0.5">{f.error}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </Sheet>
    </>
  );
}

// ── editor ────────────────────────────────────────────────────────────

function RuleEditor({ rule, catalog, exclusions, onClose }: {
  rule: Guardrail | null; catalog: CatalogEntry[]; exclusions: AwsExclusionList[]; onClose: () => void;
}) {
  const create = useCreateGuardrail();
  const update = useUpdateGuardrail();

  const [kind, setKind] = useState(rule?.kind ?? catalog[0]?.kind ?? "");
  const entry = catalog.find(c => c.kind === kind);
  const [name, setName] = useState(rule?.name ?? entry?.title ?? "");
  const [mode, setMode] = useState(rule?.mode ?? "report");
  const [applyOnCreate, setApplyOnCreate] = useState(rule?.applyOnCreate ?? true);
  const [params, setParams] = useState<Record<string, any>>(rule?.params ?? entry?.defaultParams ?? {});
  const [picked, setPicked] = useState<string[]>(rule?.exclusionLists ?? []);
  const [error, setError] = useState<string | null>(null);

  const pickKind = (k: string) => {
    const e = catalog.find(c => c.kind === k);
    setKind(k); setParams(e?.defaultParams ?? {}); setName(e?.title ?? k);
    if (!e?.canRemediate) setMode("report");
  };

  const submit = async () => {
    setError(null);
    try {
      const body = { name, description: entry?.summary ?? "", kind, mode, applyOnCreate, params, exclusionLists: picked };
      if (rule) await update.mutateAsync({ id: rule.id, body });
      else await create.mutateAsync(body);
      onClose();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <Back onClick={onClose}>{rule ? "Back to rule" : "All rules"}</Back>
      <div className="max-w-2xl">
        <Sheet>
          <div className="px-7 py-6 bg-slate-900 dark:bg-slate-800">
            <h2 className="text-xl font-black text-white tracking-tight">{rule ? rule.name : "New guardrail"}</h2>
            <p className="text-sm text-white/60 mt-1">{rule ? "Editing" : "Choose what to check and how strict to be"}</p>
          </div>

          <Block title="What to check">
            {rule ? (
              <p className="text-sm text-slate-700 dark:text-slate-200">
                {entry?.title}
                <span className="block text-[13px] text-slate-400 mt-1">
                  Type can't change after creation — delete and recreate instead.
                </span>
              </p>
            ) : (
              <>
                <select value={kind} onChange={e => pickKind(e.target.value)} className={input}>
                  {catalog.map(c => <option key={c.kind} value={c.kind}>{c.title}</option>)}
                </select>
                {entry && <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-2">{entry.summary}</p>}
              </>
            )}
          </Block>

          <Block title="Name"><input value={name} onChange={e => setName(e.target.value)} className={input} /></Block>

          {(entry?.paramSchema ?? []).length > 0 && (
            <Block title="Settings">
              <div className="space-y-5">
                {entry!.paramSchema.map(spec => (
                  <ParamControl key={spec.key} spec={spec} value={params[spec.key] ?? spec.default}
                    onChange={v => setParams(p => ({ ...p, [spec.key]: v }))} />
                ))}
              </div>
            </Block>
          )}

          <Block title="When it finds a problem">
            <div className="grid sm:grid-cols-2 gap-3">
              <Mode active={mode === "report"} onClick={() => setMode("report")}
                title="Report it" body="Records the finding. Nothing in AWS changes." />
              <Mode active={mode === "enforce"} disabled={!entry?.canRemediate}
                onClick={() => entry?.canRemediate && setMode("enforce")}
                title="Fix it automatically"
                body={entry?.canRemediate
                  ? "Changes the resource on every sweep, unattended."
                  : "Unavailable — fixing this automatically could cut live access."} />
            </div>
          </Block>

          {!!entry?.createEvents.length && (
            <Block title="Timing">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={applyOnCreate} onChange={e => setApplyOnCreate(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-600" />
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  Check as soon as a resource is created
                  <span className="block text-[13px] text-slate-400">Otherwise it waits up to 15 minutes.</span>
                </span>
              </label>
            </Block>
          )}

          {exclusions.length > 0 && (
            <Block title="Skip resources in">
              <div className="space-y-2">
                {exclusions.map(l => (
                  <label key={l.id} className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={picked.includes(l.id)}
                      onChange={e => setPicked(s => e.target.checked ? [...s, l.id] : s.filter(x => x !== l.id))}
                      className="rounded border-slate-300 dark:border-slate-600" />
                    {l.name}
                  </label>
                ))}
              </div>
            </Block>
          )}

          <div className="px-7 py-6 flex items-center gap-3">
            <button onClick={submit}
              className="px-5 py-2.5 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-bold hover:scale-[1.03] transition-transform">
              {rule ? "Save changes" : "Create rule"}
            </button>
            <button onClick={onClose} className="text-sm font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
            {error && <span className="text-[13px] text-rose-600 dark:text-rose-400">{error}</span>}
          </div>
        </Sheet>
      </div>
    </>
  );
}

function Mode({ active, onClick, title, body, disabled }: {
  active: boolean; onClick: () => void; title: string; body: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`text-left px-4 py-3.5 rounded-xl border-2 transition-all ${
        active ? "border-slate-900 dark:border-white bg-slate-900/[0.04] dark:bg-white/[0.08]"
               : "border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500"
      } ${disabled ? "opacity-45 cursor-not-allowed hover:border-slate-200 dark:hover:border-slate-700" : ""}`}>
      <span className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-white">
        {disabled && <i className="ph-fill ph-lock-simple text-xs"></i>}{title}
      </span>
      <span className="block text-[13px] text-slate-500 dark:text-slate-400 mt-1">{body}</span>
    </button>
  );
}

function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: any; onChange: (v: any) => void }) {
  if (spec.type === "boolean") {
    return (
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
          className="mt-0.5 rounded border-slate-300 dark:border-slate-600" />
        <span className="text-sm text-slate-700 dark:text-slate-300">
          {spec.label}
          {spec.help && <span className="block text-[13px] text-slate-400">{spec.help}</span>}
        </span>
      </label>
    );
  }
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">{spec.label}</span>
      <span className="flex items-center gap-2.5">
        {spec.type === "number" && spec.allowed ? (
          <select value={value} onChange={e => onChange(Number(e.target.value))} className={`${input} w-40`}>
            {spec.allowed.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : spec.type === "number" ? (
          <input type="number" min={spec.min} value={value} onChange={e => onChange(Number(e.target.value))} className={`${input} w-40`} />
        ) : spec.type === "choice" ? (
          <select value={value} onChange={e => onChange(e.target.value)} className={input}>
            {spec.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : spec.type === "ports" ? (
          <input value={Array.isArray(value) ? value.join(", ") : value}
            onChange={e => onChange(e.target.value.split(",").map(x => Number(x.trim())).filter(n => !Number.isNaN(n)))}
            className={input} />
        ) : (
          <input value={value ?? ""} onChange={e => onChange(e.target.value)} className={input} />
        )}
        {spec.unit && <span className="text-sm font-medium text-slate-500 dark:text-slate-400 shrink-0">{spec.unit}</span>}
      </span>
      {spec.help && <span className="block text-[13px] text-slate-400 mt-1.5">{spec.help}</span>}
    </label>
  );
}

// ── exclusions ────────────────────────────────────────────────────────

function ExclusionsView({ lists, isAdmin, onBack }: { lists: AwsExclusionList[]; isAdmin: boolean; onBack: () => void }) {
  const save = useSaveAwsExclusion();
  const remove = useDeleteAwsExclusion();
  const [editing, setEditing] = useState<AwsExclusionList | "new" | null>(null);

  if (editing && isAdmin) {
    return <ExclusionEditor list={editing === "new" ? null : editing} onClose={() => setEditing(null)}
      onSave={(body, id) => save.mutateAsync({ id, body }).then(() => setEditing(null))} />;
  }

  return (
    <>
      <Back onClick={onBack}>All rules</Back>
      <Sheet>
        <div className="px-7 py-6 bg-slate-900 dark:bg-slate-800 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-white tracking-tight">Exclusion lists</h2>
            <p className="text-sm text-white/60 mt-1">Resources matched here are skipped by any rule using the list.</p>
          </div>
          {isAdmin && (
            <button onClick={() => setEditing("new")}
              className="px-4 py-2 rounded-full bg-white text-slate-900 text-sm font-bold hover:scale-[1.03] transition-transform shrink-0">
              New list
            </button>
          )}
        </div>
        {lists.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-lg font-bold text-slate-800 dark:text-slate-100">No exclusion lists</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">Skip resources by exact name, prefix, substring or tag.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {lists.map(l => (
              <div key={l.id} className="px-7 py-5 flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <h3 className="text-[15px] font-bold text-slate-900 dark:text-white">{l.name}</h3>
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {l.resources.map(r => <Chip key={r} tone="slate">{r}</Chip>)}
                    {l.patterns.map(p => <Chip key={p.id} tone="blue">{p.type.replace(/_/g, " ")} {p.value}</Chip>)}
                    {l.whitelist.map(w => <Chip key={w} tone="green">keep {w}</Chip>)}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-4 shrink-0">
                    <button onClick={() => setEditing(l)} className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">Edit</button>
                    <button onClick={() => { if (confirm(`Delete "${l.name}"?`)) remove.mutate(l.id); }}
                      className="text-sm font-bold text-rose-600 dark:text-rose-400 hover:opacity-70">Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  const c = {
    slate: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
    blue: "bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300",
    green: "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300",
  }[tone];
  return <span className={`text-[12px] font-mono font-medium px-2.5 py-1 rounded-lg ${c}`}>{children}</span>;
}

function ExclusionEditor({ list, onClose, onSave }: {
  list: AwsExclusionList | null; onClose: () => void;
  onSave: (body: Partial<AwsExclusionList>, id?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [resources, setResources] = useState((list?.resources ?? []).join("\n"));
  const [whitelist, setWhitelist] = useState((list?.whitelist ?? []).join("\n"));
  const [patterns, setPatterns] = useState((list?.patterns ?? []).map(p => `${p.type}:${p.value}`).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const lines = (s: string) => s.split("\n").map(x => x.trim()).filter(Boolean);

  const submit = async () => {
    setError(null);
    const parsed = lines(patterns).map((line, i) => {
      const idx = line.indexOf(":");
      const type = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!["starts_with", "contains", "tag_equals"].includes(type) || !value) return null;
      return { id: `p${i}`, type: type as any, value };
    });
    if (parsed.some(p => p === null)) {
      setError("Each line must be starts_with:tmp- · contains:sandbox · tag_equals:Env=dev");
      return;
    }
    try {
      await onSave({ name, description: "", resources: lines(resources), whitelist: lines(whitelist), patterns: parsed as any }, list?.id);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <Back onClick={onClose}>Exclusion lists</Back>
      <div className="max-w-2xl">
        <Sheet>
          <div className="px-7 py-6 bg-slate-900 dark:bg-slate-800">
            <h2 className="text-xl font-black text-white tracking-tight">{list ? list.name : "New exclusion list"}</h2>
          </div>
          <Block title="Name"><input value={name} onChange={e => setName(e.target.value)} className={input} /></Block>
          <Block title="Exact names">
            <textarea rows={3} value={resources} onChange={e => setResources(e.target.value)} className={`${input} font-mono text-[13px]`} />
            <p className="text-[13px] text-slate-400 mt-2">One per line.</p>
          </Block>
          <Block title="Patterns">
            <textarea rows={3} value={patterns} onChange={e => setPatterns(e.target.value)} className={`${input} font-mono text-[13px]`}
              placeholder={"starts_with:tmp-\ncontains:sandbox\ntag_equals:Env=dev"} />
          </Block>
          <Block title="Keep anyway">
            <textarea rows={2} value={whitelist} onChange={e => setWhitelist(e.target.value)} className={`${input} font-mono text-[13px]`} />
            <p className="text-[13px] text-slate-400 mt-2">Wins over the patterns above.</p>
          </Block>
          <div className="px-7 py-6 flex items-center gap-3">
            <button onClick={submit}
              className="px-5 py-2.5 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-bold hover:scale-[1.03] transition-transform">Save</button>
            <button onClick={onClose} className="text-sm font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
            {error && <span className="text-[13px] text-rose-600 dark:text-rose-400">{error}</span>}
          </div>
        </Sheet>
      </div>
    </>
  );
}
