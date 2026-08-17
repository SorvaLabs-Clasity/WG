import { useState, useMemo } from "react";
import { useTableControls } from "../hooks/useTableControls";
import { useAuth } from "../App";
import { Page, StatusSlab, SlabPercent, RailCard, Sheet, SheetHeader, Block, Back, Note, Pill, Button, Empty, Spinner, Figure, InsetRow, Segmented, TYPE, SURFACE, INTENT, enter, type Intent, RefreshButton,
  SearchInput, Pager,
} from "../design";
import { usePermissions } from "../hooks/usePermissions";
import {
  useCatalog, useGuardrails, useFindings, useAwsExclusions,
  useCreateGuardrail, useUpdateGuardrail, useDeleteGuardrail, useRunGuardrails,
  useSaveAwsExclusion, useDeleteAwsExclusion,
  useAwsAccounts,
} from "../hooks/useAws";
import type { Guardrail, CatalogEntry, Finding, AwsExclusionList, ParamSpec, AwsAccount, AwsAccessMethod } from "../api/aws";
import { awsConsoleUrl, consoleLinkLabel } from "../utils/awsConsole";

const KIND_LABELS: Record<string, string> = {
  s3_https_only: "S3 — deny non-TLS requests",
  log_retention_min: "CloudWatch Logs — minimum retention",
};

const label = (kind: string) => KIND_LABELS[kind] ?? kind;

/** Violations first when sorting by verdict — alphabetically "compliant" wins, which is backwards. */
const VERDICT_ORDER: Record<string, number> = { violation: 0, not_applicable: 1, compliant: 2 };

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
  const candidates = showPassing ? [...failing, ...rest] : failing;

  // Search covers what identifies a finding to a person: the resource, its
  // type, the account and region it lives in, and the summary text.
  const table = useTableControls(candidates, {
    searchText: f => `${f.resourceId} ${f.resourceType} ${f.accountName ?? ""} ${f.accountId ?? ""} ${f.region ?? ""} ${f.summary}`,
    columns: [
      { key: "resource", label: "Resource", value: f => f.resourceId },
      { key: "verdict", label: "Verdict", value: f => VERDICT_ORDER[f.verdict] ?? 99 },
      { key: "account", label: "Account", value: f => f.accountName ?? f.accountId ?? "" },
      { key: "region", label: "Region", value: f => f.region ?? "" },
      { key: "checked", label: "Checked", value: f => f.checkedAt ?? "" },
    ],
    perPage: 50,
  });
  const shown = table.visible;
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
            <>
            {/* Threshold on the whole finding set, not the visible subset.
                Keying it off `candidates` meant a rule with five failures and
                three hundred passes showed no search box until you revealed
                the passing ones — and the control appeared and vanished as you
                toggled, which reads as a bug even when you find it. */}
            {findings.length > 8 && (
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <SearchInput value={table.search} onChange={table.setSearch} placeholder="Search resources…" />
                <Segmented value={table.sortKey ?? "verdict"} onChange={table.toggleSort} options={[
                  ["verdict", "Verdict"],
                  ["resource", "Resource"],
                  ["region", "Region"],
                ]} />
              </div>
            )}
            {shown.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Nothing in {table.totalCount} findings matches "{table.search.trim()}".
              </p>
            ) : (
            <ul className="grid gap-2">
              {shown.map((f, i) => {
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
                          {/* The region, not the account: there is only one
                              account now, but a finding's region still tells you
                              where to go and look. */}
                          {f.region && (
                            <span className="shrink-0 text-[11.5px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                              {f.region}
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
            <Pager
              page={table.page} totalPages={table.totalPages} onPage={table.setPage}
              matchCount={table.matchCount} totalCount={table.totalCount}
              filtered={table.filtered} noun="findings"
            />
            </>
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
  const [error, setError] = useState<string | null>(null);

  const { data: accounts } = useAwsAccounts();

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

/** A console screen's fields, in the order it asks for them. */
function Fields({ rows }: { rows: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <dl className="grid gap-2">
      {rows.map(([label, value], i) => (
        <div key={i} className="grid sm:grid-cols-[170px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt className="text-[12.5px] font-bold text-slate-500 dark:text-slate-400">{label}</dt>
          <dd className="text-[12.5px] text-slate-600 dark:text-slate-300">{value}</dd>
        </div>
      ))}
    </dl>
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
 * a gap — creating IAM roles across an organization needs permissions that
 * would let whoever held them deploy an administrator role everywhere, which
 * is worse than the administrator access this app was built without. So it
 * does everything that costs nothing: works out every value, generates the
 * external ID, carries the template, and builds the links. What is left is
 * clicking Create while signed in as yourself.
 */
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
    if (!name.trim()) { setError("Give the list a name so you can recognize it later."); return; }
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
