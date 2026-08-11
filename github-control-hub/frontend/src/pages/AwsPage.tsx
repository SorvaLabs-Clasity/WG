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

const KIND_LABELS: Record<string, string> = {
  s3_https_only: "S3 — deny non-TLS requests",
  log_retention_min: "CloudWatch Logs — minimum retention",
  s3_block_public_access: "S3 — block public access",
  s3_default_encryption: "S3 — default encryption",
  s3_versioning: "S3 — versioning enabled",
  ebs_encryption_default: "EBS — encryption by default",
  rds_backup_retention_min: "RDS — minimum backup retention",
  iam_password_policy: "IAM — account password policy",
  sg_no_public_admin_ingress: "Security groups — no public admin ports",
  rds_no_public_access: "RDS — not publicly accessible",
  ec2_imdsv2_required: "EC2 — IMDSv2 required",
  cloudtrail_enabled: "CloudTrail — enabled and logging",
};

const label = (kind: string) => KIND_LABELS[kind] ?? kind;

export default function AwsPage() {
  const { user } = useAuth();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;

  const { data: catalog } = useCatalog();
  const { data: rules, isLoading } = useGuardrails();
  const { data: findings } = useFindings();
  const { data: exclusions } = useAwsExclusions();

  const runRules = useRunGuardrails();
  const deleteRule = useDeleteGuardrail();
  const updateRule = useUpdateGuardrail();

  const [tab, setTab] = useState<"rules" | "findings" | "exclusions">("rules");
  const [editing, setEditing] = useState<Guardrail | "new" | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const stats = useMemo(() => {
    const f = findings ?? [];
    return {
      violations: f.filter(x => x.verdict === "violation").length,
      compliant: f.filter(x => x.verdict === "compliant").length,
      excluded: f.filter(x => x.excluded).length,
      enforcing: (rules ?? []).filter(r => r.enabled && r.mode === "enforce").length,
    };
  }, [findings, rules]);

  const doRun = async (ruleIds?: string[]) => {
    setRunError(null);
    try {
      await runRules.mutateAsync({ ruleIds });
    } catch (e) {
      setRunError((e as Error).message);
    }
  };

  return (
    <div className="min-h-screen pt-14 bg-slate-50 dark:bg-slate-950">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-[1500px] mx-auto px-6 py-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">AWS Guardrails</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Rules that keep AWS resources compliant — checked on creation, on a 15-minute sweep, and on demand.
            </p>
          </div>
          <button
            onClick={() => doRun()}
            disabled={runRules.isPending}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
          >
            <i className={runRules.isPending ? "ph-bold ph-circle-notch animate-spin" : "ph-bold ph-play"}></i>
            {runRules.isPending ? "Running…" : "Run all now"}
          </button>
        </div>

        {runError && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-sm text-rose-700 dark:text-rose-300">
            {runError}
          </div>
        )}
        {runRules.isSuccess && !runError && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-sm text-emerald-700 dark:text-emerald-300">
            Checked {runRules.data.findings.length} resources — {runRules.data.violations} violation(s),
            {" "}{runRules.data.remediated} remediated, {runRules.data.excluded} excluded.
            {runRules.data.errors.length > 0 && ` ${runRules.data.errors.length} error(s).`}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          {[
            { label: "Violations", value: stats.violations, icon: "ph-warning", tone: "text-rose-500" },
            { label: "Compliant", value: stats.compliant, icon: "ph-check-circle", tone: "text-emerald-500" },
            { label: "Excluded", value: stats.excluded, icon: "ph-prohibit", tone: "text-slate-400" },
            { label: "Enforcing rules", value: stats.enforcing, icon: "ph-lock-key", tone: "text-blue-500" },
          ].map(s => (
            <div key={s.label} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700 px-4 py-3 flex items-center gap-3">
              <i className={`ph-fill ${s.icon} text-lg ${s.tone}`}></i>
              <div>
                <div className="text-xl font-bold text-slate-900 dark:text-white font-mono leading-none">{s.value}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-1 mb-4 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg w-fit">
          {([["rules", "Rules"], ["findings", "Findings"], ["exclusions", "Exclusion lists"]] as const).map(([id, text]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${
                tab === id ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm"
                           : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}
            >{text}</button>
          ))}
        </div>

        {tab === "rules" && (
          <RulesTab
            rules={rules} catalog={catalog} isLoading={isLoading} isAdmin={isAdmin}
            adminTeam={permissions?.awsAdminTeam ?? "aws-guardrail-admins"}
            onEdit={setEditing} onNew={() => setEditing("new")}
            onDelete={(id) => deleteRule.mutate(id)}
            onToggleEnabled={(r) => updateRule.mutate({ id: r.id, body: { enabled: !r.enabled } })}
            onRun={(id) => doRun([id])}
            running={runRules.isPending}
          />
        )}
        {tab === "findings" && <FindingsTab findings={findings} />}
        {tab === "exclusions" && <ExclusionsTab lists={exclusions} />}

        {editing && (
          <RuleEditor
            rule={editing === "new" ? null : editing}
            catalog={catalog ?? []}
            exclusions={exclusions ?? []}
            isAdmin={isAdmin}
            adminTeam={permissions?.awsAdminTeam ?? "aws-guardrail-admins"}
            onClose={() => setEditing(null)}
          />
        )}
      </main>
    </div>
  );
}

// ── Rules ─────────────────────────────────────────────────────────────

function RulesTab({ rules, catalog, isLoading, isAdmin, adminTeam, onEdit, onNew, onDelete, onToggleEnabled, onRun, running }: {
  rules?: Guardrail[]; catalog?: CatalogEntry[]; isLoading: boolean; isAdmin: boolean; adminTeam: string;
  onEdit: (r: Guardrail) => void; onNew: () => void; onDelete: (id: string) => void;
  onToggleEnabled: (r: Guardrail) => void; onRun: (id: string) => void; running: boolean;
}) {
  const byKind = new Map((catalog ?? []).map(c => [c.kind, c]));

  if (isLoading) {
    return <div className="p-10 flex justify-center"><div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 dark:border-slate-700 border-t-slate-600"></div></div>;
  }

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{rules?.length ?? 0} rule(s)</span>
        <button onClick={onNew} className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
          <i className="ph-bold ph-plus mr-1"></i>New rule
        </button>
      </div>

      {!rules?.length ? (
        <div className="p-12 text-center text-slate-400 dark:text-slate-500">
          <i className="ph-fill ph-shield-check text-4xl mb-3 block"></i>
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No guardrails yet</p>
          <p className="text-xs mt-1">Add one from the {catalog?.length ?? 0} available rule types.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-50 dark:divide-slate-800">
          {rules.map(r => {
            const entry = byKind.get(r.kind);
            return (
              <div key={r.id} className="px-5 py-4 flex items-start gap-4">
                <button
                  onClick={() => onToggleEnabled(r)}
                  title={r.enabled ? "Disable" : "Enable"}
                  className={`mt-1 w-9 h-5 rounded-full shrink-0 transition relative ${r.enabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${r.enabled ? "left-[18px]" : "left-0.5"}`}></span>
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                      r.mode === "enforce"
                        ? "bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
                        : "bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700"}`}>
                      {r.mode}
                    </span>
                    {r.applyOnCreate && <span className="text-[10px] px-1.5 py-0.5 rounded border bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700">on create</span>}
                    {entry && !entry.canRemediate && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900" title="Fixing this automatically could cut live access">report-only</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{label(r.kind)}</p>
                  {Object.keys(r.params ?? {}).length > 0 && (
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-1">
                      {Object.entries(r.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ")}
                    </p>
                  )}
                  {r.exclusionLists?.length > 0 && (
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                      <i className="ph-bold ph-prohibit mr-1"></i>{r.exclusionLists.length} exclusion list(s)
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => onRun(r.id)} disabled={running}
                    className="text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-40">Run</button>
                  <button onClick={() => onEdit(r)}
                    className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                  <button onClick={() => { if (confirm(`Delete "${r.name}"?`)) onDelete(r.id); }}
                    className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isAdmin && (
        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
          <i className="ph-fill ph-lock-simple mr-1"></i>
          You can create and edit rules in report mode. Putting a rule into <strong>enforce</strong> mode — which changes
          AWS resources automatically — requires the <span className="font-mono">{adminTeam}</span> team.
        </div>
      )}
    </div>
  );
}

// ── Findings ──────────────────────────────────────────────────────────

function FindingsTab({ findings }: { findings?: Finding[] }) {
  const [showCompliant, setShowCompliant] = useState(false);
  const rows = (findings ?? []).filter(f => showCompliant || f.verdict !== "compliant");

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{rows.length} finding(s)</span>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={showCompliant} onChange={e => setShowCompliant(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-600" />
          Show compliant
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="p-12 text-center text-slate-400 dark:text-slate-500">
          <i className="ph-fill ph-check-circle text-4xl mb-3 block text-emerald-400"></i>
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Nothing to report</p>
          <p className="text-xs mt-1">Run the guardrails to populate this.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[11px] uppercase text-slate-500 dark:text-slate-400">
              <tr>
                <th className="text-left font-semibold px-5 py-2">Status</th>
                <th className="text-left font-semibold px-3 py-2">Resource</th>
                <th className="text-left font-semibold px-3 py-2">Rule</th>
                <th className="text-left font-semibold px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {rows.map(f => (
                <tr key={`${f.ruleId}#${f.resourceId}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    {f.remediated ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800">fixed</span>
                    ) : f.excluded ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700">excluded</span>
                    ) : f.verdict === "violation" ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800">violation</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">ok</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-700 dark:text-slate-300 max-w-[320px] truncate" title={f.resourceId}>{f.resourceId}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{f.ruleName}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400">
                    {f.summary}
                    {f.proposedFix && !f.remediated && !f.excluded && (
                      <span className="text-slate-400 dark:text-slate-500"> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
                    )}
                    {f.error && <span className="block text-rose-500 mt-0.5">{f.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Exclusion lists ───────────────────────────────────────────────────

function ExclusionsTab({ lists }: { lists?: AwsExclusionList[] }) {
  const save = useSaveAwsExclusion();
  const remove = useDeleteAwsExclusion();
  const [editing, setEditing] = useState<AwsExclusionList | "new" | null>(null);

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{lists?.length ?? 0} list(s)</span>
        <button onClick={() => setEditing("new")} className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
          <i className="ph-bold ph-plus mr-1"></i>New list
        </button>
      </div>

      {!lists?.length ? (
        <div className="p-12 text-center text-slate-400 dark:text-slate-500">
          <i className="ph-fill ph-prohibit text-4xl mb-3 block"></i>
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No exclusion lists</p>
          <p className="text-xs mt-1">Exclude resources by exact name, name prefix, substring, or tag.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-50 dark:divide-slate-800">
          {lists.map(l => (
            <div key={l.id} className="px-5 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{l.name}</div>
                {l.description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{l.description}</p>}
                <div className="flex flex-wrap gap-1 mt-2">
                  {l.resources.map(r => (
                    <span key={r} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">{r}</span>
                  ))}
                  {l.patterns.map(p => (
                    <span key={p.id} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900">{p.type} {p.value}</span>
                  ))}
                  {l.whitelist.map(w => (
                    <span key={w} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900">keep {w}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={() => setEditing(l)} className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                <button onClick={() => { if (confirm(`Delete "${l.name}"?`)) remove.mutate(l.id); }}
                  className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ExclusionEditor
          list={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(body, id) => save.mutateAsync({ id, body }).then(() => setEditing(null))}
        />
      )}
    </div>
  );
}

function ExclusionEditor({ list, onClose, onSave }: {
  list: AwsExclusionList | null;
  onClose: () => void;
  onSave: (body: Partial<AwsExclusionList>, id?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [resources, setResources] = useState((list?.resources ?? []).join("\n"));
  const [whitelist, setWhitelist] = useState((list?.whitelist ?? []).join("\n"));
  const [patterns, setPatterns] = useState(
    (list?.patterns ?? []).map(p => `${p.type}:${p.value}`).join("\n"));
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
      setError('Each pattern must be "starts_with:value", "contains:value" or "tag_equals:Key=Value".');
      return;
    }
    try {
      await onSave({
        name, description,
        resources: lines(resources),
        whitelist: lines(whitelist),
        patterns: parsed as any,
      }, list?.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const input = "w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <Modal title={list ? "Edit exclusion list" : "New exclusion list"} onClose={onClose} onSubmit={submit} error={error}>
      <Field label="Name"><input className={input} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Description"><input className={input} value={description} onChange={e => setDescription(e.target.value)} /></Field>
      <Field label="Exact resource names" hint="One per line — bucket names, log group names.">
        <textarea rows={3} className={`${input} font-mono`} value={resources} onChange={e => setResources(e.target.value)} />
      </Field>
      <Field label="Patterns" hint='One per line: starts_with:tmp- · contains:sandbox · tag_equals:Env=dev'>
        <textarea rows={3} className={`${input} font-mono`} value={patterns} onChange={e => setPatterns(e.target.value)} />
      </Field>
      <Field label="Keep anyway" hint="Wins over the patterns above, so one resource can be pulled back in.">
        <textarea rows={2} className={`${input} font-mono`} value={whitelist} onChange={e => setWhitelist(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── Rule editor ───────────────────────────────────────────────────────

function RuleEditor({ rule, catalog, exclusions, isAdmin, adminTeam, onClose }: {
  rule: Guardrail | null; catalog: CatalogEntry[]; exclusions: AwsExclusionList[];
  isAdmin: boolean; adminTeam: string; onClose: () => void;
}) {
  const create = useCreateGuardrail();
  const update = useUpdateGuardrail();

  const [kind, setKind] = useState(rule?.kind ?? catalog[0]?.kind ?? "");
  const entry = catalog.find(c => c.kind === kind);

  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [mode, setMode] = useState(rule?.mode ?? "report");
  const [applyOnCreate, setApplyOnCreate] = useState(rule?.applyOnCreate ?? true);
  const [params, setParams] = useState<Record<string, any>>(rule?.params ?? entry?.defaultParams ?? {});
  const [selected, setSelected] = useState<string[]>(rule?.exclusionLists ?? []);
  const [error, setError] = useState<string | null>(null);

  const enforceBlocked = !isAdmin || !(entry?.canRemediate ?? true);

  const onKindChange = (k: string) => {
    setKind(k);
    const e = catalog.find(c => c.kind === k);
    setParams(e?.defaultParams ?? {});
    if (!e?.canRemediate) setMode("report");
    if (!name) setName(e?.title ?? label(k));
  };

  const submit = async () => {
    setError(null);
    const body = { name, description, kind, mode, applyOnCreate, params, exclusionLists: selected };
    try {
      if (rule) await update.mutateAsync({ id: rule.id, body });
      else await create.mutateAsync(body);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const input = "w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <Modal title={rule ? "Edit guardrail" : "New guardrail"} onClose={onClose} onSubmit={submit} error={error}>
      <Field label="Rule type">
        <select className={input} value={kind} onChange={e => onKindChange(e.target.value)} disabled={!!rule}>
          {catalog.map(c => <option key={c.kind} value={c.kind}>{label(c.kind)}</option>)}
        </select>
        {rule && <p className="text-[11px] text-slate-400 mt-1">Rule type can't be changed after creation — delete and recreate instead.</p>}
      </Field>

      <Field label="Name"><input className={input} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Description"><input className={input} value={description} onChange={e => setDescription(e.target.value)} /></Field>

      <Field label="Mode" hint={
        !entry?.canRemediate
          ? "This rule is report-only: fixing it automatically could cut live access."
          : !isAdmin
            ? `Enforce mode requires the "${adminTeam}" team.`
            : "Report finds violations. Enforce also fixes them, automatically."
      }>
        <div className="flex gap-2">
          {(["report", "enforce"] as const).map(m => (
            <button key={m} type="button"
              onClick={() => !(m === "enforce" && enforceBlocked) && setMode(m)}
              disabled={m === "enforce" && enforceBlocked}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${
                mode === m
                  ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700"
              } ${m === "enforce" && enforceBlocked ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {m === "enforce" && enforceBlocked && <i className="ph-fill ph-lock-simple mr-1"></i>}
              {m}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Run when a resource is created" hint={
        entry?.createEvents.length ? `Triggers on ${entry.createEvents.join(", ")}` : "This rule type has no creation event — the sweep covers it."
      }>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={applyOnCreate} onChange={e => setApplyOnCreate(e.target.checked)}
            disabled={!entry?.createEvents.length} className="rounded border-slate-300 dark:border-slate-600" />
          Enabled
        </label>
      </Field>

      {(entry?.paramSchema ?? []).length > 0 && (
        <Field label="Settings">
          <div className="space-y-4">
            {entry!.paramSchema.map(spec => (
              <ParamControl key={spec.key} spec={spec}
                value={params[spec.key] ?? spec.default}
                onChange={v => setParams(p => ({ ...p, [spec.key]: v }))} />
            ))}
          </div>
        </Field>
      )}

      <Field label="Exclusion lists">
        {exclusions.length === 0 ? (
          <p className="text-xs text-slate-400">None defined yet.</p>
        ) : (
          <div className="space-y-1">
            {exclusions.map(l => (
              <label key={l.id} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" checked={selected.includes(l.id)}
                  onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(x => x !== l.id))}
                  className="rounded border-slate-300 dark:border-slate-600" />
                {l.name}
              </label>
            ))}
          </div>
        )}
      </Field>
    </Modal>
  );
}

// ── shared bits ───────────────────────────────────────────────────────

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
  const field = "w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40";
  return (
    <label className="block">
      <span className="block text-sm text-slate-700 dark:text-slate-300 mb-1.5">{spec.label}</span>
      <span className="flex items-center gap-2">
        {spec.type === "number" && spec.allowed ? (
          <select value={value} onChange={e => onChange(Number(e.target.value))} className={`${field} w-36`}>
            {spec.allowed.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : spec.type === "number" ? (
          <input type="number" min={spec.min} value={value} onChange={e => onChange(Number(e.target.value))} className={`${field} w-36`} />
        ) : spec.type === "choice" ? (
          <select value={value} onChange={e => onChange(e.target.value)} className={field}>
            {spec.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : spec.type === "ports" ? (
          <input value={Array.isArray(value) ? value.join(", ") : value}
            onChange={e => onChange(e.target.value.split(",").map(x => Number(x.trim())).filter(n => !Number.isNaN(n)))}
            className={field} />
        ) : (
          <input value={value ?? ""} onChange={e => onChange(e.target.value)} className={field} />
        )}
        {spec.unit && <span className="text-sm text-slate-500 dark:text-slate-400 shrink-0">{spec.unit}</span>}
      </span>
      {spec.help && <span className="block text-xs text-slate-400 dark:text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function Modal({ title, onClose, onSubmit, error, children }: {
  title: string; onClose: () => void; onSubmit: () => void; error: string | null; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900">
          <h3 className="font-bold text-slate-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="p-5">
          {children}
          {error && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200">Cancel</button>
            <button onClick={onSubmit} className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-semibold hover:opacity-90">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
