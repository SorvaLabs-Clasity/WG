import { useState, useMemo } from "react";
import { useAuth } from "../App";
import { Page, StatusSlab, SlabPercent, RailCard, Sheet, SheetHeader, Block, Back, Note, Pill, Button, Empty, Spinner, Figure, InsetRow, TYPE, enter, type Intent } from "../design";
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

  /** Each rule opens as its own page rather than expanding in place. */
  const [view, setView] = useState<{ k: "list" } | { k: "rule"; id: string } | { k: "exclusions" }>({ k: "list" });
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
    <Page user={user}>
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">AWS Guardrails</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Checked when resources are created, every 15 minutes, and on demand.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button onClick={() => setView({ k: "exclusions" })}>
              Exclusions <span className="text-slate-400 font-mono ml-1">{exclusions?.length ?? 0}</span>
            </Button>
            {isAdmin && <Button onClick={() => setEditing("new")}>New rule</Button>}
            {isAdmin && (
              <Button variant="primary" disabled={runRules.isPending} onClick={() => doRun()}>
                {runRules.isPending ? "Sweeping…" : "Sweep all"}
              </Button>
            )}
          </div>
        </div>

        {runError && <Note intent="danger">{runError}</Note>}
        {runRules.isSuccess && !runError && (
          <Note intent="good">
            Checked {runRules.data.findings.length} resources — {runRules.data.violations} failing
            {runRules.data.remediated > 0 && `, ${runRules.data.remediated} fixed`}
            {runRules.data.excluded > 0 && `, ${runRules.data.excluded} excluded`}.
          </Note>
        )}

        {view.k === "list" && (
          <StatusSlab
            intent={stats.violations > 0 ? "danger" : stats.compliant > 0 ? "good" : "neutral"}
            eyebrow={stats.violations > 0 ? "Action required" : stats.compliant > 0 ? "All clear" : "Not yet swept"}
            metrics={[
              { value: stats.violations, label: "failing", emphasis: true },
              { value: stats.compliant, label: "passing" },
              { value: stats.excluded, label: "excluded" },
            ]}
            aside={<SlabPercent
              value={stats.violations + stats.compliant ? Math.round((stats.compliant / (stats.violations + stats.compliant)) * 100) : 100}
              label="compliant" />}
            footer={<>{stats.enforcing} {stats.enforcing === 1 ? "rule fixes" : "rules fix"} problems automatically</>}
          />
        )}

        {view.k === "exclusions" ? (
          <>
            <Back onClick={() => setView({ k: "list" })}>All rules</Back>
            <ExclusionsTab lists={exclusions} />
          </>
        ) : view.k === "rule" ? (
          <RuleDetail
            rule={(rules ?? []).find(r => r.id === view.id)}
            entry={(catalog ?? []).find(c => c.kind === (rules ?? []).find(r => r.id === view.id)?.kind)}
            findings={(findings ?? []).filter(f => f.ruleId === view.id)}
            exclusions={exclusions ?? []}
            isAdmin={isAdmin}
            running={runRules.isPending}
            onRun={() => doRun([view.id])}
            onEdit={() => { const r = (rules ?? []).find(x => x.id === view.id); if (r) setEditing(r); }}
            onToggleEnabled={() => {
              const r = (rules ?? []).find(x => x.id === view.id);
              if (r) updateRule.mutate({ id: r.id, body: { enabled: !r.enabled } });
            }}
            onDelete={() => { deleteRule.mutate(view.id); setView({ k: "list" }); }}
            onBack={() => setView({ k: "list" })}
          />
        ) : (
          <RulesTab
            rules={rules} catalog={catalog} findings={findings} isLoading={isLoading} isAdmin={isAdmin}
            adminTeam={permissions?.awsAdminTeam ?? "aws-guardrail-admins"}
            onOpen={(id) => setView({ k: "rule", id })}
            onNew={() => setEditing("new")}
          />
        )}

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
    </Page>
  );
}

// ── Rules ─────────────────────────────────────────────────────────────

