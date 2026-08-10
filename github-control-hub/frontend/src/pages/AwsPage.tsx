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
 * A compliance register: two summary cards, a filter row, then one wide table
 * of every rule. Rows carry a primary line and a quieter secondary line, and
 * status reads as an icon plus a short phrase. Selecting a rule replaces the
 * table with its detail rather than splitting the width.
 */

const relTime = (iso?: string) => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

type RuleRow = {
  rule: Guardrail;
  entry?: CatalogEntry;
  findings: Finding[];
  failing: number;
  checked: number;
  excluded: number;
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
  const [view, setView] = useState<{ kind: "table" } | { kind: "rule"; id: string } | { kind: "new" } | { kind: "exclusions" }>({ kind: "table" });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [mode, setMode] = useState("all");
  const [error, setError] = useState<string | null>(null);

  const rows: RuleRow[] = useMemo(() => {
    const byRule = new Map<string, Finding[]>();
    (findings ?? []).forEach(f => byRule.set(f.ruleId, [...(byRule.get(f.ruleId) ?? []), f]));
    return (rules ?? []).map(rule => {
      const f = byRule.get(rule.id) ?? [];
      return {
        rule,
        entry: (catalog ?? []).find(c => c.kind === rule.kind),
        findings: f,
        failing: f.filter(x => x.verdict === "violation" && !x.excluded).length,
        checked: f.filter(x => !x.excluded).length,
        excluded: f.filter(x => x.excluded).length,
      };
    });
  }, [rules, findings, catalog]);

  const totals = useMemo(() => {
    const f = findings ?? [];
    const passing = f.filter(x => x.verdict === "compliant").length;
    const failing = f.filter(x => x.verdict === "violation" && !x.excluded).length;
    const excluded = f.filter(x => x.excluded).length;
    const total = passing + failing;
    return {
      passing, failing, excluded, total,
      pct: total ? Math.round((passing / total) * 100) : 0,
      autoFixable: rows.filter(r => r.failing > 0 && r.entry?.canRemediate && r.rule.mode === "report").reduce((n, r) => n + r.failing, 0),
      enforcing: rows.filter(r => r.rule.enabled && r.rule.mode === "enforce").length,
      lastRun: f.reduce<string | undefined>((a, x) => (!a || x.checkedAt > a ? x.checkedAt : a), undefined),
    };
  }, [findings, rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (status === "failing" && r.failing === 0) return false;
      if (status === "passing" && (r.failing > 0 || r.checked === 0)) return false;
      if (status === "unchecked" && r.checked > 0) return false;
      if (mode === "enforce" && r.rule.mode !== "enforce") return false;
      if (mode === "report" && r.rule.mode !== "report") return false;
      if (mode === "paused" && r.rule.enabled) return false;
      if (!q) return true;
      return r.rule.name.toLowerCase().includes(q)
        || (r.entry?.summary ?? "").toLowerCase().includes(q)
        || r.findings.some(f => f.resourceId.toLowerCase().includes(q));
    });
  }, [rows, search, status, mode]);

  const run = async (ruleIds?: string[]) => {
    setError(null);
    try { await runRules.mutateAsync({ ruleIds }); }
    catch (e) { setError((e as Error).message); }
  };

  const activeRow = view.kind === "rule" ? rows.find(r => r.rule.id === view.id) : undefined;
  const filtersOn = search !== "" || status !== "all" || mode !== "all";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-[1500px] mx-auto px-6 py-7">

        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-[26px] font-bold text-slate-900 dark:text-white tracking-tight">AWS Guardrails</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Checked on creation, every 15 minutes, and on demand.
              {totals.lastRun && <> Last swept {relTime(totals.lastRun)}.</>}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setView({ kind: "exclusions" })}
              className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              Exclusion lists
              <span className="ml-1.5 text-slate-400 font-mono">{exclusions?.length ?? 0}</span>
            </button>
            {isAdmin && (
              <>
                <button onClick={() => setView({ kind: "new" })}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  New rule
                </button>
                <button onClick={() => run()} disabled={runRules.isPending}
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
                  {runRules.isPending ? "Running…" : "Run all"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <Card>
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Passing</h2>
              <span className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{totals.passing}</span>
            </div>
            <p className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums mb-3">{totals.pct}%</p>
            <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${totals.pct}%` }} />
            </div>
            <div className="flex justify-between mt-2 text-sm text-slate-500 dark:text-slate-400 tabular-nums">
              <span>{totals.passing} passing</span>
              <span>{totals.total} checked</span>
            </div>
          </Card>

          <Card>
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Needs attention</h2>
              <span className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{totals.failing}</span>
            </div>
            <div className="space-y-2.5">
              <AttentionRow icon="ph-warning-octagon" tone="text-rose-500"
                label="Failing checks" value={totals.failing} />
              <AttentionRow icon="ph-wrench" tone="text-amber-500"
                label="Fixable automatically, currently report-only" value={totals.autoFixable} />
              <AttentionRow icon="ph-prohibit" tone="text-slate-400"
                label="Excluded by a list" value={totals.excluded} />
            </div>
          </Card>
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
            <span className="font-semibold">{adminTeam}</span> team — they change the whole AWS account.
          </Banner>
        )}

        {view.kind === "exclusions" ? (
          <ExclusionsView lists={exclusions ?? []} isAdmin={isAdmin} onBack={() => setView({ kind: "table" })} />
        ) : view.kind === "new" ? (
          <RuleEditor rule={null} catalog={catalog ?? []} exclusions={exclusions ?? []}
            onClose={() => setView({ kind: "table" })} />
        ) : activeRow ? (
          <RuleDetail row={activeRow} catalog={catalog ?? []} exclusions={exclusions ?? []}
            isAdmin={isAdmin} running={runRules.isPending}
            onRun={() => run([activeRow.rule.id])}
            onBack={() => setView({ kind: "table" })} />
        ) : (
          <>
            {/* Filters */}
            <div className="flex items-center gap-3 flex-wrap mb-4">
              <div className="relative">
                <i className="ph-bold ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search rules and resources"
                  className="w-72 pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
              </div>
              <span className="text-sm text-slate-400 dark:text-slate-500">Filter by</span>
              <Chip label="Status" value={status} onChange={setStatus}
                options={[["all", "Any status"], ["failing", "Failing"], ["passing", "Passing"], ["unchecked", "Not checked"]]} />
              <Chip label="Mode" value={mode} onChange={setMode}
                options={[["all", "Any mode"], ["enforce", "Auto-fixing"], ["report", "Report only"], ["paused", "Paused"]]} />
              {filtersOn && (
                <button onClick={() => { setSearch(""); setStatus("all"); setMode("all"); }}
                  className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                  <i className="ph-bold ph-x mr-1 text-xs"></i>Clear
                </button>
              )}
            </div>

            {/* Table */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              {isLoading ? (
                <div className="p-12 flex justify-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 dark:border-slate-700 border-t-slate-600"></div>
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-14 text-center">
                  <p className="text-base font-semibold text-slate-700 dark:text-slate-200">
                    {rows.length === 0 ? "No guardrails yet" : "Nothing matches those filters"}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    {rows.length === 0
                      ? `${catalog?.length ?? 0} rule types are available to add.`
                      : "Try clearing the search or filters."}
                  </p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <Th className="pl-6">Rule</Th>
                      <Th>Resource</Th>
                      <Th>Mode</Th>
                      <Th>On creation</Th>
                      <Th className="pr-6">Status</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filtered.map(r => (
                      <tr key={r.rule.id}
                        onClick={() => setView({ kind: "rule", id: r.rule.id })}
                        className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="pl-6 py-5 pr-6">
                          <p className={`text-[15px] font-semibold ${r.rule.enabled ? "text-slate-900 dark:text-white" : "text-slate-400 dark:text-slate-500"}`}>
                            {r.rule.name}
                          </p>
                          <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {r.entry?.summary ?? r.rule.kind}
                          </p>
                        </td>
                        <td className="py-5 pr-6 text-[14px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {resourceLabel(r.entry?.resourceType)}
                        </td>
                        <td className="py-5 pr-6 whitespace-nowrap">
                          {!r.rule.enabled
                            ? <span className="text-[14px] text-slate-400">Paused</span>
                            : r.rule.mode === "enforce"
                              ? <span className="text-[14px] text-blue-600 dark:text-blue-400 font-medium">Auto-fixing</span>
                              : <span className="text-[14px] text-slate-600 dark:text-slate-300">Report only</span>}
                        </td>
                        <td className="py-5 pr-6 text-[14px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {!r.entry?.createEvents.length ? "—" : r.rule.applyOnCreate ? "Immediate" : "Next sweep"}
                        </td>
                        <td className="py-5 pr-6 whitespace-nowrap">
                          <StatusCell failing={r.failing} checked={r.checked} excluded={r.excluded} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── presentation helpers ──────────────────────────────────────────────

function resourceLabel(type?: string): string {
  switch (type) {
    case "s3:bucket": return "S3 buckets";
    case "logs:log-group": return "Log groups";
    case "ec2:security-group": return "Security groups";
    case "ec2:instance": return "EC2 instances";
    case "rds:db-instance": return "RDS instances";
    case "ec2:account": return "Account (EC2)";
    case "iam:account": return "Account (IAM)";
    case "cloudtrail:account": return "Account (CloudTrail)";
    default: return type ?? "—";
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-6">{children}</div>;
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`text-left text-[11px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500 py-3.5 pr-6 ${className}`}>
      {children}
    </th>
  );
}

function AttentionRow({ icon, tone, label, value }: { icon: string; tone: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-2.5 text-[14px] text-slate-700 dark:text-slate-300">
        <i className={`ph-fill ${icon} ${tone} text-lg`}></i>{label}
      </span>
      <span className="text-[15px] font-semibold leading-snug text-slate-900 dark:text-white tabular-nums">{value}</span>
    </div>
  );
}

function StatusCell({ failing, checked, excluded }: { failing: number; checked: number; excluded: number }) {
  if (checked === 0 && excluded === 0) {
    return <span className="text-[14px] text-slate-400">Not checked</span>;
  }
  if (failing > 0) {
    return (
      <div>
        <span className="flex items-center gap-2 text-[14px] font-medium text-slate-900 dark:text-white">
          <i className="ph-fill ph-warning-octagon text-rose-500 text-lg"></i>
          {failing} failing
        </span>
        <span className="block text-[13px] text-slate-500 dark:text-slate-400 ml-7">
          of {checked} checked{excluded > 0 && `, ${excluded} excluded`}
        </span>
      </div>
    );
  }
  return (
    <div>
      <span className="flex items-center gap-2 text-[14px] font-medium text-slate-900 dark:text-white">
        <i className="ph-fill ph-check-circle text-emerald-500 text-lg"></i>OK
      </span>
      <span className="block text-[13px] text-slate-500 dark:text-slate-400 ml-7">
        {checked} checked{excluded > 0 && `, ${excluded} excluded`}
      </span>
    </div>
  );
}

function Chip({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = value !== "all";
  const current = options.find(([v]) => v === value)?.[1];

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-2 pl-3.5 pr-3 py-2 text-sm font-semibold rounded-lg border transition-colors ${
          on ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
             : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
        {on ? current : label}
        <i className={`ph-bold ph-caret-${open ? "up" : "down"} text-[10px] opacity-60`}></i>
      </button>
      {open && (
        <>
          {/* Click-away catcher, so the menu closes without a document listener. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-20 min-w-[180px] py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg">
            {options.map(([v, text]) => (
              <button key={v} onClick={() => { onChange(v); setOpen(false); }}
                className={`w-full text-left px-3.5 py-2 text-sm transition-colors flex items-center justify-between gap-3 ${
                  v === value ? "text-slate-900 dark:text-white font-semibold" : "text-slate-600 dark:text-slate-300"
                } hover:bg-slate-50 dark:hover:bg-slate-800`}>
                {text}
                {v === value && <i className="ph-bold ph-check text-xs text-blue-600 dark:text-blue-400"></i>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const TONES: Record<string, string> = {
  rose: "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300",
  emerald: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300",
  slate: "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300",
};

function Banner({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <div className={`mb-4 px-4 py-3 rounded-lg border text-sm ${TONES[tone]}`}>{children}</div>;
}

function BackLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors">
      <i className="ph-bold ph-arrow-left text-xs"></i>{children}
    </button>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function formatValue(value: any, spec: ParamSpec): string {
  if (spec.type === "boolean") return value ? "Yes" : "No";
  if (spec.type === "ports") return Array.isArray(value) ? value.join(", ") : String(value);
  if (spec.type === "choice") return spec.options?.find(o => o.value === value)?.label ?? String(value);
  return spec.unit ? `${value} ${spec.unit}` : String(value);
}

const input = "w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

// ── rule detail ───────────────────────────────────────────────────────

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
      <BackLink onClick={onBack}>All rules</BackLink>
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{rule.name}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{entry?.summary}</p>
          </div>
          <div className="shrink-0"><StatusCell failing={failing} checked={checked} excluded={excluded} /></div>
        </div>

        {isAdmin && (
          <div className="px-6 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-4 bg-slate-50/60 dark:bg-slate-800/30">
            <button onClick={onRun} disabled={running}
              className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white disabled:opacity-40">
              {running ? "Running…" : "Run now"}
            </button>
            <button onClick={() => setEditing(true)} className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
            <button onClick={() => update.mutate({ id: rule.id, body: { enabled: !rule.enabled } })}
              className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white">
              {rule.enabled ? "Pause" : "Resume"}
            </button>
            <button onClick={() => { if (confirm(`Delete "${rule.name}"? Its findings go too.`)) { remove.mutate(rule.id); onBack(); } }}
              className="text-sm font-semibold text-rose-600 dark:text-rose-400 hover:underline ml-auto">Delete</button>
          </div>
        )}

        <Section title="Configuration">
          <dl className="grid sm:grid-cols-2 gap-x-10 gap-y-2.5">
            <Row label="When it finds a problem">
              {rule.mode === "enforce"
                ? <span className="text-blue-600 dark:text-blue-400 font-medium">Fixes it automatically</span>
                : "Records it, changes nothing"}
            </Row>
            {(entry?.paramSchema ?? []).map(s => (
              <Row key={s.key} label={s.label}>{formatValue(rule.params?.[s.key] ?? s.default, s)}</Row>
            ))}
            <Row label="On resource creation">
              {!entry?.createEvents.length ? "Not applicable — swept only"
                : rule.applyOnCreate ? "Checked immediately" : "Waits for the next sweep"}
            </Row>
            {used.length > 0 && <Row label="Skipping">{used.map(l => l.name).join(", ")}</Row>}
          </dl>
        </Section>

        <Section
          title={`Resources — ${failing} failing of ${checked} checked`}
          action={rest.length > 0 && (
            <button onClick={() => setShowPassing(v => !v)}
              className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
              {showPassing ? "Hide passing" : `Show ${rest.length} passing`}
            </button>
          )}>
          {findings.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Not checked yet. Run this rule to populate it.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 -mx-2">
              {shown.slice(0, 200).map(f => (
                <li key={f.resourceId} className="flex items-start gap-3 py-2.5 px-2">
                  <i className={`text-base mt-0.5 shrink-0 ${
                    f.remediated ? "ph-fill ph-wrench text-blue-500"
                      : f.excluded ? "ph-fill ph-prohibit text-slate-300 dark:text-slate-600"
                        : f.verdict === "violation" ? "ph-fill ph-warning-octagon text-rose-500"
                          : "ph-fill ph-check-circle text-emerald-500"}`}></i>
                  <div className="min-w-0">
                    <p className="text-[14px] text-slate-800 dark:text-slate-100 font-mono break-all">{f.resourceId}</p>
                    <p className="text-[13px] text-slate-500 dark:text-slate-400">
                      {f.summary}
                      {f.proposedFix && !f.remediated && !f.excluded && (
                        <span> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
                      )}
                    </p>
                    {f.error && <p className="text-[13px] text-rose-500">{f.error}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-slate-50 dark:border-slate-800/50 pb-2">
      <dt className="text-[14px] text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-[14px] text-slate-800 dark:text-slate-200 text-right">{children}</dd>
    </div>
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
      <BackLink onClick={onClose}>{rule ? "Back to rule" : "All rules"}</BackLink>
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden max-w-3xl">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{rule ? `Edit — ${rule.name}` : "New guardrail"}</h2>
        </div>

        <Section title="What to check">
          {rule ? (
            <p className="text-sm text-slate-700 dark:text-slate-200">
              {entry?.title}
              <span className="block text-[13px] text-slate-400 mt-1">
                Rule type can't change after creation — delete and recreate instead.
              </span>
            </p>
          ) : (
            <>
              <select value={kind} onChange={e => pickKind(e.target.value)} className={`${input} max-w-md`}>
                {catalog.map(c => <option key={c.kind} value={c.kind}>{c.title}</option>)}
              </select>
              {entry && <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-2">{entry.summary}</p>}
            </>
          )}
        </Section>

        <Section title="Name">
          <input value={name} onChange={e => setName(e.target.value)} className={`${input} max-w-md`} />
        </Section>

        {(entry?.paramSchema ?? []).length > 0 && (
          <Section title="Settings">
            <div className="space-y-4 max-w-md">
              {entry!.paramSchema.map(spec => (
                <ParamControl key={spec.key} spec={spec}
                  value={params[spec.key] ?? spec.default}
                  onChange={v => setParams(p => ({ ...p, [spec.key]: v }))} />
              ))}
            </div>
          </Section>
        )}

        <Section title="When it finds a problem">
          <div className="space-y-2 max-w-md">
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
                <span className="block text-[13px] text-slate-400 dark:text-slate-500">
                  Otherwise it waits for the next sweep, up to 15 minutes.
                </span>
              </span>
            </label>
          </Section>
        )}

        {exclusions.length > 0 && (
          <Section title="Skip resources in">
            <div className="space-y-2">
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

        <div className="px-6 py-5 flex items-center gap-3">
          <button onClick={submit}
            className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90">
            {rule ? "Save changes" : "Create rule"}
          </button>
          <button onClick={onClose}
            className="text-sm font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
          {error && <span className="text-[13px] text-rose-600 dark:text-rose-400">{error}</span>}
        </div>
      </div>
    </>
  );
}

function ModeOption({ active, onClick, title, body, disabled }: {
  active: boolean; onClick: () => void; title: string; body: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
        active ? "border-blue-400 dark:border-blue-600 bg-blue-50/60 dark:bg-blue-950/30"
               : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
      } ${disabled ? "opacity-50 cursor-not-allowed hover:border-slate-200 dark:hover:border-slate-700" : ""}`}>
      <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
        {disabled && <i className="ph-fill ph-lock-simple text-xs"></i>}{title}
      </span>
      <span className="block text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">{body}</span>
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
          {spec.help && <span className="block text-[13px] text-slate-400 dark:text-slate-500">{spec.help}</span>}
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
      {spec.help && <span className="block text-[13px] text-slate-400 dark:text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}

// ── exclusion lists ───────────────────────────────────────────────────

function ExclusionsView({ lists, isAdmin, onBack }: {
  lists: AwsExclusionList[]; isAdmin: boolean; onBack: () => void;
}) {
  const save = useSaveAwsExclusion();
  const remove = useDeleteAwsExclusion();
  const [editing, setEditing] = useState<AwsExclusionList | "new" | null>(null);

  if (editing && isAdmin) {
    return (
      <ExclusionEditor list={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSave={(body, id) => save.mutateAsync({ id, body }).then(() => setEditing(null))} />
    );
  }

  return (
    <>
      <BackLink onClick={onBack}>All rules</BackLink>
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Exclusion lists</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Resources matched here are skipped by any rule using the list.
            </p>
          </div>
          {isAdmin && (
            <button onClick={() => setEditing("new")}
              className="px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90 shrink-0">
              New list
            </button>
          )}
        </div>
        {lists.length === 0 ? (
          <div className="p-14 text-center">
            <p className="text-base font-semibold text-slate-700 dark:text-slate-200">No exclusion lists</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Skip resources by exact name, prefix, substring or tag.
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <Th className="pl-6">Name</Th>
                <Th>Matches</Th>
                <Th className="pr-6">{isAdmin ? "Actions" : ""}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {lists.map(l => (
                <tr key={l.id}>
                  <td className="pl-6 py-4 pr-4 text-[15px] font-semibold text-slate-900 dark:text-white align-top">{l.name}</td>
                  <td className="py-4 pr-4">
                    <div className="flex flex-wrap gap-1.5">
                      {l.resources.map(r => <Pill key={r} tone="slate">{r}</Pill>)}
                      {l.patterns.map(p => <Pill key={p.id} tone="blue">{p.type.replace(/_/g, " ")} {p.value}</Pill>)}
                      {l.whitelist.map(w => <Pill key={w} tone="emerald">keep {w}</Pill>)}
                    </div>
                  </td>
                  <td className="py-4 pr-6 align-top whitespace-nowrap">
                    {isAdmin && (
                      <span className="flex gap-3">
                        <button onClick={() => setEditing(l)} className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                        <button onClick={() => { if (confirm(`Delete "${l.name}"?`)) remove.mutate(l.id); }}
                          className="text-sm font-semibold text-rose-600 dark:text-rose-400 hover:underline">Delete</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={`text-[12px] font-mono px-2 py-0.5 rounded border ${TONES[tone]}`}>{children}</span>;
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
      <BackLink onClick={onClose}>Exclusion lists</BackLink>
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden max-w-2xl">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {list ? `Edit — ${list.name}` : "New exclusion list"}
          </h2>
        </div>
        <Section title="Name"><input value={name} onChange={e => setName(e.target.value)} className={`${input} max-w-sm`} /></Section>
        <Section title="Exact names">
          <textarea rows={3} value={resources} onChange={e => setResources(e.target.value)} className={`${input} font-mono text-[13px]`} />
          <p className="text-[13px] text-slate-400 mt-1.5">One per line.</p>
        </Section>
        <Section title="Patterns">
          <textarea rows={3} value={patterns} onChange={e => setPatterns(e.target.value)} className={`${input} font-mono text-[13px]`}
            placeholder={"starts_with:tmp-\ncontains:sandbox\ntag_equals:Env=dev"} />
        </Section>
        <Section title="Keep anyway">
          <textarea rows={2} value={whitelist} onChange={e => setWhitelist(e.target.value)} className={`${input} font-mono text-[13px]`} />
          <p className="text-[13px] text-slate-400 mt-1.5">Wins over the patterns above.</p>
        </Section>
        <div className="px-6 py-5 flex items-center gap-3">
          <button onClick={submit}
            className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90">Save</button>
          <button onClick={onClose}
            className="text-sm font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
          {error && <span className="text-[13px] text-rose-600 dark:text-rose-400">{error}</span>}
        </div>
      </div>
    </>
  );
}
