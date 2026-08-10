import { useState, useMemo } from "react";
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
 * Laid out as a ledger rather than a dashboard: one dense posture line at the
 * top, then rules that expand in place. Settings come from each rule kind's
 * paramSchema, so the person configuring a compliance rule reads labels like
 * "Flag anything retaining less than" instead of editing JSON keys.
 */

const relTime = (iso?: string) => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export default function AwsPage() {
  const { user } = useAuth();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isControlHubAdmin ?? false;
  const adminTeam = permissions?.adminTeam ?? "control-hub-admins";

  const { data: catalog } = useCatalog();
  const { data: rules, isLoading } = useGuardrails();
  const { data: findings } = useFindings();
  const { data: exclusions } = useAwsExclusions();

  const runRules = useRunGuardrails();
  const [creating, setCreating] = useState(false);
  const [openRule, setOpenRule] = useState<string | null>(null);
  const [showExclusions, setShowExclusions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const posture = useMemo(() => {
    const f = findings ?? [];
    const violation = f.filter(x => x.verdict === "violation" && !x.excluded).length;
    const compliant = f.filter(x => x.verdict === "compliant").length;
    const excluded = f.filter(x => x.excluded).length;
    const lastRun = f.reduce<string | undefined>((acc, x) => (!acc || x.checkedAt > acc ? x.checkedAt : acc), undefined);
    return { violation, compliant, excluded, total: f.length, lastRun };
  }, [findings]);

  const byRule = useMemo(() => {
    const m = new Map<string, Finding[]>();
    (findings ?? []).forEach(f => m.set(f.ruleId, [...(m.get(f.ruleId) ?? []), f]));
    return m;
  }, [findings]);

  const run = async (ruleIds?: string[]) => {
    setError(null);
    try { await runRules.mutateAsync({ ruleIds }); }
    catch (e) { setError((e as Error).message); }
  };

  const pct = (n: number) => (posture.total ? (n / posture.total) * 100 : 0);

  return (
    <div className="min-h-screen bg-[#fbfbfd] dark:bg-[#0b0d12]">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-[1180px] mx-auto px-6 pt-8 pb-20">

        {/* Masthead — one sentence of posture, not a row of identical cards */}
        <header className="border-b border-slate-900/10 dark:border-white/10 pb-6 mb-8">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500 font-semibold mb-1.5">
                Account guardrails
              </p>
              <h1 className="text-[2.1rem] leading-none font-semibold text-slate-900 dark:text-white tracking-tight">
                {posture.violation === 0 && posture.total > 0
                  ? "Everything checked is compliant"
                  : posture.total === 0
                    ? "Nothing checked yet"
                    : <>{posture.violation} <span className="text-slate-400 dark:text-slate-500 font-normal">of {posture.total} checks failing</span></>}
              </h1>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
                {rules?.filter(r => r.enabled).length ?? 0} active {(rules?.filter(r => r.enabled).length ?? 0) === 1 ? "rule" : "rules"}
                {" · "}swept {relTime(posture.lastRun)}
                {" · "}re-checks every 15 min
              </p>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2">
                <button onClick={() => setCreating(v => !v)}
                  className="px-3.5 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors">
                  New rule
                </button>
                <button onClick={() => run()} disabled={runRules.isPending}
                  className="px-4 py-2 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-medium hover:opacity-85 disabled:opacity-40 transition-opacity">
                  {runRules.isPending ? "Sweeping…" : "Sweep now"}
                </button>
              </div>
            )}
          </div>

          {/* Posture bar — proportional, replaces four number tiles */}
          {posture.total > 0 && (
            <div className="mt-6">
              <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-200/60 dark:bg-white/5">
                {posture.violation > 0 && <div className="bg-rose-500" style={{ width: `${pct(posture.violation)}%` }} />}
                {posture.compliant > 0 && <div className="bg-emerald-500" style={{ width: `${pct(posture.compliant)}%` }} />}
                {posture.excluded > 0 && <div className="bg-slate-300 dark:bg-slate-600" style={{ width: `${pct(posture.excluded)}%` }} />}
              </div>
              <div className="flex gap-5 mt-2.5 text-[11px] text-slate-500 dark:text-slate-400">
                <Legend colour="bg-rose-500" n={posture.violation} label="failing" />
                <Legend colour="bg-emerald-500" n={posture.compliant} label="passing" />
                <Legend colour="bg-slate-300 dark:bg-slate-600" n={posture.excluded} label="excluded" />
              </div>
            </div>
          )}
        </header>

        {error && (
          <p className="mb-6 text-sm text-rose-600 dark:text-rose-400 border-l-2 border-rose-500 pl-3">{error}</p>
        )}
        {runRules.isSuccess && !error && (
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-300 border-l-2 border-emerald-500 pl-3">
            Swept {runRules.data.findings.length} resources — {runRules.data.violations} failing
            {runRules.data.remediated > 0 && `, ${runRules.data.remediated} fixed`}
            {runRules.data.excluded > 0 && `, ${runRules.data.excluded} excluded`}.
          </p>
        )}

        {!isAdmin && (
          <p className="mb-6 text-sm text-slate-500 dark:text-slate-400 border-l-2 border-slate-300 dark:border-slate-600 pl-3">
            You can see every rule and finding here. Creating, editing and running guardrails is limited to the{" "}
            <span className="font-medium text-slate-700 dark:text-slate-200">{adminTeam}</span> team, because they act
            on the whole AWS account rather than on anything scoped to you.
          </p>
        )}

        {creating && isAdmin && (
          <RuleForm
            rule={null} catalog={catalog ?? []} exclusions={exclusions ?? []}
            onDone={() => setCreating(false)} onCancel={() => setCreating(false)}
          />
        )}

        {/* Rules */}
        {isLoading ? (
          <p className="text-sm text-slate-400 py-10">Loading…</p>
        ) : !rules?.length ? (
          <EmptyRules isAdmin={isAdmin} count={catalog?.length ?? 0} onNew={() => setCreating(true)} />
        ) : (
          <ul className="divide-y divide-slate-900/[0.07] dark:divide-white/[0.07] border-y border-slate-900/[0.07] dark:border-white/[0.07]">
            {rules.map(r => (
              <RuleRow
                key={r.id} rule={r}
                entry={(catalog ?? []).find(c => c.kind === r.kind)}
                findings={byRule.get(r.id) ?? []}
                exclusions={exclusions ?? []}
                catalog={catalog ?? []}
                isAdmin={isAdmin}
                open={openRule === r.id}
                onToggle={() => setOpenRule(o => (o === r.id ? null : r.id))}
                onRun={() => run([r.id])}
                running={runRules.isPending}
              />
            ))}
          </ul>
        )}

        {/* Exclusions — secondary, folded away until wanted */}
        <section className="mt-12">
          <button onClick={() => setShowExclusions(v => !v)}
            className="flex items-baseline gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500 font-semibold">
              Exclusion lists
            </span>
            <span className="text-slate-400 dark:text-slate-500">{exclusions?.length ?? 0}</span>
            <i className={`ph-bold ph-caret-${showExclusions ? "up" : "down"} text-[10px] text-slate-400`}></i>
          </button>
          {showExclusions && <ExclusionsSection lists={exclusions ?? []} isAdmin={isAdmin} />}
        </section>
      </main>
    </div>
  );
}