function RulesTab({ rules, catalog, findings, isLoading, isAdmin, adminTeam, onOpen, onNew }: {
  rules?: Guardrail[]; catalog?: CatalogEntry[]; findings?: Finding[]; isLoading: boolean;
  isAdmin: boolean; adminTeam: string;
  onOpen: (id: string) => void; onNew: () => void;
}) {
  const byKind = new Map((catalog ?? []).map(c => [c.kind, c]));
  const byRule = new Map<string, Finding[]>();
  (findings ?? []).forEach(f => byRule.set(f.ruleId, [...(byRule.get(f.ruleId) ?? []), f]));

  if (isLoading) return <Spinner />;

  if (!rules?.length) {
    return (
      <Empty
        title="No guardrails yet"
        body={`A guardrail says how a kind of AWS resource must be configured, and checks it on creation, every 15 minutes, and on demand. ${catalog?.length ?? 0} rule types available.`}
        action={isAdmin ? <Button variant="primary" onClick={onNew}>Add the first rule</Button> : undefined}
      />
    );
  }

  // Worst first — a failing rule must never sit below a passing one.
  const ordered = [...rules].map(r => {
    const f = byRule.get(r.id) ?? [];
    return {
      rule: r, entry: byKind.get(r.kind),
      failing: f.filter(x => x.verdict === "violation" && !x.excluded).length,
      checked: f.filter(x => !x.excluded).length,
      excluded: f.filter(x => x.excluded).length,
    };
  }).sort((a, b) => b.failing - a.failing || a.rule.name.localeCompare(b.rule.name));

  return (
    <>
      <div className="grid gap-3">
        {ordered.map(({ rule: r, entry, failing, checked, excluded }, i) => {
          const intent: Intent = !r.enabled ? "neutral"
            : failing > 0 ? "danger" : checked === 0 ? "neutral" : "good";
          return (
            <RailCard key={r.id} intent={intent} index={i} onClick={() => onOpen(r.id)}>
              <div className="flex items-center gap-6">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className={`${TYPE.heading} ${r.enabled ? "text-slate-900 dark:text-white" : "text-slate-400 dark:text-slate-500"}`}>
                      {r.name}
                    </h3>
                    {r.mode === "enforce" && <Pill intent="info">auto-fix</Pill>}
                    {!r.enabled && <Pill intent="neutral">paused</Pill>}
                    {entry && !entry.canRemediate && <Pill intent="warn">report only</Pill>}
                  </div>
                  <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>{entry?.summary ?? r.kind}</p>
                  {excluded > 0 && (
                    <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-1.5">{excluded} excluded by a list</p>
                  )}
                </div>

                {failing > 0 ? <Figure intent="danger" value={failing} label="failing" />
                  : checked > 0 ? <Figure intent="good" value={checked} label="passing" />
                    : <Figure intent="neutral" value="—" label="not checked" />}

                <i className="ph-bold ph-caret-right text-slate-300 dark:text-slate-600 group-hover:text-slate-500 group-hover:translate-x-0.5 transition-all shrink-0"></i>
              </div>
            </RailCard>
          );
        })}
      </div>

      {!isAdmin && (
        <div className="mt-4">
          <Note intent="neutral">
            You can view every rule and finding. Creating, editing and running guardrails is limited to the{" "}
            <span className="font-semibold">{adminTeam}</span> team — they change the whole AWS account.
          </Note>
        </div>
      )}
    </>
  );
}

