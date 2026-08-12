import { useState, useMemo } from "react";
import { useAuth } from "../App";
import { Page, StatusSlab, SlabPercent, RailCard, Sheet, SheetHeader, Block, Back, Note, Pill, Button, Empty, Spinner, Figure, InsetRow, Segmented, TYPE, SURFACE, INTENT, enter, type Intent, RefreshButton,
} from "../design";
import { usePermissions } from "../hooks/usePermissions";
import {
  useCatalog, useGuardrails, useFindings, useAwsExclusions,
  useCreateGuardrail, useUpdateGuardrail, useDeleteGuardrail, useRunGuardrails,
  useSaveAwsExclusion, useDeleteAwsExclusion,
  useAwsAccounts, useSaveAwsAccount, useRemoveAwsAccount, useVerifyAwsAccount, useDiscoverAwsAccounts,
  useAccountSetup,
} from "../hooks/useAws";
import type { Guardrail, CatalogEntry, Finding, AwsExclusionList, ParamSpec, AwsAccount, AwsAccessMethod } from "../api/aws";
import { awsConsoleUrl, consoleLinkLabel } from "../utils/awsConsole";

const KIND_LABELS: Record<string, string> = {
  s3_https_only: "S3 — deny non-TLS requests",
  log_retention_min: "CloudWatch Logs — minimum retention",
};

const label = (kind: string) => KIND_LABELS[kind] ?? kind;