function Legend({ colour, n, label }: { colour: string; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${colour}`} />
      <span className="tabular-nums font-medium text-slate-700 dark:text-slate-300">{n}</span> {label}
    </span>
  );
}

function EmptyRules({ isAdmin, count, onNew }: { isAdmin: boolean; count: number; onNew: () => void }) {
  return (
    <div className="py-16 border-y border-slate-900/[0.07] dark:border-white/[0.07]">
      <p className="text-lg text-slate-700 dark:text-slate-200 font-medium">No guardrails yet</p>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 max-w-md">
        A guardrail describes how a kind of AWS resource must be configured. It checks on creation,
        on a 15-minute sweep, and whenever you ask. {count} rule types are available.
      </p>
      {isAdmin && (
        <button onClick={onNew} className="mt-4 px-4 py-2 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-medium hover:opacity-85 transition-opacity">
          Add the first one
        </button>
      )}
    </div>
  );
}

// ── one rule ──────────────────────────────────────────────────────────

function RuleRow({ rule, entry, findings, exclusions, catalog, isAdmin, open, onToggle, onRun, running }: {
  rule: Guardrail; entry?: CatalogEntry; findings: Finding[]; exclusions: AwsExclusionList[];
  catalog: CatalogEntry[]; isAdmin: boolean; open: boolean;
  onToggle: () => void; onRun: () => void; running: boolean;
}) {
  const update = useUpdateGuardrail();
  const remove = useDeleteGuardrail();
  const [editing, setEditing] = useState(false);

  const failing = findings.filter(f => f.verdict === "violation" && !f.excluded).length;
  const excluded = findings.filter(f => f.excluded).length;

  return (
    <li className="group">
      <div className="flex items-start gap-4 py-4">
        <button onClick={onToggle} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              !rule.enabled ? "bg-slate-300 dark:bg-slate-600"
                : failing > 0 ? "bg-rose-500" : "bg-emerald-500"}`} />
            <span className={`text-[15px] font-medium ${rule.enabled ? "text-slate-900 dark:text-white" : "text-slate-400 dark:text-slate-500"}`}>
              {rule.name}
            </span>
            {rule.mode === "enforce" && (
              <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                auto-fixes
              </span>
            )}
            {!rule.enabled && <span className="text-[11px] text-slate-400">paused</span>}
          </div>
          <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1 ml-4">
            {entry?.summary ?? rule.kind}
          </p>
          <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-1 ml-4 tabular-nums">
            {findings.length === 0 ? "not yet checked"
              : failing > 0
                ? <><span className="text-rose-600 dark:text-rose-400 font-medium">{failing} failing</span> of {findings.length - excluded} checked</>
                : `all ${findings.length - excluded} passing`}
            {excluded > 0 && ` · ${excluded} excluded`}
          </p>
        </button>

        {isAdmin && (
          <div className="flex items-center gap-3 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button onClick={onRun} disabled={running}
              className="text-[13px] text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-40">Run</button>
            <button onClick={() => { setEditing(true); if (!open) onToggle(); }}
              className="text-[13px] text-slate-500 hover:text-slate-900 dark:hover:text-white">Edit</button>
            <button onClick={() => update.mutate({ id: rule.id, body: { enabled: !rule.enabled } })}
              className="text-[13px] text-slate-500 hover:text-slate-900 dark:hover:text-white">
              {rule.enabled ? "Pause" : "Resume"}
            </button>
            <button onClick={() => { if (confirm(`Delete "${rule.name}"? Its findings are removed too.`)) remove.mutate(rule.id); }}
              className="text-[13px] text-slate-400 hover:text-rose-600 dark:hover:text-rose-400">Delete</button>
          </div>
        )}
      </div>

      {open && (
        <div className="pb-6 pl-4 animate-fade-in">
          {editing && isAdmin ? (
            <RuleForm rule={rule} catalog={catalog} exclusions={exclusions}
              onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
          ) : (
            <>
              <SettingsSummary rule={rule} entry={entry} exclusions={exclusions} />
              <FindingsList findings={findings} />
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Reads back the configured values in the schema's own words. */
function SettingsSummary({ rule, entry, exclusions }: {
  rule: Guardrail; entry?: CatalogEntry; exclusions: AwsExclusionList[];
}) {
  const specs = entry?.paramSchema ?? [];
  const used = exclusions.filter(l => rule.exclusionLists?.includes(l.id));

  return (
    <dl className="mb-5 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[13px]">
      {specs.map(spec => (
        <div key={spec.key} className="contents">
          <dt className="text-slate-400 dark:text-slate-500">{spec.label}</dt>
          <dd className="text-slate-700 dark:text-slate-300 tabular-nums">
            {formatValue(rule.params?.[spec.key] ?? spec.default, spec)}
          </dd>
        </div>
      ))}
      <div className="contents">
        <dt className="text-slate-400 dark:text-slate-500">On resource creation</dt>
        <dd className="text-slate-700 dark:text-slate-300">
          {!entry?.createEvents.length ? "n/a — swept only" : rule.applyOnCreate ? "checked immediately" : "waits for the sweep"}
        </dd>
      </div>
      {used.length > 0 && (
        <div className="contents">
          <dt className="text-slate-400 dark:text-slate-500">Excluding</dt>
          <dd className="text-slate-700 dark:text-slate-300">{used.map(l => l.name).join(", ")}</dd>
        </div>
      )}
    </dl>
  );
}

function formatValue(value: any, spec: ParamSpec): string {
  if (spec.type === "boolean") return value ? "yes" : "no";
  if (spec.type === "ports") return Array.isArray(value) ? value.join(", ") : String(value);
  if (spec.type === "choice") return spec.options?.find(o => o.value === value)?.label ?? String(value);
  return spec.unit ? `${value} ${spec.unit}` : String(value);
}

function FindingsList({ findings }: { findings: Finding[] }) {
  const [showAll, setShowAll] = useState(false);
  const failing = findings.filter(f => f.verdict === "violation" && !f.excluded);
  const rest = findings.filter(f => !(f.verdict === "violation" && !f.excluded));
  const shown = showAll ? [...failing, ...rest] : failing;

  if (findings.length === 0) {
    return <p className="text-[13px] text-slate-400">No results yet — run this rule to populate it.</p>;
  }

  return (
    <div>
      <ul className="space-y-1">
        {shown.slice(0, 60).map(f => (
          <li key={f.resourceId} className="flex items-baseline gap-3 text-[13px] py-0.5">
            <span className={`w-1 h-1 rounded-full shrink-0 translate-y-[-2px] ${
              f.remediated ? "bg-sky-500"
                : f.excluded ? "bg-slate-300 dark:bg-slate-600"
                  : f.verdict === "violation" ? "bg-rose-500" : "bg-emerald-500"}`} />
            <code className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[46ch]" title={f.resourceId}>
              {f.resourceId}
            </code>
            <span className="text-slate-400 dark:text-slate-500 truncate">
              {f.summary}
              {f.proposedFix && !f.remediated && !f.excluded && (
                <span className="text-slate-500 dark:text-slate-400"> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
              )}
            </span>
            {f.error && <span className="text-rose-500 shrink-0">{f.error}</span>}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <button onClick={() => setShowAll(v => !v)}
          className="mt-2 text-[12px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
          {showAll ? "Hide passing" : `Show ${rest.length} passing and excluded`}
        </button>
      )}
    </div>
  );
}

// ── rule form: controls come from paramSchema ─────────────────────────

function RuleForm({ rule, catalog, exclusions, onDone, onCancel }: {
  rule: Guardrail | null; catalog: CatalogEntry[]; exclusions: AwsExclusionList[];
  onDone: () => void; onCancel: () => void;
}) {
  const create = useCreateGuardrail();
  const update = useUpdateGuardrail();

  const [kind, setKind] = useState(rule?.kind ?? catalog[0]?.kind ?? "");
  const entry = catalog.find(c => c.kind === kind);
  const [name, setName] = useState(rule?.name ?? entry?.title ?? "");
  const [mode, setMode] = useState(rule?.mode ?? "report");
  const [applyOnCreate, setApplyOnCreate] = useState(rule?.applyOnCreate ?? true);
  const [params, setParams] = useState<Record<string, any>>(rule?.params ?? entry?.defaultParams ?? {});
  const [selected, setSelected] = useState<string[]>(rule?.exclusionLists ?? []);
  const [error, setError] = useState<string | null>(null);

  const pickKind = (k: string) => {
    const e = catalog.find(c => c.kind === k);
    setKind(k);
    setParams(e?.defaultParams ?? {});
    if (!e?.canRemediate) setMode("report");
    setName(e?.title ?? k);
  };

  const submit = async () => {
    setError(null);
    try {
      const body = { name, description: entry?.summary ?? "", kind, mode, applyOnCreate, params, exclusionLists: selected };
      if (rule) await update.mutateAsync({ id: rule.id, body });
      else await create.mutateAsync(body);
      onDone();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="my-6 pl-4 border-l-2 border-slate-900 dark:border-white animate-fade-in">
      <div className="max-w-xl space-y-5">
        {!rule && (
          <label className="block">
            <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">What to check</span>
            <select value={kind} onChange={e => pickKind(e.target.value)}
              className="w-full bg-transparent border-0 border-b border-slate-300 dark:border-slate-600 pb-1.5 text-[15px] text-slate-900 dark:text-white focus:outline-none focus:border-slate-900 dark:focus:border-white">
              {catalog.map(c => <option key={c.kind} value={c.kind} className="bg-white dark:bg-slate-900">{c.title}</option>)}
            </select>
            {entry && <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-2">{entry.summary}</p>}
          </label>
        )}

        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">Name</span>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full bg-transparent border-0 border-b border-slate-300 dark:border-slate-600 pb-1.5 text-[15px] text-slate-900 dark:text-white focus:outline-none focus:border-slate-900 dark:focus:border-white" />
        </label>

        {/* The whole point: real controls, described in the rule's own words */}
        {(entry?.paramSchema ?? []).length > 0 && (
          <div>
            <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-3">Settings</span>
            <div className="space-y-4">
              {entry!.paramSchema.map(spec => (
                <ParamControl key={spec.key} spec={spec}
                  value={params[spec.key] ?? spec.default}
                  onChange={v => setParams(p => ({ ...p, [spec.key]: v }))} />
              ))}
            </div>
          </div>
        )}

        <div>
          <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-3">When it finds a problem</span>
          <div className="space-y-2">
            <ModeChoice active={mode === "report"} onClick={() => setMode("report")}
              title="Report it" body="Records the finding and leaves the resource alone." />
            <ModeChoice active={mode === "enforce"} onClick={() => entry?.canRemediate && setMode("enforce")}
              disabled={!entry?.canRemediate} title="Fix it automatically"
              body={entry?.canRemediate
                ? "Changes the resource on every sweep, with no one watching."
                : "Not available for this check — fixing it automatically could cut live access."} />
          </div>
        </div>

        {!!entry?.createEvents.length && (
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={applyOnCreate} onChange={e => setApplyOnCreate(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 dark:border-slate-600" />
            <span className="text-[13px] text-slate-700 dark:text-slate-300">
              Check as soon as a resource is created
              <span className="block text-slate-400 dark:text-slate-500">
                Otherwise it waits for the next sweep, up to 15 minutes later.
              </span>
            </span>
          </label>
        )}

        {exclusions.length > 0 && (
          <div>
            <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">Skip resources in</span>
            <div className="space-y-1.5">
              {exclusions.map(l => (
                <label key={l.id} className="flex items-center gap-2.5 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={selected.includes(l.id)}
                    onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(x => x !== l.id))}
                    className="rounded border-slate-300 dark:border-slate-600" />
                  {l.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}

        <div className="flex items-center gap-3 pt-1">
          <button onClick={submit}
            className="px-4 py-2 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-medium hover:opacity-85 transition-opacity">
            {rule ? "Save" : "Create rule"}
          </button>
          <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ModeChoice({ active, onClick, title, body, disabled }: {
  active: boolean; onClick: () => void; title: string; body: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`w-full text-left px-3.5 py-2.5 rounded-lg border transition-colors ${
        active
          ? "border-slate-900 dark:border-white bg-slate-900/[0.03] dark:bg-white/[0.06]"
          : "border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500"
      } ${disabled ? "opacity-45 cursor-not-allowed hover:border-slate-200 dark:hover:border-slate-700" : ""}`}>
      <span className="block text-[13px] font-medium text-slate-900 dark:text-white">{title}</span>
      <span className="block text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">{body}</span>
    </button>
  );
}

function ParamControl({ spec, value, onChange }: {
  spec: ParamSpec; value: any; onChange: (v: any) => void;
}) {
  if (spec.type === "boolean") {
    return (
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
          className="mt-0.5 rounded border-slate-300 dark:border-slate-600" />
        <span className="text-[13px] text-slate-700 dark:text-slate-300">
          {spec.label}
          {spec.help && <span className="block text-slate-400 dark:text-slate-500">{spec.help}</span>}
        </span>
      </label>
    );
  }

  const field = "bg-transparent border-0 border-b border-slate-300 dark:border-slate-600 pb-1 text-[15px] text-slate-900 dark:text-white tabular-nums focus:outline-none focus:border-slate-900 dark:focus:border-white";

  return (
    <label className="block">
      <span className="block text-[13px] text-slate-700 dark:text-slate-300 mb-1">{spec.label}</span>
      <span className="flex items-baseline gap-2">
        {spec.type === "number" && spec.allowed ? (
          <select value={value} onChange={e => onChange(Number(e.target.value))} className={`${field} w-32`}>
            {spec.allowed.map(v => <option key={v} value={v} className="bg-white dark:bg-slate-900">{v}</option>)}
          </select>
        ) : spec.type === "number" ? (
          <input type="number" min={spec.min} value={value} onChange={e => onChange(Number(e.target.value))} className={`${field} w-32`} />
        ) : spec.type === "choice" ? (
          <select value={value} onChange={e => onChange(e.target.value)} className={`${field} w-full`}>
            {spec.options?.map(o => <option key={o.value} value={o.value} className="bg-white dark:bg-slate-900">{o.label}</option>)}
          </select>
        ) : spec.type === "ports" ? (
          <input value={Array.isArray(value) ? value.join(", ") : value}
            onChange={e => onChange(e.target.value.split(",").map(x => Number(x.trim())).filter(n => !Number.isNaN(n)))}
            className={`${field} w-full`} />
        ) : (
          <input value={value ?? ""} onChange={e => onChange(e.target.value)} className={`${field} w-full`} />
        )}
        {spec.unit && <span className="text-[13px] text-slate-400 dark:text-slate-500">{spec.unit}</span>}
      </span>
      {spec.help && <span className="block text-[12px] text-slate-400 dark:text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}

// ── exclusions ────────────────────────────────────────────────────────

function ExclusionsSection({ lists, isAdmin }: { lists: AwsExclusionList[]; isAdmin: boolean }) {
  const save = useSaveAwsExclusion();
  const remove = useDeleteAwsExclusion();
  const [editing, setEditing] = useState<AwsExclusionList | "new" | null>(null);

  return (
    <div className="mt-4">
      <p className="text-[13px] text-slate-500 dark:text-slate-400 max-w-lg mb-4">
        Resources matched by a list are skipped by any rule using it. A “keep anyway” entry wins over the patterns.
      </p>

      {lists.length > 0 && (
        <ul className="divide-y divide-slate-900/[0.07] dark:divide-white/[0.07] border-t border-slate-900/[0.07] dark:border-white/[0.07] mb-4">
          {lists.map(l => (
            <li key={l.id} className="py-3 flex items-start justify-between gap-4 group">
              <div className="min-w-0">
                <span className="text-[14px] font-medium text-slate-800 dark:text-slate-100">{l.name}</span>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-[12px] font-mono">
                  {l.resources.map(r => <span key={r} className="text-slate-500 dark:text-slate-400">{r}</span>)}
                  {l.patterns.map(p => <span key={p.id} className="text-amber-700 dark:text-amber-500">{p.type.replace("_", " ")} {p.value}</span>)}
                  {l.whitelist.map(w => <span key={w} className="text-emerald-700 dark:text-emerald-500">keep {w}</span>)}
                </div>
              </div>
              {isAdmin && (
                <div className="flex gap-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => setEditing(l)} className="text-[13px] text-slate-500 hover:text-slate-900 dark:hover:text-white">Edit</button>
                  <button onClick={() => { if (confirm(`Delete "${l.name}"?`)) remove.mutate(l.id); }}
                    className="text-[13px] text-slate-400 hover:text-rose-600">Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && !editing && (
        <button onClick={() => setEditing("new")} className="text-sm text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white">
          + New list
        </button>
      )}

      {editing && isAdmin && (
        <ExclusionForm list={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={(body, id) => save.mutateAsync({ id, body }).then(() => setEditing(null))} />
      )}
    </div>
  );
}

function ExclusionForm({ list, onCancel, onSave }: {
  list: AwsExclusionList | null;
  onCancel: () => void;
  onSave: (body: Partial<AwsExclusionList>, id?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [resources, setResources] = useState((list?.resources ?? []).join("\n"));
  const [whitelist, setWhitelist] = useState((list?.whitelist ?? []).join("\n"));
  const [patterns, setPatterns] = useState((list?.patterns ?? []).map(p => `${p.type}:${p.value}`).join("\n"));
  const [error, setError] = useState<string | null>(null);

  const lines = (s: string) => s.split("\n").map(x => x.trim()).filter(Boolean);
  const field = "w-full bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-[13px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:border-slate-900 dark:focus:border-white";

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
      setError('Each line must read starts_with:tmp- · contains:sandbox · tag_equals:Env=dev');
      return;
    }
    try {
      await onSave({ name, description: "", resources: lines(resources), whitelist: lines(whitelist), patterns: parsed as any }, list?.id);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="mt-4 pl-4 border-l-2 border-slate-900 dark:border-white max-w-xl space-y-4 animate-fade-in">
      <label className="block">
        <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">Name</span>
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-full bg-transparent border-0 border-b border-slate-300 dark:border-slate-600 pb-1.5 text-[15px] text-slate-900 dark:text-white focus:outline-none focus:border-slate-900 dark:focus:border-white" />
      </label>
      <label className="block">
        <span className="block text-[13px] text-slate-700 dark:text-slate-300 mb-1.5">Exact names, one per line</span>
        <textarea rows={2} value={resources} onChange={e => setResources(e.target.value)} className={field} />
      </label>
      <label className="block">
        <span className="block text-[13px] text-slate-700 dark:text-slate-300 mb-1.5">Patterns, one per line</span>
        <textarea rows={3} value={patterns} onChange={e => setPatterns(e.target.value)} className={field}
          placeholder={"starts_with:tmp-\ncontains:sandbox\ntag_equals:Env=dev"} />
      </label>
      <label className="block">
        <span className="block text-[13px] text-slate-700 dark:text-slate-300 mb-1.5">
          Keep anyway <span className="text-slate-400">— overrides the patterns above</span>
        </span>
        <textarea rows={2} value={whitelist} onChange={e => setWhitelist(e.target.value)} className={field} />
      </label>
      {error && <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex items-center gap-3">
        <button onClick={submit} className="px-4 py-2 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-medium hover:opacity-85">Save</button>
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white">Cancel</button>
      </div>
    </div>
  );
}