/** A rule's own page: what it checks, how it is configured, and every resource it touched. */
function RuleDetail({ rule, entry, findings, exclusions, isAdmin, running, onRun, onEdit, onToggleEnabled, onDelete, onBack }: {
  rule?: Guardrail; entry?: CatalogEntry; findings: Finding[]; exclusions?: AwsExclusionList[];
  isAdmin: boolean; running: boolean;
  onRun: () => void; onEdit: () => void; onToggleEnabled: () => void; onDelete: () => void; onBack: () => void;
}) {
  const [showPassing, setShowPassing] = useState(false);

  if (!rule) {
    return (
      <>
        <Back onClick={onBack}>All rules</Back>
        <Empty title="Rule not found" body="It may have been deleted." />
      </>
    );
  }

  const failing = findings.filter(f => f.verdict === "violation" && !f.excluded);
  const rest = findings.filter(f => !(f.verdict === "violation" && !f.excluded));
  const shown = showPassing ? [...failing, ...rest] : failing;
  const checked = findings.filter(f => !f.excluded).length;
  const excluded = findings.filter(f => f.excluded).length;
  const used = (exclusions ?? []).filter(l => rule.exclusionLists?.includes(l.id));
  const intent: Intent = !rule.enabled ? "neutral"
    : failing.length > 0 ? "danger" : checked > 0 ? "good" : "neutral";

  return (
    <>
      <Back onClick={onBack}>All rules</Back>
      <Sheet>
        <SheetHeader
          intent={intent}
          title={rule.name}
          subtitle={entry?.summary}
          aside={
            <div>
              <p className="text-[44px] font-black text-white leading-none tabular-nums">
                {failing.length > 0 ? failing.length : checked}
              </p>
              <p className={`${TYPE.label} text-white/70 mt-1.5`}>
                {failing.length > 0 ? "failing" : checked > 0 ? "passing" : "not checked"}
              </p>
            </div>
          }
        />

        {isAdmin && (
          <div className="px-7 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-5 bg-slate-50/70 dark:bg-slate-800/40 flex-wrap">
            <button onClick={onRun} disabled={running}
              className="text-sm font-bold text-slate-800 dark:text-slate-100 hover:opacity-70 disabled:opacity-40">
              {running ? "Running…" : "Run now"}
            </button>
            <button onClick={onEdit} className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">Edit</button>
            <button onClick={onToggleEnabled} className="text-sm font-bold text-slate-800 dark:text-slate-100 hover:opacity-70">
              {rule.enabled ? "Pause" : "Resume"}
            </button>
            <button onClick={() => { if (confirm(`Delete "${rule.name}"? Its findings go too.`)) onDelete(); }}
              className="text-sm font-bold text-rose-600 dark:text-rose-400 hover:opacity-70 ml-auto">Delete</button>
          </div>
        )}

        <Block title="Configuration">
          <dl className="grid sm:grid-cols-2 gap-x-12">
            <DetailRow label="When it finds a problem">
              {rule.mode === "enforce"
                ? <span className="text-blue-600 dark:text-blue-400 font-semibold">Fixes it automatically</span>
                : "Records it, changes nothing"}
            </DetailRow>
            {(entry?.paramSchema ?? []).map(sp => (
              <DetailRow key={sp.key} label={sp.label}>{formatParam(rule.params?.[sp.key] ?? sp.default, sp)}</DetailRow>
            ))}
            <DetailRow label="On resource creation">
              {!entry?.createEvents.length ? "Swept only" : rule.applyOnCreate ? "Checked immediately" : "Waits for the sweep"}
            </DetailRow>
            {used.length > 0 && <DetailRow label="Skipping">{used.map(l => l.name).join(", ")}</DetailRow>}
          </dl>
        </Block>

        <Block
          title={`Resources — ${failing.length} failing of ${checked} checked${excluded ? `, ${excluded} excluded` : ""}`}
          action={rest.length > 0 && (
            <button onClick={() => setShowPassing(v => !v)}
              className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:underline">
              {showPassing ? "Hide passing" : `View ${rest.length} passing`}
            </button>
          )}>
          {findings.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Not checked yet. Run this rule to populate it.</p>
          ) : (
            <ul className="grid gap-2">
              {shown.slice(0, 200).map((f, i) => {
                const fi: Intent = f.remediated ? "info"
                  : f.excluded ? "neutral"
                    : f.verdict === "violation" ? "danger" : "good";
                return (
                  <InsetRow key={f.resourceId} intent={fi} index={i}>
                    <div className="flex items-start gap-3 flex-wrap">
                      <Pill intent={fi}>
                        {f.remediated ? "fixed" : f.excluded ? "skipped" : f.verdict === "violation" ? "failing" : "ok"}
                      </Pill>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[13.5px] font-bold text-slate-900 dark:text-white break-all">{f.resourceId}</p>
                        <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {f.summary}
                          {f.proposedFix && !f.remediated && !f.excluded && (
                            <span className="text-slate-400 dark:text-slate-500"> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
                          )}
                        </p>
                        {f.error && <p className="text-[12.5px] text-rose-500 mt-0.5">{f.error}</p>}
                      </div>
                    </div>
                  </InsetRow>
                );
              })}
            </ul>
          )}
        </Block>
      </Sheet>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2 border-b border-slate-50 dark:border-slate-800/60">
      <dt className="text-[14px] text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-[14px] font-semibold text-slate-800 dark:text-slate-200 text-right">{children}</dd>
    </div>
  );
}

function formatParam(value: any, spec: ParamSpec): string {
  if (spec.type === "boolean") return value ? "Yes" : "No";
  if (spec.type === "ports") return Array.isArray(value) ? value.join(", ") : String(value);
  if (spec.type === "choice") return spec.options?.find(o => o.value === value)?.label ?? String(value);
  return spec.unit ? `${value} ${spec.unit}` : String(value);
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
