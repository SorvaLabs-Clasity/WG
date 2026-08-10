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
 * Split pane, matching the Knowledge Map tab: rules on the left with their
 * state always visible, the selected rule's detail on the right. Nothing hides
 * behind an expander, and the surfaces use the same card language as the rest
 * of the app so this does not read as a different product.
 */

const relTime = (iso?: string) => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<"rules" | "exclusions">("rules");
  const [error, setError] = useState<string | null>(null);

  const byRule = useMemo(() => {
    const m = new Map<string, Finding[]>();
    (findings ?? []).forEach(f => m.set(f.ruleId, [...(m.get(f.ruleId) ?? []), f]));
    return m;
  }, [findings]);

  const stats = useMemo(() => {
    const f = findings ?? [];
    return {
      failing: f.filter(x => x.verdict === "violation" && !x.excluded).length,
      passing: f.filter(x => x.verdict === "compliant").length,
      excluded: f.filter(x => x.excluded).length,
      enforcing: (rules ?? []).filter(r => r.enabled && r.mode === "enforce").length,
      lastRun: f.reduce<string | undefined>((a, x) => (!a || x.checkedAt > a ? x.checkedAt : a), undefined),
    };
  }, [findings, rules]);

  const run = async (ruleIds?: string[]) => {
    setError(null);
    try { await runRules.mutateAsync({ ruleIds }); }
    catch (e) { setError((e as Error).message); }
  };

  const active = rules?.find(r => r.id === selected) ?? null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-[1600px] mx-auto px-6 py-6">

        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">AWS Guardrails</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Checked when resources are created, every 15 minutes, and whenever you run them.
              {stats.lastRun && <> Last swept {relTime(stats.lastRun)}.</>}
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => { setCreating(true); setSelected(null); setTab("rules"); }}
                className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <i className="ph-bold ph-plus mr-1.5"></i>New rule
              </button>
              <button onClick={() => run()} disabled={runRules.isPending}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
                <i className={`${runRules.isPending ? "ph-bold ph-circle-notch animate-spin" : "ph-bold ph-play"} mr-1.5`}></i>
                {runRules.isPending ? "Running…" : "Run all"}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Stat icon="ph-warning-octagon" tone="rose" value={stats.failing} label="Failing" />
          <Stat icon="ph-check-circle" tone="emerald" value={stats.passing} label="Passing" />
          <Stat icon="ph-prohibit" tone="slate" value={stats.excluded} label="Excluded" />
          <Stat icon="ph-lock-key" tone="blue" value={stats.enforcing} label="Auto-fixing" />
        </div>

        {error && <Banner tone="rose">{error}</Banner>}
        {runRules.isSuccess && !error && (
          <Banner tone="emerald">
            Checked {runRules.data.findings.length} resources — {runRules.data.violations} failing
            {runRules.data.remediated > 0 && `, ${runRules.data.remediated} fixed`}
            {runRules.data.excluded > 0 && `, ${runRules.data.excluded} excluded`}.
          </Banner>
        )}
        {!isAdmin && (
          <Banner tone="slate">
            You can view every rule and finding. Creating, editing and running guardrails is limited to the{" "}
            <span className="font-semibold">{adminTeam}</span> team — they change the whole AWS account, not just
            what you can reach.
          </Banner>
        )}

        <div className="flex gap-1 mb-4 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg w-fit">
          {([["rules", "Rules", rules?.length ?? 0], ["exclusions", "Exclusion lists", exclusions?.length ?? 0]] as const).map(([id, text, n]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-colors ${
                tab === id ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm"
                           : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}>
              {text} <span className="text-slate-400 dark:text-slate-500 font-mono ml-0.5">{n}</span>
            </button>
          ))}
        </div>

        {tab === "exclusions" ? (
          <ExclusionsPanel lists={exclusions ?? []} isAdmin={isAdmin} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-5 items-start">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden">
              {isLoading ? (
                <div className="p-10 flex justify-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 dark:border-slate-700 border-t-slate-600"></div>
                </div>
              ) : !rules?.length ? (
                <div className="p-10 text-center">
                  <i className="ph-fill ph-shield-check text-4xl text-slate-300 dark:text-slate-600 mb-3 block"></i>
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">No guardrails yet</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {catalog?.length ?? 0} rule types available.
                  </p>
                </div>
              ) : (
                <div className="max-h-[calc(100vh-360px)] overflow-y-auto divide-y divide-slate-50 dark:divide-slate-800">
                  {rules.map(r => {
                    const f = byRule.get(r.id) ?? [];
                    const failing = f.filter(x => x.verdict === "violation" && !x.excluded).length;
                    const checked = f.filter(x => !x.excluded).length;
                    const on = selected === r.id;
                    return (
                      <button key={r.id} onClick={() => { setSelected(r.id); setCreating(false); }}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          on ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"}`}>
                        <div className="flex items-start gap-2.5">
                          <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${
                            !r.enabled ? "bg-slate-300 dark:bg-slate-600"
                              : failing > 0 ? "bg-rose-500"
                                : checked === 0 ? "bg-slate-300 dark:bg-slate-600" : "bg-emerald-500"}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`text-sm font-semibold truncate ${r.enabled ? "text-slate-800 dark:text-slate-100" : "text-slate-400 dark:text-slate-500"}`}>
                                {r.name}
                              </span>
                              {r.mode === "enforce" && <Tag tone="blue">auto-fix</Tag>}
                              {!r.enabled && <Tag tone="slate">paused</Tag>}
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                              {checked === 0 ? "not checked yet"
                                : failing > 0
                                  ? <span className="text-rose-600 dark:text-rose-400 font-medium">{failing} of {checked} failing</span>
                                  : `all ${checked} passing`}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {creating && isAdmin ? (
              <RuleEditor rule={null} catalog={catalog ?? []} exclusions={exclusions ?? []}
                onClose={() => setCreating(false)} />
            ) : active ? (
              <RuleDetail
                rule={active}
                entry={(catalog ?? []).find(c => c.kind === active.kind)}
                findings={byRule.get(active.id) ?? []}
                catalog={catalog ?? []} exclusions={exclusions ?? []}
                isAdmin={isAdmin} running={runRules.isPending}
                onRun={() => run([active.id])}
                onClose={() => setSelected(null)}
              />
            ) : (
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-12 text-center sticky top-20">
                <i className="ph-fill ph-cloud-check text-4xl text-slate-300 dark:text-slate-600 mb-3 block"></i>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Select a rule</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Its settings and every resource it checked appear here.
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── shared pieces ─────────────────────────────────────────────────────

const TONES: Record<string, { text: string; bg: string; border: string }> = {
  rose: { text: "text-rose-600 dark:text-rose-400", bg: "bg-rose-50 dark:bg-rose-950/40", border: "border-rose-200 dark:border-rose-900" },
  emerald: { text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/40", border: "border-emerald-200 dark:border-emerald-900" },
  blue: { text: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/40", border: "border-blue-200 dark:border-blue-900" },
  slate: { text: "text-slate-500 dark:text-slate-400", bg: "bg-slate-50 dark:bg-slate-800", border: "border-slate-200 dark:border-slate-700" },
};

function Stat({ icon, tone, value, label }: { icon: string; tone: string; value: number; label: string }) {
  const t = TONES[tone];
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700 px-4 py-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg ${t.bg} ${t.text} flex items-center justify-center shrink-0`}>
        <i className={`ph-fill ${icon} text-lg`}></i>
      </div>
      <div>
        <div className="text-xl font-bold text-slate-900 dark:text-white font-mono leading-none">{value}</div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{label}</div>
      </div>
    </div>
  );
}

function Tag({ children, tone = "slate" }: { children: React.ReactNode; tone?: string }) {
  const t = TONES[tone];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold shrink-0 ${t.bg} ${t.text} ${t.border}`}>{children}</span>;
}

function Banner({ tone, children }: { tone: string; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <div className={`mb-4 px-4 py-3 rounded-xl border text-sm ${t.bg} ${t.border} ${tone === "slate" ? "text-slate-600 dark:text-slate-300" : t.text}`}>
      {children}
    </div>
  );
}

function Panel({ title, subtitle, onClose, actions, children }: {
  title: React.ReactNode; subtitle?: React.ReactNode; onClose?: () => void;
  actions?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col max-h-[calc(100vh-300px)] sticky top-20 animate-scale-in">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-white dark:from-slate-800 dark:to-slate-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold text-slate-900 dark:text-white">{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {actions}
            {onClose && (
              <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-1">
                <i className="ph-bold ph-x"></i>
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 last:border-0">
      <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-400 dark:text-slate-500 mb-3">{title}</h4>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-sm text-slate-500 dark:text-slate-400 shrink-0">{label}</dt>
      <dd className="text-sm text-slate-700 dark:text-slate-300 text-right">{children}</dd>
    </div>
  );
}

function formatValue(value: any, spec: ParamSpec): string {
  if (spec.type === "boolean") return value ? "yes" : "no";
  if (spec.type === "ports") return Array.isArray(value) ? value.join(", ") : String(value);
  if (spec.type === "choice") return spec.options?.find(o => o.value === value)?.label ?? String(value);
  return spec.unit ? `${value} ${spec.unit}` : String(value);
}

const input = "w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

// ── rule detail ───────────────────────────────────────────────────────

function RuleDetail({ rule, entry, findings, catalog, exclusions, isAdmin, running, onRun, onClose }: {
  rule: Guardrail; entry?: CatalogEntry; findings: Finding[]; catalog: CatalogEntry[];
  exclusions: AwsExclusionList[]; isAdmin: boolean; running: boolean;
  onRun: () => void; onClose: () => void;
}) {
  const update = useUpdateGuardrail();
  const remove = useDeleteGuardrail();
  const [editing, setEditing] = useState(false);
  const [showPassing, setShowPassing] = useState(false);

  if (editing && isAdmin) {
    return <RuleEditor rule={rule} catalog={catalog} exclusions={exclusions} onClose={() => setEditing(false)} />;
  }

  const failing = findings.filter(f => f.verdict === "violation" && !f.excluded);
  const rest = findings.filter(f => !(f.verdict === "violation" && !f.excluded));
  const shown = showPassing ? [...failing, ...rest] : failing;
  const used = exclusions.filter(l => rule.exclusionLists?.includes(l.id));

  return (
    <Panel
      title={rule.name}
      subtitle={entry?.summary}
      onClose={onClose}
      actions={isAdmin && (
        <>
          <button onClick={onRun} disabled={running}
            className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-40">Run</button>
          <button onClick={() => setEditing(true)}
            className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
          <button onClick={() => update.mutate({ id: rule.id, body: { enabled: !rule.enabled } })}
            className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white">
            {rule.enabled ? "Pause" : "Resume"}
          </button>
          <button onClick={() => { if (confirm(`Delete "${rule.name}"? Its findings go too.`)) { remove.mutate(rule.id); onClose(); } }}
            className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline">Delete</button>
        </>
      )}
    >
      <Section title="Configuration">
        <dl className="space-y-2">
          <Row label="When it finds a problem">
            {rule.mode === "enforce"
              ? <span className="text-blue-600 dark:text-blue-400 font-semibold">fixes it automatically</span>
              : "records it, changes nothing"}
          </Row>
          {(entry?.paramSchema ?? []).map(s => (
            <Row key={s.key} label={s.label}>{formatValue(rule.params?.[s.key] ?? s.default, s)}</Row>
          ))}
          <Row label="On resource creation">
            {!entry?.createEvents.length ? "not applicable — swept only"
              : rule.applyOnCreate ? "checked immediately" : "waits for the next sweep"}
          </Row>
          {used.length > 0 && <Row label="Skipping">{used.map(l => l.name).join(", ")}</Row>}
        </dl>
      </Section>

      <Section title={`Resources — ${failing.length} failing of ${findings.filter(f => !f.excluded).length} checked`}>
        {findings.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">Not checked yet. Run this rule to populate it.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {shown.slice(0, 100).map(f => (
                <li key={f.resourceId} className="flex items-start gap-2.5">
                  <span className={`w-1.5 h-1.5 rounded-full mt-[7px] shrink-0 ${
                    f.remediated ? "bg-blue-500"
                      : f.excluded ? "bg-slate-300 dark:bg-slate-600"
                        : f.verdict === "violation" ? "bg-rose-500" : "bg-emerald-500"}`} />
                  <div className="min-w-0">
                    <code className="text-xs font-mono text-slate-700 dark:text-slate-300 break-all">{f.resourceId}</code>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {f.summary}
                      {f.proposedFix && !f.remediated && !f.excluded && (
                        <span className="text-slate-400 dark:text-slate-500"> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
                      )}
                    </p>
                    {f.error && <p className="text-xs text-rose-500">{f.error}</p>}
                  </div>
                </li>
              ))}
            </ul>
            {rest.length > 0 && (
              <button onClick={() => setShowPassing(v => !v)}
                className="mt-3 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                {showPassing ? "Hide passing" : `Show ${rest.length} passing and excluded`}
              </button>
            )}
          </>
        )}
      </Section>
    </Panel>
  );
}

// ── rule editor ───────────────────────────────────────────────────────

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
    <Panel title={rule ? `Edit — ${rule.name}` : "New guardrail"} onClose={onClose}>
      <Section title="What to check">
        {rule ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {entry?.title}
            <span className="block text-xs text-slate-400 mt-1">
              Rule type can't change after creation — delete and recreate instead.
            </span>
          </p>
        ) : (
          <>
            <select value={kind} onChange={e => pickKind(e.target.value)} className={input}>
              {catalog.map(c => <option key={c.kind} value={c.kind}>{c.title}</option>)}
            </select>
            {entry && <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">{entry.summary}</p>}
          </>
        )}
      </Section>

      <Section title="Name">
        <input value={name} onChange={e => setName(e.target.value)} className={input} />
      </Section>

      {(entry?.paramSchema ?? []).length > 0 && (
        <Section title="Settings">
          <div className="space-y-4">
            {entry!.paramSchema.map(spec => (
              <ParamControl key={spec.key} spec={spec}
                value={params[spec.key] ?? spec.default}
                onChange={v => setParams(p => ({ ...p, [spec.key]: v }))} />
            ))}
          </div>
        </Section>
      )}

      <Section title="When it finds a problem">
        <div className="space-y-2">
          <ModeOption active={mode === "report"} onClick={() => setMode("report")}
            title="Report it" body="Records the finding. Nothing in AWS changes." />
          <ModeOption active={mode === "enforce"} disabled={!entry?.canRemediate}
            onClick={() => entry?.canRemediate && setMode("enforce")}
            title="Fix it automatically"
            body={entry?.canRemediate
              ? "Changes the resource on every sweep, with nobody watching."
              : "Unavailable for this check — fixing it automatically could cut live access."} />
        </div>
      </Section>

      {!!entry?.createEvents.length && (
        <Section title="Timing">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={applyOnCreate} onChange={e => setApplyOnCreate(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 dark:border-slate-600" />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Check as soon as a resource is created
              <span className="block text-xs text-slate-400 dark:text-slate-500">
                Otherwise it waits for the next sweep, up to 15 minutes.
              </span>
            </span>
          </label>
        </Section>
      )}

      {exclusions.length > 0 && (
        <Section title="Skip resources in">
          <div className="space-y-1.5">
            {exclusions.map(l => (
              <label key={l.id} className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" checked={picked.includes(l.id)}
                  onChange={e => setPicked(s => e.target.checked ? [...s, l.id] : s.filter(x => x !== l.id))}
                  className="rounded border-slate-300 dark:border-slate-600" />
                {l.name}
              </label>
            ))}
          </div>
        </Section>
      )}

      <div className="px-5 py-4 flex items-center gap-2">
        <button onClick={submit}
          className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90">
          {rule ? "Save changes" : "Create rule"}
        </button>
        <button onClick={onClose}
          className="px-3 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
        {error && <span className="text-xs text-rose-600 dark:text-rose-400 ml-2">{error}</span>}
      </div>
    </Panel>
  );
}

function ModeOption({ active, onClick, title, body, disabled }: {
  active: boolean; onClick: () => void; title: string; body: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`w-full text-left px-3.5 py-2.5 rounded-lg border transition-colors ${
        active ? "border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950/30"
               : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
      } ${disabled ? "opacity-50 cursor-not-allowed hover:border-slate-200 dark:hover:border-slate-700" : ""}`}>
      <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {disabled && <i className="ph-fill ph-lock-simple text-xs"></i>}{title}
      </span>
      <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">{body}</span>
    </button>
  );
}

function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: any; onChange: (v: any) => void }) {
  if (spec.type === "boolean") {
    return (
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
          className="mt-0.5 rounded border-slate-300 dark:border-slate-600" />
        <span className="text-sm text-slate-700 dark:text-slate-300">
          {spec.label}
          {spec.help && <span className="block text-xs text-slate-400 dark:text-slate-500">{spec.help}</span>}
        </span>
      </label>
    );
  }
  return (
    <label className="block">
      <span className="block text-sm text-slate-700 dark:text-slate-300 mb-1.5">{spec.label}</span>
      <span className="flex items-center gap-2">
        {spec.type === "number" && spec.allowed ? (
          <select value={value} onChange={e => onChange(Number(e.target.value))} className={`${input} w-36`}>
            {spec.allowed.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : spec.type === "number" ? (
          <input type="number" min={spec.min} value={value} onChange={e => onChange(Number(e.target.value))} className={`${input} w-36`} />
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
        {spec.unit && <span className="text-sm text-slate-500 dark:text-slate-400 shrink-0">{spec.unit}</span>}
      </span>
      {spec.help && <span className="block text-xs text-slate-400 dark:text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}

// ── exclusion lists ───────────────────────────────────────────────────

function ExclusionsPanel({ lists, isAdmin }: { lists: AwsExclusionList[]; isAdmin: boolean }) {
  const save = useSaveAwsExclusion();
  const remove = useDeleteAwsExclusion();
  const [editing, setEditing] = useState<AwsExclusionList | "new" | null>(null);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-5 items-start">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Resources matched here are skipped by any rule using the list.
          </p>
          {isAdmin && (
            <button onClick={() => setEditing("new")}
              className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0">
              <i className="ph-bold ph-plus mr-1"></i>New
            </button>
          )}
        </div>
        {lists.length === 0 ? (
          <div className="p-10 text-center">
            <i className="ph-fill ph-prohibit text-4xl text-slate-300 dark:text-slate-600 mb-3 block"></i>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">No exclusion lists</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Skip resources by name, prefix, substring or tag.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50 dark:divide-slate-800">
            {lists.map(l => (
              <div key={l.id} className="px-5 py-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{l.name}</span>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {l.resources.map(r => <Tag key={r} tone="slate">{r}</Tag>)}
                    {l.patterns.map(p => <Tag key={p.id} tone="blue">{p.type.replace(/_/g, " ")} {p.value}</Tag>)}
                    {l.whitelist.map(w => <Tag key={w} tone="emerald">keep {w}</Tag>)}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-3 shrink-0">
                    <button onClick={() => setEditing(l)}
                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                    <button onClick={() => { if (confirm(`Delete "${l.name}"?`)) remove.mutate(l.id); }}
                      className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline">Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && isAdmin && (
        <ExclusionEditor list={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(body, id) => save.mutateAsync({ id, body }).then(() => setEditing(null))} />
      )}
    </div>
  );
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
    <Panel title={list ? `Edit — ${list.name}` : "New exclusion list"} onClose={onClose}>
      <Section title="Name"><input value={name} onChange={e => setName(e.target.value)} className={input} /></Section>
      <Section title="Exact names">
        <textarea rows={3} value={resources} onChange={e => setResources(e.target.value)} className={`${input} font-mono text-xs`} />
        <p className="text-xs text-slate-400 mt-1">One per line.</p>
      </Section>
      <Section title="Patterns">
        <textarea rows={3} value={patterns} onChange={e => setPatterns(e.target.value)} className={`${input} font-mono text-xs`}
          placeholder={"starts_with:tmp-\ncontains:sandbox\ntag_equals:Env=dev"} />
      </Section>
      <Section title="Keep anyway">
        <textarea rows={2} value={whitelist} onChange={e => setWhitelist(e.target.value)} className={`${input} font-mono text-xs`} />
        <p className="text-xs text-slate-400 mt-1">Wins over the patterns above.</p>
      </Section>
      <div className="px-5 py-4 flex items-center gap-2">
        <button onClick={submit}
          className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90">Save</button>
        <button onClick={onClose}
          className="px-3 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
        {error && <span className="text-xs text-rose-600 dark:text-rose-400 ml-2">{error}</span>}
      </div>
    </Panel>
  );
}