export default function AwsPage() {
  const { user } = useAuth();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;

  const { data: catalog } = useCatalog();
  const { data: rules, isLoading, isFetching: rulesFetching, refetch: refetchRules } = useGuardrails();
  const { data: findings, isFetching: findingsFetching, refetch: refetchFindings } = useFindings();
  const { data: exclusions, refetch: refetchExclusions } = useAwsExclusions();
  const { data: accounts, refetch: refetchAccounts } = useAwsAccounts();

  const runRules = useRunGuardrails();
  const deleteRule = useDeleteGuardrail();
  const updateRule = useUpdateGuardrail();

  /** Each rule opens as its own page rather than expanding in place. */
  const [view, setView] = useState<{ k: "list" } | { k: "rule"; id: string } | { k: "exclusions" } | { k: "accounts" }>({ k: "list" });
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
            <RefreshButton
              busy={rulesFetching || findingsFetching}
              onRefresh={() => Promise.all([refetchRules(), refetchFindings(), refetchExclusions(), refetchAccounts()])}
            />
            <Button onClick={() => setView({ k: "accounts" })}>
              Accounts <span className="text-slate-400 font-mono ml-1">{accounts?.length ?? 1}</span>
            </Button>
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
            {runRules.data.excluded > 0 && `, ${runRules.data.excluded} excluded`}
            {(runRules.data.accountsChecked?.length ?? 0) > 1 &&
              ` across ${runRules.data.accountsChecked!.map(a => a.name).join(", ")}`}.
            {runRules.data.errors.length > 0 && (
              // An account that could not be reached is the one thing a summary
              // must not round off to "all clear".
              <span className="block mt-1 text-amber-700 dark:text-amber-400">
                {runRules.data.errors.slice(0, 3).join(" · ")}
              </span>
            )}
            {(runRules.data.unswept?.length ?? 0) > 0 && (
              <span className="block mt-1 text-amber-700 dark:text-amber-400">
                Not looked at: {runRules.data.unswept!.map(u =>
                  `${u.count} bucket${u.count === 1 ? "" : "s"} in ${u.region}` +
                  ((runRules.data.accountsChecked?.length ?? 0) > 1 ? ` (${u.accountName})` : "")
                ).join(", ")}. Add the region to that account to include them.
              </span>
            )}
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

        {view.k === "accounts" ? (
          <>
            <Back onClick={() => setView({ k: "list" })}>All rules</Back>
            <AccountsTab accounts={accounts} isAdmin={isAdmin} />
          </>
        ) : view.k === "exclusions" ? (
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
            accounts={accounts ?? []}
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
function RuleDetail({ rule, entry, findings, exclusions, accounts, isAdmin, running, onRun, onEdit, onToggleEnabled, onDelete, onBack }: {
  rule?: Guardrail; entry?: CatalogEntry; findings: Finding[]; exclusions?: AwsExclusionList[];
  accounts?: AwsAccount[];
  isAdmin: boolean; running: boolean;
  onRun: () => void; onEdit: () => void; onToggleEnabled: () => void; onDelete: () => void; onBack: () => void;
}) {
  const [showPassing, setShowPassing] = useState(false);

  // Only worth labelling rows when there is more than one account to tell
  // apart. In a single-account install the label is the same word on every
  // row, which is noise dressed as information.
  const multiAccount = (accounts?.length ?? 1) > 1;

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
            <DetailRow label="Reacts to changes">
              {!entry?.triggerEvents.length ? "Swept only" : rule.applyOnCreate ? "Within seconds" : "Waits for the sweep"}
            </DetailRow>
            {multiAccount && (
              <DetailRow label="Accounts">
                {!rule.accounts?.length
                  ? "All of them, including any added later"
                  : rule.accounts
                    .map(id => (accounts ?? []).find(a => a.accountId === id)?.name ?? id)
                    .join(", ")}
              </DetailRow>
            )}
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
                // "auto-fixed" only where this rule did the fixing. A resource
                // someone corrected by hand comes back as plain compliant on the
                // next sweep, and should read the same as one that was never wrong.
                const label = f.remediated ? "auto-fixed"
                  : f.excluded ? "skipped"
                    : f.verdict === "violation" ? "failing" : "ok";
                const href = awsConsoleUrl(f.resourceType, f.resourceId, f.region);
                return (
                  // Keyed on account and region as well: two accounts routinely
                  // have a log group with the same name, and a bare name would
                  // collapse them into one row.
                  <InsetRow key={`${f.accountId ?? "-"}#${f.region ?? "-"}#${f.resourceId}`} intent={fi} index={i}>
                    <div className="flex items-start gap-3 flex-wrap">
                      <Pill intent={fi}>{label}</Pill>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <p className="font-mono text-[13.5px] font-bold text-slate-900 dark:text-white break-all">{f.resourceId}</p>
                          {multiAccount && f.accountName && (
                            <span className="shrink-0 text-[11.5px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                              {f.accountName}{f.region ? ` · ${f.region}` : ""}
                            </span>
                          )}
                        </div>
                        <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {f.summary}
                          {f.proposedFix && !f.remediated && !f.excluded && (
                            <span className="text-slate-400 dark:text-slate-500"> — would {f.proposedFix.charAt(0).toLowerCase() + f.proposedFix.slice(1)}</span>
                          )}
                        </p>
                        {f.error && <p className="text-[12.5px] text-rose-500 mt-0.5">{f.error}</p>}
                      </div>
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer"
                          title={consoleLinkLabel(f.resourceType)}
                          className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-bold px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/[0.07] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-600 transition-colors">
                          AWS<i className="ph-bold ph-arrow-square-out text-[11px]"></i>
                        </a>
                      )}
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
  // Empty means every account. Kept distinct from "all boxes ticked", which
  // would freeze the rule to today's list and quietly skip accounts added later.
  const [accountIds, setAccountIds] = useState<string[]>(rule?.accounts ?? []);
  const [error, setError] = useState<string | null>(null);

  const { data: accounts } = useAwsAccounts();
  const multiAccount = (accounts?.length ?? 1) > 1;

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
    const body = { name, description, kind, mode, applyOnCreate, params, exclusionLists: selected, accounts: accountIds };
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

      <Field label="Run the moment something changes" hint={
        entry?.triggerEvents.length
          ? `Runs within seconds of ${entry.triggerEvents.join(", ")}. Needs a CloudTrail trail; without one the sweep is the only path.`
          : "No live trigger for this rule — the sweep covers it."
      }>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={applyOnCreate} onChange={e => setApplyOnCreate(e.target.checked)}
            disabled={!entry?.triggerEvents.length} className="rounded border-slate-300 dark:border-slate-600" />
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

      {multiAccount && (
        <Field label="Accounts" hint={
          accountIds.length === 0
            ? "Every account, including any added later."
            : "Only the accounts ticked. Accounts added later will not be covered by this rule."
        }>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" checked={accountIds.length === 0}
                onChange={e => e.target.checked && setAccountIds([])}
                className="rounded border-slate-300 dark:border-slate-600" />
              All accounts
            </label>
            {(accounts ?? []).map(a => (
              <label key={a.accountId} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer pl-5">
                <input type="checkbox" checked={accountIds.includes(a.accountId)}
                  onChange={e => setAccountIds(ids =>
                    e.target.checked ? [...ids, a.accountId] : ids.filter(x => x !== a.accountId))}
                  className="rounded border-slate-300 dark:border-slate-600" />
                {a.name} <span className="font-mono text-[11px] text-slate-400">{a.accountId}</span>
              </label>
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


/**
 * Exclusion lists.
 *
 * The previous editor asked people to type "starts_with:tmp-" into a textarea,
 * which requires knowing the rule syntax and gives no feedback until a guardrail
 * runs. Rules are now built one at a time from a dropdown and a value, each
 * explains itself in plain words, and a live preview shows exactly which of your
 * real resources the list currently catches.
 */

type MatchType = "starts_with" | "contains" | "tag_equals";

const MATCH_KINDS: { id: MatchType; label: string; help: string; placeholder: string; example: string }[] = [
  { id: "starts_with", label: "Name starts with", help: "Matches resources whose name begins with this text.", placeholder: "tmp-", example: "tmp- catches tmp-scratch, tmp-build" },
  { id: "contains", label: "Name contains", help: "Matches resources with this text anywhere in the name.", placeholder: "sandbox", example: "sandbox catches acme-sandbox-logs" },
  { id: "tag_equals", label: "Has tag", help: "Matches resources carrying this tag. Leave the value blank to match the tag however it is set.", placeholder: "Env", example: "Env = dev catches anything tagged Env=dev" },
];

// ── Granting access ───────────────────────────────────────────────────

/** Copy-to-clipboard, because these values are long and mistyping one is silent. */
function Copyable({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-[12px] font-bold text-slate-600 dark:text-slate-300">{label}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="text-[12px] font-bold text-blue-600 dark:text-blue-400 hover:opacity-70 shrink-0">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className={`px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-[12px] break-all ${mono ? "font-mono" : ""} text-slate-700 dark:text-slate-200`}>
        {value}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 mb-5">
      <span className="shrink-0 h-6 w-6 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-[12px] font-black grid place-items-center mt-0.5">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-bold text-slate-900 dark:text-white mb-1.5">{title}</p>
        <div className="text-[13px] text-slate-600 dark:text-slate-300">{children}</div>
      </div>
    </div>
  );
}

/**
 * How to grant this app access to an account, without opening a terminal.
 *
 * The app does not create the role itself, and that is a decision rather than
 * a gap — creating IAM roles across an organisation needs permissions that
 * would let whoever held them deploy an administrator role everywhere, which
 * is worse than the administrator access this app was built without. So it
 * does everything that costs nothing: works out every value, generates the
 * external ID, carries the template, and builds the links. What is left is
 * clicking Create while signed in as yourself.
 */
function SetupAccess() {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState<"some" | "org" | "one">("some");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data, isLoading, error } = useAccountSetup(open);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">
        How do I add an account?
      </button>
    );
  }

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.template], { type: "text/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = data.templateFileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const orgAccounts = data?.organization.accounts ?? [];
  const rootId = data?.organization.rootId ?? null;
  const chosenIds = [...picked];

  // Aiming a StackSet at some accounts rather than all of them still needs an
  // organisational unit to work against; AccountFilterType=INTERSECTION narrows
  // the root down to exactly the ids listed. Without the filter, naming
  // accounts alongside an OU deploys to the OU as well.
  const targets = how === "org"
    ? `OrganizationalUnitIds=${rootId ?? "<your organization root>"}`
    : `OrganizationalUnitIds=${rootId ?? "<your organization root>"},Accounts=${chosenIds.join(",") || "<account ids>"},AccountFilterType=INTERSECTION`;

  // Auto-deployment adds the role to accounts created later. That is right for
  // "every account" and wrong for a chosen few — the whole point of choosing is
  // that a new account is not automatically in scope.
  const autoDeploy = how === "org";

  const cli = data && [
    `aws cloudformation create-stack-set \\`,
    `  --stack-set-name ${data.stackSetName} \\`,
    `  --template-body file://${data.templateFileName} \\`,
    `  --capabilities CAPABILITY_NAMED_IAM \\`,
    `  --permission-model SERVICE_MANAGED \\`,
    `  --auto-deployment Enabled=${autoDeploy},RetainStacksOnAccountRemoval=false \\`,
    `  --parameters \\`,
    `    'ParameterKey=ControlHubRoleArns,ParameterValue="${data.parameters.ControlHubRoleArns.replace(/,/g, "\\,")}"' \\`,
    `    ParameterKey=RoleName,ParameterValue=${data.parameters.RoleName} \\`,
    `    ParameterKey=ExternalId,ParameterValue=${data.parameters.ExternalId}`,
    ``,
    `aws cloudformation create-stack-instances \\`,
    `  --stack-set-name ${data.stackSetName} \\`,
    `  --deployment-targets ${targets} \\`,
    `  --regions ${data.region} \\`,
    `  --operation-preferences FailureTolerancePercentage=100,MaxConcurrentPercentage=100`,
  ].join("\n");

  return (
    <div className="mb-5 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>Granting access to an account</h3>
        <button onClick={() => setOpen(false)}
          className="text-sm font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">Close</button>
      </div>

      {isLoading && <Spinner />}
      {error && <Note intent="danger">{(error as Error).message}</Note>}

      {data && (
        <>
          <p className="text-[13px] text-slate-500 dark:text-slate-400 mb-4 max-w-[76ch]">
            Only the accounts you set this up in are ever touched — there is no version of this that
            reaches an account you did not choose. Each one grants a role that can read S3 and
            CloudWatch Logs settings, not the contents of a bucket, not a log line, and nothing it
            can change. Everything below is filled in for you; the only thing this app cannot do is
            press Create, because creating IAM roles across an organization requires permissions
            that would let whoever held them deploy an administrator role everywhere.
          </p>

          <div className="mb-4">
            <Segmented value={how} onChange={setHow} options={[
              ["some", "Accounts I choose"],
              ["org", "Every account"],
              ["one", "Just one"],
            ]} />
          </div>

          {/* Which account you must be signed into is the first thing people
              get wrong, so it sits above the steps rather than inside one. */}
          <Note intent="info">
            {how === "one" ? (
              <>Do this signed in to <strong>the account you want watched</strong>, and repeat for each
              one.</>
            ) : (
              <>Do all of this signed in to your <strong>organization&rsquo;s management account</strong>, in
              one region. You never sign in to the accounts being added — CloudFormation reaches into
              them for you. The role is global, so the region only decides where the stack record
              lives; which regions actually get scanned is set per account in this app afterwards.</>
            )}
          </Note>

          {how === "some" && (
            <div className="mb-5 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
              {!data.organization.available ? (
                <p className="text-[13px] text-slate-500 dark:text-slate-400">
                  {data.organization.error} Use <span className="font-semibold">Just one</span> and repeat it
                  for each account you want — for a handful, that is less work than setting up an
                  organization for it.
                </p>
              ) : orgAccounts.length === 0 ? (
                <p className="text-[13px] text-slate-500 dark:text-slate-400">
                  No other accounts in the organization.
                </p>
              ) : (
                <>
                  <p className="text-[12.5px] font-bold text-slate-600 dark:text-slate-300 mb-2">
                    Which accounts should this app be able to read?
                  </p>
                  <div className="grid gap-1 mb-3 max-h-64 overflow-y-auto">
                    {orgAccounts.map(a => (
                      <label key={a.accountId} className="flex items-center gap-3 py-1 cursor-pointer">
                        <input type="checkbox" checked={picked.has(a.accountId)}
                          onChange={e => setPicked(p => {
                            const next = new Set(p);
                            if (e.target.checked) next.add(a.accountId); else next.delete(a.accountId);
                            return next;
                          })}
                          className="h-4 w-4 rounded accent-slate-900 dark:accent-white" />
                        <span className="text-[13.5px] font-semibold text-slate-800 dark:text-slate-100">{a.name}</span>
                        <span className="font-mono text-[11.5px] text-slate-400">{a.accountId}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
                    {picked.size === 0
                      ? "Pick at least one — the values below fill in as you do."
                      : `${picked.size} chosen. Accounts created later are not included; come back and add them.`}
                  </p>
                </>
              )}
            </div>
          )}

          <Step n={1} title="Download the template">
            <Button onClick={download}>Download {data.templateFileName}</Button>
            <span className="ml-3 text-[12.5px] text-slate-500 dark:text-slate-400">
              Read it first if you like — it is short, and the permissions are the whole of it.
            </span>
          </Step>

          <Step n={2} title={how === "one"
            ? "Open CloudFormation in the account you want to watch"
            : "Open CloudFormation StackSets in your organization's management account"}>
            <a href={how === "one" ? data.consoleUrls.singleStack : data.consoleUrls.stackSets}
              target="_blank" rel="noreferrer"
              className="font-bold text-blue-600 dark:text-blue-400 hover:underline">
              {how === "one" ? "Create stack" : "Create StackSet"} ↗
            </a>
            <div className="mt-1.5 text-[12.5px] text-slate-500 dark:text-slate-400">
              {how === "one" && <>Upload the file and continue. Repeat in each account you want watched.</>}
              {how === "org" && (
                <>Upload the file, choose <span className="font-semibold">Service-managed permissions</span>,
                and deploy to your whole organization with{" "}
                <span className="font-semibold">automatic deployment</span> on — so accounts created later
                are covered without anyone remembering.</>
              )}
              {how === "some" && (
                <>Upload the file, choose <span className="font-semibold">Service-managed permissions</span>,
                then at Deployment targets pick{" "}
                <span className="font-semibold">Deploy to organizational units</span>, enter your root{" "}
                {rootId && <span className="font-mono text-[11.5px]">{rootId}</span>}, and set the account
                filter to <span className="font-semibold">Intersection</span> with the ids below. Leave
                automatic deployment <span className="font-semibold">off</span> — you are choosing accounts,
                so a new one should not join by itself.</>
              )}
            </div>
          </Step>

          <Step n={3} title={`Name the ${how === "one" ? "stack" : "stack set"} and paste these parameters`}>
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mb-3">
              Call it <span className="font-mono text-[11.5px]">{data.stackSetName}</span>. That name is
              yours to choose — matching just keeps the console and the command line in step.
              <span className="block mt-1">
                <span className="font-mono text-[11.5px]">RoleName</span> below is a different thing and is
                <strong> not</strong> yours to choose: it is the one role name this app is permitted to
                assume, so changing it means AWS refuses the app.
              </span>
            </p>
            {how === "some" && picked.size > 0 && (
              <Copyable label="Account IDs (the intersection filter)" value={chosenIds.join(",")} />
            )}
            {how === "some" && rootId && <Copyable label="Organizational unit (your root)" value={rootId} />}
            <Copyable label="ControlHubRoleArns" value={data.parameters.ControlHubRoleArns} />
            <Copyable label="RoleName" value={data.parameters.RoleName} />
            <Copyable label="ExternalId" value={data.parameters.ExternalId} />
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 -mt-1">
              Leave <span className="font-mono text-[11.5px]">ReadOnly</span> at <span className="font-mono text-[11.5px]">true</span>{" "}
              unless you want this app to fix things automatically in that account.
              {data.reusedExternalId
                ? " This external ID is the one your other accounts already use."
                : " Keep a copy of the external ID — it is what stops another installation of this app from naming your accounts."}
            </p>
            {data.principals.engineError && (
              <Note intent="warn">{data.principals.engineError}</Note>
            )}
          </Step>

          <Step n={4} title="Come back and press Find my accounts">
            Accounts with the role appear as ready to add. Nothing is stored until this app has
            assumed the role and confirmed it landed in the account you named.
          </Step>

          {how !== "one" && cli && (
            <details className="mt-2">
              <summary className="text-[13px] font-bold text-slate-500 dark:text-slate-400 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200">
                Prefer the command line?
              </summary>
              <div className="mt-3">
                <Copyable label="Run from the management account" value={cli} />
                <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
                  <span className="font-mono text-[11.5px]">scripts/deploy-guardrail-role-org-wide.sh</span> in
                  the repo runs both of these and prompts for everything, including which accounts.
                </p>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}


// ── Accounts ──────────────────────────────────────────────────────────

/**
 * Organisations run more than one account, and the accounts nobody logs into
 * daily are exactly where a retention setting quietly stays wrong for a year.
 * Reaching them is a role each account grants, so the account that owns the
 * resources decides — and can take the decision back by deleting one stack.
 */
/** One line saying how the app gets into an account, in words rather than ARNs. */
function describeAccess(a: AwsAccount): string {
  if (a.isHome) return "reached with the app's own role";
  const method: AwsAccessMethod = a.access ?? (a.roleArn ? "role" : "organization");
  if (method === "keys") return `an access key ending ${a.keyHint ?? "…"}`;
  if (method === "role") {
    return `the role ${a.roleArn?.split("/").pop()}` + (a.externalId ? ", with an external ID" : "");
  }
  return a.reachedVia
    ? `the role ${a.reachedVia}`
    : "the organization-wide read-only role";
}

/**
 * Pick accounts out of the organisation rather than typing them.
 *
 * The account ids and names already exist somewhere authoritative. Asking a
 * person to retype twelve digits is how an account ends up watched under the
 * wrong name — or, far more often, never added at all.
 */
function DiscoverAccounts({ onAdd }: {
  onAdd: (body: Partial<AwsAccount>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [externalId, setExternalId] = useState("");
  const [probeWith, setProbeWith] = useState("");
  const { data, isLoading, error } = useDiscoverAwsAccounts(open, probeWith || undefined);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<{ added: string[]; failed: { name: string; error: string }[] } | null>(null);

  const candidates = (data?.accounts ?? []).filter(a => !a.isHome && !a.registered);
  const ready = candidates.filter(a => a.reachable);
  const waiting = candidates.filter(a => !a.reachable);

  const addChosen = async () => {
    setAdding(true);
    const added: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const a of ready.filter(c => chosen.has(c.accountId))) {
      try {
        // One at a time and never aborting the loop: each is verified
        // server-side, and one refusal should not stop the rest.
        await onAdd({
          accountId: a.accountId, name: a.name, access: "organization",
          externalId: externalId || undefined,
        });
        added.push(a.name);
      } catch (e) {
        failed.push({ name: a.name, error: (e as Error).message });
      }
    }
    setChosen(new Set());
    setOutcome({ added, failed });
    setAdding(false);
  };

  if (!open) {
    return (
      <div className="mb-4">
        <Button variant="primary" onClick={() => setOpen(true)}>Find my accounts</Button>
        <span className="ml-3 text-[13px] text-slate-500 dark:text-slate-400">
          Reads the account list from AWS Organizations. Nothing is added until you pick.
        </span>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>Accounts in your organization</h3>
        <button onClick={() => setOpen(false)}
          className="text-sm font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">Close</button>
      </div>

      {/* The org-wide StackSet gives every account the same external ID. Probing
          without it would report a correctly-set-up estate as unreachable. */}
      <div className="flex items-end gap-2 mb-4 flex-wrap">
        <div className="min-w-[280px]">
          <label className="block text-[12.5px] font-bold text-slate-600 dark:text-slate-300 mb-1">
            External ID <span className="font-normal text-slate-400">— if you set one when deploying the role</span>
          </label>
          <input value={externalId} onChange={e => setExternalId(e.target.value)}
            className={SURFACE.input} placeholder="Leave blank if you did not set one" />
        </div>
        <Button onClick={() => setProbeWith(externalId)}>Check again</Button>
      </div>

      {isLoading && <Spinner />}
      {error && <Note intent="danger">{(error as Error).message}</Note>}

      {data && !data.available && (
        <Note intent="warn">
          {data.error} You can still add an account by hand — a role ARN, or an access key pair.
        </Note>
      )}

      {outcome && (
        <Note intent={outcome.failed.length ? "warn" : "good"}>
          {outcome.added.length > 0 && <>Now checking {outcome.added.join(", ")}. </>}
          {outcome.failed.length > 0 && (
            <>Could not reach {outcome.failed.map(f => f.name).join(", ")}: {outcome.failed[0].error}</>
          )}
        </Note>
      )}

      {data?.available && candidates.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every account in the organization is already listed.
        </p>
      )}

      {ready.length > 0 && (
        <>
          <p className="text-[12.5px] font-bold text-slate-600 dark:text-slate-300 mb-2">
            Ready to add
          </p>
          <div className="grid gap-1.5 mb-4">
            {ready.map(a => (
              <label key={a.accountId} className="flex items-center gap-3 py-1.5 cursor-pointer">
                <input type="checkbox" checked={chosen.has(a.accountId)}
                  onChange={e => setChosen(c => {
                    const next = new Set(c);
                    if (e.target.checked) next.add(a.accountId); else next.delete(a.accountId);
                    return next;
                  })}
                  className="h-4 w-4 rounded accent-slate-900 dark:accent-white" />
                <span className="text-[14px] font-semibold text-slate-800 dark:text-slate-100">{a.name}</span>
                <span className="font-mono text-[12px] text-slate-400">{a.accountId}</span>
                {a.status && a.status !== "ACTIVE" && <Pill intent="warn">{a.status.toLowerCase()}</Pill>}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <Button variant="primary" disabled={adding || chosen.size === 0} onClick={addChosen}>
              {adding ? "Checking access…" : `Add ${chosen.size || ""} ${chosen.size === 1 ? "account" : "accounts"}`.trim()}
            </Button>
            <button onClick={() => setChosen(new Set(ready.map(a => a.accountId)))}
              className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">Select all</button>
          </div>
        </>
      )}

      {waiting.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
          <p className="text-[12.5px] font-bold text-slate-600 dark:text-slate-300 mb-2">
            {waiting.length} {waiting.length === 1 ? "account has" : "accounts have"} no role for this app yet
          </p>
          <div className="grid gap-1 mb-3">
            {waiting.map(a => (
              <div key={a.accountId} className="flex items-center gap-3 text-[13px]">
                <span className="text-slate-500 dark:text-slate-400">{a.name}</span>
                <span className="font-mono text-[11.5px] text-slate-400">{a.accountId}</span>
              </div>
            ))}
          </div>
          {/* Stated rather than worked around. AWS already puts an
              administrator role in every organisation account, and this app is
              deliberately unable to assume it — so there is a setup step, and
              pretending otherwise would be the wrong trade made quietly. */}
          <p className="text-[12.5px] text-slate-500 dark:text-slate-400 max-w-[74ch]">
            This app can only ever assume one role, <span className="font-mono text-[11.5px]">{data?.roleName}</span>,
            and that role can read configuration and nothing else. It deliberately cannot use{" "}
            <span className="font-mono text-[11.5px]">OrganizationAccountAccessRole</span>, which AWS puts in
            every organization account and which carries full administrator rights.
          </p>
          <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-2 max-w-[74ch]">
            Use <span className="font-semibold">How do I add an account?</span> above — it has the template,
            every value filled in, and a link straight to the right console page. One StackSet covers every
            account at once, including accounts made later.
          </p>
        </div>
      )}
    </div>
  );
}

function AccountsTab({ accounts, isAdmin }: { accounts?: AwsAccount[]; isAdmin: boolean }) {
  const save = useSaveAwsAccount();
  const remove = useRemoveAwsAccount();
  const verify = useVerifyAwsAccount();
  const [editing, setEditing] = useState<AwsAccount | "new" | null>(null);
  const [checked, setChecked] = useState<Record<string, { ok: boolean; error?: string; via?: string }>>({});

  if (editing) {
    return (
      <AccountEditor
        account={editing === "new" ? null : editing}
        error={save.error ? (save.error as Error).message : null}
        saving={save.isPending}
        onClose={() => { save.reset(); setEditing(null); }}
        onSave={body => save.mutateAsync(body).then(() => { setEditing(null); })}
      />
    );
  }

  const extra = (accounts ?? []).filter(a => !a.isHome).length;

  return (
    <>
      <Note intent="neutral">
        Guardrails run in every account listed here. Each one grants a role that can read S3 and
        CloudWatch Logs settings and nothing else — not the contents of a bucket, not a log line,
        and by default nothing it can change. One command deploys that role across a whole AWS
        Organization.
      </Note>

      {isAdmin && <SetupAccess />}
      {isAdmin && <DiscoverAccounts onAdd={body => save.mutateAsync(body)} />}

      <div className="flex items-center justify-between gap-4 mb-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {accounts?.length ?? 0} {(accounts?.length ?? 0) === 1 ? "account" : "accounts"}
          {extra === 0 && " — only the one this app runs in"}
        </p>
        {isAdmin && <Button onClick={() => setEditing("new")}>Add one by hand</Button>}
      </div>

      <div className="grid gap-3">
        {(accounts ?? []).map((a, i) => {
          const result = checked[a.accountId];
          return (
            <RailCard key={a.accountId} intent={a.enabled ? (result && !result.ok ? "danger" : "neutral") : "neutral"} index={i}>
              <div className="flex items-start justify-between gap-5 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>{a.name}</h3>
                    {a.isHome && <Pill intent="info">this app</Pill>}
                    {!a.enabled && <Pill intent="neutral">not swept</Pill>}
                  </div>
                  <p className="font-mono text-[12.5px] text-slate-500 dark:text-slate-400 mt-1">{a.accountId}</p>
                  <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1.5`}>
                    {a.regions.join(", ")} · {describeAccess(a)}
                  </p>
                  {result && (
                    <p className={`text-[13px] mt-2 ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                      {result.ok ? `Reachable via ${result.via ?? "an assumed role"}.` : result.error}
                    </p>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex gap-4 shrink-0">
                    {!a.isHome && (
                      <button
                        disabled={verify.isPending}
                        onClick={() => verify.mutateAsync(a.accountId)
                          .then(r => setChecked(c => ({ ...c, [a.accountId]: r })))
                          .catch(e => setChecked(c => ({ ...c, [a.accountId]: { ok: false, error: (e as Error).message } })))}
                        className="text-sm font-bold text-slate-500 dark:text-slate-400 hover:opacity-70 disabled:opacity-40">
                        {verify.isPending ? "Checking…" : "Check access"}
                      </button>
                    )}
                    <button onClick={() => setEditing(a)}
                      className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">Edit</button>
                    {!a.isHome && (
                      <button
                        onClick={() => {
                          if (confirm(`Stop checking "${a.name}"? Its existing findings stay on screen until the next sweep — removing an account is not the same as knowing it is clean.`)) {
                            remove.mutate(a.accountId);
                          }
                        }}
                        className="text-sm font-bold text-rose-600 dark:text-rose-400 hover:opacity-70">Remove</button>
                    )}
                  </div>
                )}
              </div>
            </RailCard>
          );
        })}
      </div>
    </>
  );
}

const COMMON_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ca-central-1", "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
];

function AccountEditor({ account, error, saving, onClose, onSave }: {
  account: AwsAccount | null;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Partial<AwsAccount>) => Promise<unknown>;
}) {
  const isHome = account?.isHome ?? false;
  const [accountId, setAccountId] = useState(account?.accountId ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [method, setMethod] = useState<AwsAccessMethod>(
    account?.access ?? (account?.roleArn ? "role" : "organization"));
  const [roleArn, setRoleArn] = useState(account?.roleArn ?? "");
  const [externalId, setExternalId] = useState(account?.externalId ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [regions, setRegions] = useState<string[]>(account?.regions ?? ["us-east-1"]);
  const [enabled, setEnabled] = useState(account?.enabled ?? true);

  const toggleRegion = (r: string) =>
    setRegions(rs => rs.includes(r) ? rs.filter(x => x !== r) : [...rs, r]);

  const field = SURFACE.input;

  return (
    <>
      <Back onClick={onClose}>Accounts</Back>
      <Sheet>
        <SheetHeader intent="neutral"
          title={account ? account.name : "Add an AWS account"}
          subtitle={isHome
            ? "This is the account the app runs in. It needs no role, and cannot be removed."
            : "Most accounts need nothing set up in them at all."}
        />
      <Block title="Identity">
        <Field label="Account ID" hint="Twelve digits. Shown top-right in that account's console.">
          <input value={accountId} onChange={e => setAccountId(e.target.value.replace(/\D/g, "").slice(0, 12))}
            disabled={!!account} placeholder="123456789012"
            className={`${field} font-mono disabled:opacity-60`} />
        </Field>
        <Field label="Name" hint="What people call it. This is what appears beside every finding.">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="prod" className={field} />
        </Field>
      </Block>

      {!isHome && (
        <Block title="How to get in">
          <div className="flex flex-wrap gap-2 mb-4">
            {([
              ["organization", "From my organization", "One role, every account"],
              ["role", "A specific role", "Narrowest access"],
              ["keys", "An access key", "For accounts outside the org"],
            ] as const).map(([m, title, hint]) => (
              <button key={m} type="button" onClick={() => setMethod(m)}
                className={`text-left px-3.5 py-2.5 rounded-xl border transition-colors ${
                  method === m
                    ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-transparent"
                    : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-400"
                }`}>
                <span className="block text-[13.5px] font-bold">{title}</span>
                <span className={`block text-[11.5px] ${method === m ? "opacity-70" : "text-slate-400 dark:text-slate-500"}`}>{hint}</span>
              </button>
            ))}
          </div>

          {method === "organization" && (
            <>
              <p className="text-[13px] text-slate-500 dark:text-slate-400 max-w-[72ch] mb-4">
                Uses the role deployed by{" "}
                <span className="font-mono text-[12px]">scripts/deploy-guardrail-role-org-wide.sh</span>,
                which puts the same read-only role in every account of your organization at once.
                Nothing to copy from account to account, and no administrator access anywhere.
              </p>
              <Field label="External ID"
                hint="Whatever the deployment script generated. Blank if you chose not to set one.">
                <input value={externalId} onChange={e => setExternalId(e.target.value)} className={field} />
              </Field>
            </>
          )}

          {method === "role" && (
            <>
              <Field label="Role ARN"
                hint="Any role in that account whose trust policy names this app. scripts/guardrail-account-role.yaml creates one and prints it.">
                <input value={roleArn} onChange={e => setRoleArn(e.target.value)}
                  placeholder="arn:aws:iam::123456789012:role/github-control-hub-guardrail-access"
                  className={`${field} font-mono text-[12.5px]`} />
              </Field>
              <Field label="External ID"
                hint="Only if the role's trust policy requires one. It stops another installation of this app from naming your account and being let in.">
                <input value={externalId} onChange={e => setExternalId(e.target.value)} className={field} />
              </Field>
            </>
          )}

          {method === "keys" && (
            <>
              <Field label="Access key ID"
                hint={account?.keyHint
                  ? `A key ending ${account.keyHint} is already stored. Leave both fields blank to keep it.`
                  : "From an IAM user in that account with read access to S3 and CloudWatch Logs."}>
                <input value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)}
                  placeholder="AKIA…" className={`${field} font-mono`} />
              </Field>
              <Field label="Secret access key"
                hint="Written straight to AWS Secrets Manager. It is never stored on the account record and never sent back to this screen.">
                <input type="password" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)}
                  autoComplete="off" className={`${field} font-mono`} />
              </Field>
              <p className="text-[13px] text-amber-600 dark:text-amber-400 max-w-[72ch]">
                A key is a credential that lives until someone deletes it. A role is better where you
                can use one — but a key on an account being checked beats a role on an account nobody
                got round to setting up.
              </p>
            </>
          )}
        </Block>
      )}

      <Block title="Where to look">
        <p className="text-[13px] text-slate-500 dark:text-slate-400 mb-3">
          Buckets and log groups are per-region. A region not listed here is never checked.
        </p>
        <div className="flex flex-wrap gap-2">
          {Array.from(new Set([...COMMON_REGIONS, ...regions])).map(r => (
            <button key={r} onClick={() => toggleRegion(r)}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-mono font-bold border transition-colors ${
                regions.includes(r)
                  ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-transparent"
                  : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-400"
              }`}>
              {r}
            </button>
          ))}
        </div>
        {regions.length === 0 && (
          <p className="text-[13px] text-amber-600 dark:text-amber-400 mt-3">
            With no region selected this account is listed but never actually checked.
          </p>
        )}
      </Block>

      <Block title="Sweeping">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded accent-slate-900 dark:accent-white" />
          <span className="text-[14px] text-slate-700 dark:text-slate-200">
            Include this account in sweeps
          </span>
        </label>
        {!enabled && (
          <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-2">
            Its existing findings stay visible. They are just no longer updated, so treat them as a
            record of the last time anyone looked.
          </p>
        )}
      </Block>

      {error && <Note intent="danger">{error}</Note>}

      <div className="flex items-center justify-end gap-3 mt-5">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary"
          disabled={saving || !accountId || !name
            || (method === "role" && !isHome && !roleArn)
            || (method === "keys" && !isHome && !account?.keyHint && !(accessKeyId && secretAccessKey))}
          onClick={() => onSave({
            accountId, name, regions, enabled,
            ...(isHome ? {} : {
              access: method,
              ...(method !== "keys" && { externalId: externalId || undefined }),
              ...(method === "role" && { roleArn }),
              ...(method === "keys" && accessKeyId && secretAccessKey && { accessKeyId, secretAccessKey } as any),
            }),
          })}>
          {/* The button says what actually happens: the account is not stored
              until the role has been assumed successfully. */}
          {saving ? "Checking access…" : account ? "Save" : "Add account"}
        </Button>
      </div>
      </Sheet>
    </>
  );
}

// ── Exclusions ────────────────────────────────────────────────────────

function ExclusionsTab({ lists }: { lists?: AwsExclusionList[] }) {
  const save = useSaveAwsExclusion();
  const remove = useDeleteAwsExclusion();
  const [editing, setEditing] = useState<AwsExclusionList | "new" | null>(null);

  if (editing) {
    return (
      <ExclusionEditor
        list={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSave={(body, id) => save.mutateAsync({ id, body }).then(() => setEditing(null))}
      />
    );
  }

  return (
    <>
      <Note intent="neutral">
        An exclusion list is a set of resources your guardrails should skip. Attach a list to a rule and
        anything it matches is left alone — useful for scratch buckets, sandbox log groups, or anything
        deliberately configured differently.
      </Note>

      <div className="flex items-center justify-between gap-4 mb-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {lists?.length ?? 0} {(lists?.length ?? 0) === 1 ? "list" : "lists"}
        </p>
        <Button variant="primary" onClick={() => setEditing("new")}>New list</Button>
      </div>

      {!lists?.length ? (
        <Empty
          title="No exclusion lists"
          body="Create one to stop guardrails flagging resources you have deliberately left as they are."
          action={<Button variant="primary" onClick={() => setEditing("new")}>Create a list</Button>}
        />
      ) : (
        <div className="grid gap-3">
          {lists.map((l, i) => {
            const rules = l.patterns?.length ?? 0;
            const named = l.resources?.length ?? 0;
            const kept = l.whitelist?.length ?? 0;
            return (
              <RailCard key={l.id} intent="neutral" index={i}>
                <div className="flex items-start justify-between gap-5 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>{l.name}</h3>
                    {l.description && (
                      <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>{l.description}</p>
                    )}
                    <ul className="mt-3 grid gap-1.5">
                      {(l.patterns ?? []).map(p => (
                        <li key={p.id} className="text-[13px] text-slate-600 dark:text-slate-300">
                          <span className="text-slate-400 dark:text-slate-500">Skip anything whose </span>
                          {describeRule(p.type as MatchType, p.value)}
                        </li>
                      ))}
                      {(l.resources ?? []).map(r => (
                        <li key={r} className="text-[13px] text-slate-600 dark:text-slate-300">
                          <span className="text-slate-400 dark:text-slate-500">Skip exactly </span>
                          <span className="font-mono font-semibold">{r}</span>
                        </li>
                      ))}
                      {(l.whitelist ?? []).map(w => (
                        <li key={w} className="text-[13px] text-emerald-700 dark:text-emerald-400">
                          <span className="opacity-70">But always check </span>
                          <span className="font-mono font-semibold">{w}</span>
                        </li>
                      ))}
                    </ul>
                    {rules + named + kept === 0 && (
                      <p className="text-[13px] text-amber-600 dark:text-amber-400 mt-2">
                        This list is empty, so it excludes nothing.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-4 shrink-0">
                    <button onClick={() => setEditing(l)}
                      className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:opacity-70">Edit</button>
                    <button onClick={() => { if (confirm(`Delete "${l.name}"? Rules using it will start checking those resources again.`)) remove.mutate(l.id); }}
                      className="text-sm font-bold text-rose-600 dark:text-rose-400 hover:opacity-70">Delete</button>
                  </div>
                </div>
              </RailCard>
            );
          })}
        </div>
      )}
    </>
  );
}

function describeRule(type: MatchType, value: string) {
  if (type === "tag_equals") {
    const [k, v] = value.includes("=") ? [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)] : [value, null];
    return v
      ? <>tag <span className="font-mono font-semibold">{k}</span> equals <span className="font-mono font-semibold">{v}</span></>
      : <>tag <span className="font-mono font-semibold">{k}</span> is set</>;
  }
  return (
    <>name {type === "starts_with" ? "starts with" : "contains"}{" "}
      <span className="font-mono font-semibold">{value}</span></>
  );
}

function ExclusionEditor({ list, onClose, onSave }: {
  list: AwsExclusionList | null; onClose: () => void;
  onSave: (body: Partial<AwsExclusionList>, id?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [rules, setRules] = useState<{ id: string; type: MatchType; value: string; tagValue?: string }[]>(
    (list?.patterns ?? []).map(p => {
      if (p.type === "tag_equals" && p.value.includes("=")) {
        const i = p.value.indexOf("=");
        return { id: p.id, type: "tag_equals" as MatchType, value: p.value.slice(0, i), tagValue: p.value.slice(i + 1) };
      }
      return { id: p.id, type: p.type as MatchType, value: p.value };
    })
  );
  const [names, setNames] = useState<string[]>(list?.resources ?? []);
  const [nameDraft, setNameDraft] = useState("");
  const [keep, setKeep] = useState<string[]>(list?.whitelist ?? []);
  const [keepDraft, setKeepDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Preview against the resources guardrails have actually seen.
  const { data: findings } = useFindings();
  const known = useMemo(() => {
    const set = new Set<string>();
    (findings ?? []).forEach(f => set.add(f.resourceId));
    return [...set].sort();
  }, [findings]);

  const matched = useMemo(() => known.filter(id => {
    if (keep.includes(id)) return false;
    if (names.includes(id)) return true;
    return rules.some(r => {
      if (!r.value.trim()) return false;
      if (r.type === "starts_with") return id.startsWith(r.value);
      if (r.type === "contains") return id.includes(r.value);
      return false; // tags are not carried on findings, so they cannot be previewed
    });
  }), [known, rules, names, keep]);

  const hasTagRule = rules.some(r => r.type === "tag_equals" && r.value.trim());

  const addRule = () => setRules(rs => [...rs, { id: `p${Date.now()}`, type: "starts_with", value: "" }]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError("Give the list a name so you can recognise it later."); return; }
    const patterns = rules
      .filter(r => r.value.trim())
      .map(r => ({
        id: r.id,
        type: r.type,
        value: r.type === "tag_equals" && r.tagValue?.trim() ? `${r.value.trim()}=${r.tagValue.trim()}` : r.value.trim(),
      }));
    if (patterns.length === 0 && names.length === 0) {
      setError("Add at least one rule or one exact name, or the list will not exclude anything.");
      return;
    }
    try {
      await onSave({ name: name.trim(), description: description.trim(), patterns: patterns as any, resources: names, whitelist: keep }, list?.id);
    } catch (e) { setError((e as Error).message); }
  };

  const field = SURFACE.input;

  return (
    <>
      <Back onClick={onClose}>Exclusion lists</Back>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
        <Sheet>
          <SheetHeader intent="neutral" title={list ? list.name : "New exclusion list"}
            subtitle="Resources this list matches are skipped by every rule that uses it." />

          <Block title="Name this list">
            <input value={name} onChange={e => setName(e.target.value)} className={field}
              placeholder="Sandbox and scratch resources" />
            <input value={description} onChange={e => setDescription(e.target.value)} className={`${field} mt-2`}
              placeholder="Optional — why these are excluded" />
          </Block>

          <Block title="Matching rules" action={<Button onClick={addRule}>Add rule</Button>}>
            {rules.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No rules yet. Add one to skip resources by name or tag, or list exact names below.
              </p>
            ) : (
              <div className="grid gap-3">
                {rules.map((r, i) => {
                  const kind = MATCH_KINDS.find(k => k.id === r.type)!;
                  return (
                    <div key={r.id} className={`rounded-xl p-3.5 ${SURFACE.inset}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <select value={r.type}
                          onChange={e => setRules(rs => rs.map((x, j) => j === i ? { ...x, type: e.target.value as MatchType } : x))}
                          className={`${field} w-auto min-w-[170px]`}>
                          {MATCH_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                        </select>
                        <input value={r.value} placeholder={kind.placeholder}
                          onChange={e => setRules(rs => rs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                          className={`${field} flex-1 min-w-[140px] font-mono`} />
                        {r.type === "tag_equals" && (
                          <>
                            <span className="text-slate-400 font-bold">=</span>
                            <input value={r.tagValue ?? ""} placeholder="dev (optional)"
                              onChange={e => setRules(rs => rs.map((x, j) => j === i ? { ...x, tagValue: e.target.value } : x))}
                              className={`${field} flex-1 min-w-[120px] font-mono`} />
                          </>
                        )}
                        <button onClick={() => setRules(rs => rs.filter((_, j) => j !== i))}
                          title="Remove this rule"
                          className="w-9 h-9 rounded-xl grid place-items-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors shrink-0">
                          <i className="ph-bold ph-trash"></i>
                        </button>
                      </div>
                      <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-2">
                        {kind.help} <span className="text-slate-400 dark:text-slate-500">e.g. {kind.example}</span>
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </Block>

          <Block title="Exact names">
            <TokenInput
              values={names} draft={nameDraft} setDraft={setNameDraft}
              onAdd={v => setNames(n => n.includes(v) ? n : [...n, v])}
              onRemove={v => setNames(n => n.filter(x => x !== v))}
              placeholder="my-bucket-name — press Enter"
              intent="neutral"
            />
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-2">
              Skip these specific resources, whatever the rules above say.
            </p>
          </Block>

          <Block title="Always check anyway">
            <TokenInput
              values={keep} draft={keepDraft} setDraft={setKeepDraft}
              onAdd={v => setKeep(k => k.includes(v) ? k : [...k, v])}
              onRemove={v => setKeep(k => k.filter(x => x !== v))}
              placeholder="prod-logs — press Enter"
              intent="good"
            />
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-2">
              These win over everything above — use one when a rule casts too wide a net and you want a
              single resource pulled back in.
            </p>
          </Block>

          <div className="px-7 py-5 flex items-center gap-3 flex-wrap">
            <Button variant="primary" onClick={submit}>{list ? "Save list" : "Create list"}</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {error && <span className="text-[13px] font-semibold text-rose-600 dark:text-rose-400">{error}</span>}
          </div>
        </Sheet>

        {/* Live preview against resources guardrails have actually seen. */}
        <div className="lg:sticky lg:top-24">
          <Sheet>
            <SheetHeader intent={matched.length > 0 ? "warn" : "neutral"}
              title="What this skips"
              aside={
                <div>
                  <p className="text-[34px] font-black text-white leading-none tabular-nums">{matched.length}</p>
                  <p className={`${TYPE.label} text-white/70 mt-1`}>of {known.length}</p>
                </div>
              } />
            <div className="px-6 py-5">
              {known.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Run a guardrail first and this will show exactly which of your resources the list catches.
                </p>
              ) : matched.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Nothing matches yet. Everything stays covered by your rules.
                </p>
              ) : (
                <ul className="grid gap-1.5 max-h-[380px] overflow-y-auto">
                  {matched.slice(0, 100).map(id => (
                    <li key={id} className="font-mono text-[12.5px] text-slate-600 dark:text-slate-300 truncate" title={id}>
                      {id}
                    </li>
                  ))}
                </ul>
              )}
              {hasTagRule && (
                <p className="text-[12.5px] text-amber-600 dark:text-amber-400 mt-3">
                  Tag rules are not previewed here — tags are read when a guardrail runs, not stored with findings.
                  They will still apply.
                </p>
              )}
            </div>
          </Sheet>
        </div>
      </div>
    </>
  );
}

/** Chip input: type, press Enter. Avoids a textarea whose format has to be learned. */
function TokenInput({ values, draft, setDraft, onAdd, onRemove, placeholder, intent }: {
  values: string[]; draft: string; setDraft: (v: string) => void;
  onAdd: (v: string) => void; onRemove: (v: string) => void;
  placeholder: string; intent: Intent;
}) {
  const commit = () => {
    const v = draft.trim();
    if (v) { onAdd(v); setDraft(""); }
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.map(v => (
          <span key={v} className={`inline-flex items-center gap-1.5 text-[12px] font-mono font-semibold px-2.5 py-1 rounded-lg ${INTENT[intent].soft} ${INTENT[intent].text}`}>
            {v}
            <button onClick={() => onRemove(v)} className="opacity-50 hover:opacity-100" title="Remove">
              <i className="ph-bold ph-x text-[10px]"></i>
            </button>
          </span>
        ))}
      </div>
      <input value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit}
        placeholder={placeholder} className={`${SURFACE.input} font-mono`} />
    </div>
  );
}
