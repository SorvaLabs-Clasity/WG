import { useState, useEffect, useMemo } from "react";
import { useComplianceDashboard, useComplianceConfig, useUpdateComplianceConfig, useRefreshCompliance } from "../hooks/useCompliance";
import { useAuth } from "../App";
import type { ComplianceRule, RepoComplianceScore } from "../types/Compliance";
import { TagInput } from "../components/TagInput";
import { QUERY_OPTIONS } from "../utils/queryOptions";
import {
  Page, PageHeader, StatusSlab, SlabPercent, Button, Segmented, SearchInput,
  Sheet, SheetHeader, Block, RailCard, Note, Chip, Pill, Back, Empty, Spinner,
  TYPE, SURFACE, INTENT, enter, type Intent,
} from "../design";

const RULE_TYPE_LABELS: Record<string, string> = {
  branch_protection: "Branch protection",
  tag_protection: "Tag protection",
  rulesets: "Active rulesets",
  required_files: "Required files",
  outside_collaborators: "Outside collaborators",
  query: "Security query",
  codeowners: "CODEOWNERS",
};

/** Icon per rule type, kept for the rule cards. */
const RULE_TYPE_ICONS: Record<string, string> = {
  branch_protection: "ph-fill ph-shield-check",
  tag_protection: "ph-fill ph-tag",
  rulesets: "ph-fill ph-list-checks",
  required_files: "ph-fill ph-file-text",
  outside_collaborators: "ph-fill ph-users-three",
  query: "ph-fill ph-magnifying-glass",
  codeowners: "ph-fill ph-users-four",
};

const RULE_ICON_COLORS: Record<string, { bg: string; text: string }> = {
  branch_protection: { bg: "bg-blue-50 dark:bg-blue-950/50", text: "text-blue-600 dark:text-blue-400" },
  tag_protection: { bg: "bg-teal-50 dark:bg-teal-950/50", text: "text-teal-600 dark:text-teal-400" },
  rulesets: { bg: "bg-indigo-50 dark:bg-indigo-950/50", text: "text-indigo-600 dark:text-indigo-400" },
  required_files: { bg: "bg-cyan-50 dark:bg-cyan-950/50", text: "text-cyan-600 dark:text-cyan-400" },
  outside_collaborators: { bg: "bg-amber-50 dark:bg-amber-950/50", text: "text-amber-600 dark:text-amber-400" },
  query: { bg: "bg-violet-50 dark:bg-violet-950/50", text: "text-violet-600 dark:text-violet-400" },
  codeowners: { bg: "bg-purple-50 dark:bg-purple-950/50", text: "text-purple-600 dark:text-purple-400" },
};

const newId = () => `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Score bands. Colour means the same thing here as everywhere else in the app. */
function band(score: number): Intent {
  if (score < 0) return "neutral";
  return score >= 90 ? "good" : score >= 70 ? "warn" : "danger";
}

const HEX: Record<Intent, string> = {
  good: "#10b981", warn: "#f59e0b", danger: "#f43f5e", info: "#3b82f6", neutral: "#94a3b8",
};

/** Conic-gradient ring. Reads as a dial rather than another progress bar. */
function Ring({ score, size = 56, thick = 5 }: { score: number; size?: number; thick?: number }) {
  const i = band(score);
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="relative shrink-0 grid place-items-center" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${HEX[i]} ${pct * 3.6}deg, rgba(148,163,184,0.18) 0deg)` }} />
      <div className="absolute rounded-full bg-white dark:bg-slate-900"
        style={{ inset: thick }} />
      <span className="relative text-[13px] font-black tabular-nums" style={{ color: HEX[i] }}>
        {score < 0 ? "—" : score}
      </span>
    </div>
  );
}

export default function ComplianceDashboardPage() {
  const { user } = useAuth();
  const { data: scores, isLoading } = useComplianceDashboard();
  const { data: configData, isLoading: configLoading } = useComplianceConfig();
  const updateConfig = useUpdateComplianceConfig();
  const refresh = useRefreshCompliance();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"worst" | "best" | "name">("worst");
  const [status, setStatus] = useState<"all" | "passing" | "failing">("all");
  const [view, setView] = useState<{ k: "list" } | { k: "repo"; repo: RepoComplianceScore } | { k: "rules" }>({ k: "list" });
  const [rules, setRules] = useState<(ComplianceRule & { fileInputVal?: string })[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (configData?.rules) setRules(configData.rules.map(r => ({ ...r })));
  }, [configData]);

  const valid = useMemo(() => (scores ?? []).filter(s => s.score >= 0), [scores]);

  const stats = useMemo(() => {
    const avg = valid.length ? Math.round(valid.reduce((a, s) => a + s.score, 0) / valid.length) : 0;
    return {
      avg,
      total: scores?.length ?? 0,
      passing: valid.filter(s => s.score >= 90).length,
      failing: valid.filter(s => s.score < 70).length,
      warn: valid.filter(s => s.score >= 70 && s.score < 90).length,
      lastChecked: (scores ?? []).reduce<string | undefined>((a, s) => (!a || s.lastChecked > a ? s.lastChecked : a), undefined),
    };
  }, [scores, valid]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (scores ?? []).filter(s => {
      if (q && !s.repo.toLowerCase().includes(q)) return false;
      if (status === "passing" && s.score < 90) return false;
      if (status === "failing" && (s.score >= 70 || s.score < 0)) return false;
      return true;
    });
    return [...list].sort((a, b) =>
      sort === "name" ? a.repo.localeCompare(b.repo)
        : sort === "best" ? b.score - a.score
          : a.score - b.score);
  }, [scores, search, status, sort]);

  if (isLoading || configLoading) return <Page user={user}><Spinner /></Page>;

  const updateRule = (i: number, patch: Partial<ComplianceRule & { fileInputVal?: string }>) =>
    setRules(rs => rs.map((r, x) => (x === i ? { ...r, ...patch } : r)));

  const save = async () => {
    const clean = rules.map(({ fileInputVal, ...r }) => r);
    await updateConfig.mutateAsync({ rules: clean } as any);
    setSaved("Rules saved. Scores recalculate on the next refresh.");
    setTimeout(() => setSaved(null), 4000);
  };

  const totalWeight = rules.filter(r => r.enabled).reduce((a, r) => a + (r.weight ?? 0), 0);

  return (
    <Page user={user}>
      <PageHeader
        title="Compliance"
        subtitle="How every repository scores against the rules you define."
        actions={
          <>
            <Button onClick={() => setView({ k: "rules" })}>
              Rules <span className="text-slate-400 font-mono ml-1">{rules.length}</span>
            </Button>
            <Button variant="primary" disabled={refresh.isPending} onClick={() => refresh.mutate(undefined as any)}>
              {refresh.isPending ? "Rescanning…" : "Rescan all"}
            </Button>
          </>
        }
      />

      <StatusSlab
        intent={stats.failing > 0 ? "danger" : stats.warn > 0 ? "warn" : "good"}
        eyebrow={stats.failing > 0 ? "Repositories below standard" : stats.warn > 0 ? "Room to improve" : "Fully compliant"}
        metrics={[
          { value: stats.failing, label: "failing", emphasis: true },
          { value: stats.warn, label: "partial" },
          { value: stats.passing, label: "passing" },
        ]}
        aside={<SlabPercent value={stats.avg} label="average score" />}
        footer={<>{stats.total} repositories scored against {rules.filter(r => r.enabled).length} active rules</>}
      />

      {saved && <Note intent="good">{saved}</Note>}
      {totalWeight !== 100 && rules.length > 0 && (
        <Note intent="warn">
          Enabled rule weights total <strong className="font-bold">{totalWeight}</strong>, not 100 — scores are
          normalised, but the numbers will not read as percentages of anything.
        </Note>
      )}

      {view.k === "rules" ? (
        <>
          <Back onClick={() => setView({ k: "list" })}>Back to repositories</Back>
          <div className="max-w-3xl">
            <Sheet>
              <SheetHeader intent="info" title="Rule configuration"
                subtitle="Each rule contributes its weight to a repository's score."
                aside={
                  <div className="text-right">
                    <p className="text-[34px] font-black text-white leading-none tabular-nums">{totalWeight}</p>
                    <p className={`${TYPE.label} text-white/60 mt-1`}>total weight</p>
                  </div>
                } />
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {rules.map((rule, i) => (
                  <div key={rule.id} style={enter(i, 35, 280)}>
                    <RuleCard rule={rule}
                      onToggle={() => updateRule(i, { enabled: !rule.enabled })}
                      onRemove={() => setRules(rs => rs.filter((_, x) => x !== i))}
                      onUpdate={p => updateRule(i, p)}
                      onUpdateField={(f, v) => updateRule(i, { [f]: v } as any)}
                      onUpdateRules={(f, v) => updateRule(i, { rules: { ...(rule.rules ?? {}), [f]: v } })} />
                  </div>
                ))}
              </div>
              <div className="px-7 py-5 flex items-center gap-3 flex-wrap">
                <Button variant="primary" disabled={updateConfig.isPending} onClick={save}>
                  {updateConfig.isPending ? "Saving…" : "Save rules"}
                </Button>
                <Button onClick={() => setRules(rs => [...rs, {
                  id: newId(), name: "New rule", enabled: true, weight: 10, type: "branch_protection", branchName: "__default__", protectionType: "any",
                }])}>
                  Add rule
                </Button>
              </div>
            </Sheet>
          </div>
        </>
      ) : view.k === "repo" ? (
        <RepoDetail score={view.repo} onBack={() => setView({ k: "list" })} />
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap mb-5">
            <SearchInput value={search} onChange={setSearch} placeholder="Search repositories" />
            <Segmented value={status} onChange={setStatus} options={[
              ["all", `All ${stats.total}`], ["failing", `Failing ${stats.failing}`], ["passing", `Passing ${stats.passing}`],
            ]} />
            <Segmented value={sort} onChange={setSort} options={[
              ["worst", "Worst first"], ["best", "Best first"], ["name", "A–Z"],
            ]} />
          </div>

          {filtered.length === 0 ? (
            <Empty title="Nothing matches" body="Try clearing the search or filters." />
          ) : (
            <div className="grid gap-3">
              {filtered.slice(0, 200).map((s, i) => {
                const failed = (s.ruleResults ?? []).filter(r => !r.passed);
                return (
                  <RailCard key={s.repo} intent={band(s.score)} index={i} onClick={() => setView({ k: "repo", repo: s })}>
                    <div className="flex items-center gap-5">
                      <Ring score={s.score} />
                      <div className="min-w-0 flex-1">
                        <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>{s.repo}</h3>
                        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>
                          {s.score < 0 ? "Not yet scored"
                            : failed.length === 0 ? "Every rule passing"
                              : `${failed.length} of ${s.ruleResults?.length ?? 0} rules failing`}
                        </p>
                        {failed.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {failed.slice(0, 4).map(r => <Chip key={r.ruleId} intent="danger">{r.ruleName}</Chip>)}
                            {failed.length > 4 && <Chip intent="neutral">+{failed.length - 4} more</Chip>}
                          </div>
                        )}
                      </div>
                      <i className="ph-bold ph-caret-right text-slate-300 dark:text-slate-600 group-hover:translate-x-0.5 transition-transform"></i>
                    </div>
                  </RailCard>
                );
              })}
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function RepoDetail({ score, onBack }: { score: RepoComplianceScore; onBack: () => void }) {
  const failed = (score.ruleResults ?? []).filter(r => !r.passed);
  const passed = (score.ruleResults ?? []).filter(r => r.passed);
  return (
    <>
      <Back onClick={onBack}>All repositories</Back>
      <div className="max-w-3xl">
        <Sheet>
          <SheetHeader intent={band(score.score)} title={score.repo}
            subtitle={`Last checked ${new Date(score.lastChecked).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}
            aside={
              <div className="text-right">
                <p className="text-[44px] font-black text-white leading-none tabular-nums">{score.score < 0 ? "—" : score.score}</p>
                <p className={`${TYPE.label} text-white/70 mt-1.5`}>score</p>
              </div>
            } />
          {failed.length > 0 && (
            <Block title={`Failing — ${failed.length}`}>
              <ul className="space-y-2.5">
                {failed.map(r => (
                  <li key={r.ruleId} className="flex items-start gap-3">
                    <i className="ph-fill ph-x-circle text-rose-500 text-lg mt-0.5 shrink-0"></i>
                    <div>
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{r.ruleName}</p>
                      {r.detail && <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">{r.detail}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </Block>
          )}
          {passed.length > 0 && (
            <Block title={`Passing — ${passed.length}`}>
              <ul className="grid sm:grid-cols-2 gap-2">
                {passed.map(r => (
                  <li key={r.ruleId} className="flex items-center gap-2.5 text-sm text-slate-600 dark:text-slate-300">
                    <i className="ph-fill ph-check-circle text-emerald-500 shrink-0"></i>{r.ruleName}
                  </li>
                ))}
              </ul>
            </Block>
          )}
          {score.issues?.length > 0 && (
            <Block title="Notes">
              <ul className="space-y-1.5">
                {score.issues.map((issue, i) => (
                  <li key={i} className="text-[13px] text-slate-500 dark:text-slate-400">{issue}</li>
                ))}
              </ul>
            </Block>
          )}
        </Sheet>
      </div>
    </>
  );
}

function RuleCard({ rule, onToggle, onRemove, onUpdate, onUpdateField, onUpdateRules }: {
  rule: ComplianceRule & { fileInputVal?: string };
  onToggle: () => void;
  onRemove: () => void;
  onUpdate: (p: Partial<ComplianceRule & { fileInputVal?: string }>) => void;
  onUpdateField: (f: string, v: unknown) => void;
  onUpdateRules: (f: string, v: unknown) => void;
}) {
  const ic = RULE_ICON_COLORS[rule.type] || { bg: "bg-slate-50 dark:bg-slate-800", text: "text-slate-600 dark:text-slate-400" };

  return (
    <div className={`bg-white dark:bg-slate-900 rounded-xl border shadow-sm overflow-hidden transition-all ${rule.enabled ? "border-slate-200 dark:border-slate-700" : "border-dashed border-slate-300 dark:border-slate-600 opacity-60"}`}>
      <div className="p-4 flex items-center gap-4">
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input type="checkbox" checked={rule.enabled} onChange={onToggle} className="sr-only peer" />
          <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white dark:after:bg-slate-200 after:border-gray-300 dark:after:border-slate-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-800 dark:peer-checked:bg-blue-600"></div>
        </label>
        <div className={`w-10 h-10 rounded-lg ${ic.bg} ${ic.text} flex items-center justify-center shrink-0`}>
          <i className={`${RULE_TYPE_ICONS[rule.type]} text-lg`}></i>
        </div>
        <input type="text" value={rule.name} onChange={e => onUpdateField("name", e.target.value)} className="flex-1 font-bold text-slate-800 dark:text-slate-200 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-slate-500 dark:focus:border-slate-400 focus:outline-none transition-colors text-sm" />
        <div className="flex items-center gap-2 shrink-0">
          <input type="number" min={0} max={100} value={rule.weight} onChange={e => onUpdateField("weight", Number(e.target.value))} className="w-14 h-8 text-center text-sm font-mono border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 rounded focus:ring-2 focus:ring-slate-400/20 focus:border-slate-400 outline-none" />
          <button onClick={onRemove} className="w-8 h-8 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 transition-colors"><i className="fa-regular fa-trash-can"></i></button>
        </div>
      </div>

      {rule.enabled && (
        <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 pt-4">
          {rule.type === "branch_protection" && <BranchProtectionConfig rule={rule} onUpdateField={onUpdateField} onUpdateRules={onUpdateRules} onUpdate={onUpdate} />}
          {rule.type === "tag_protection" && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">Tag patterns that must have active ruleset protection (e.g. v*, release-*).</p>
              <TagInput tags={rule.tagPatterns || []} onChange={tags => onUpdateField("tagPatterns", tags)} placeholder="e.g. v* or release-* + Enter" icon="ph-tag" colorClass="gray" />
            </div>
          )}
          {rule.type === "rulesets" && <p className="text-xs text-slate-500 dark:text-slate-400">Checks that at least one active repository ruleset exists.</p>}
          {rule.type === "required_files" && <RequiredFilesConfig rule={rule} onUpdate={onUpdate} />}
          {rule.type === "outside_collaborators" && (
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">Max allowed</label>
              <input type="number" min={0} value={rule.maxOutsideCollaborators ?? 0} onChange={e => onUpdateField("maxOutsideCollaborators", Number(e.target.value))} className="w-16 text-center text-xs border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 rounded px-2 py-1.5 outline-none focus:border-slate-400" />
            </div>
          )}
          {rule.type === "codeowners" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">Checks for a <code className="bg-slate-100 dark:bg-slate-700 px-1 py-0.5 rounded font-mono text-[11px]">CODEOWNERS</code> file in standard locations.</p>
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">Required Entries <span className="font-normal">(optional)</span></label>
                <TagInput tags={rule.codeownersRequireEntries || []} onChange={tags => onUpdate({ codeownersRequireEntries: tags })} placeholder="e.g. * @org/security-team + Enter" />
              </div>
            </div>
          )}
          {rule.type === "query" && <QueryRuleConfig rule={rule} onUpdateField={onUpdateField} />}
        </div>
      )}
    </div>
  );
}

function RequiredFilesConfig({ rule, onUpdate }: { rule: ComplianceRule & { fileInputVal?: string }; onUpdate: (p: Partial<ComplianceRule & { fileInputVal?: string }>) => void }) {
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && rule.fileInputVal?.trim()) {
      e.preventDefault();
      const f = rule.fileInputVal.trim();
      if (!rule.requiredFiles?.includes(f)) onUpdate({ requiredFiles: [...(rule.requiredFiles || []), f], fileInputVal: "" });
    } else if (e.key === "Backspace" && !rule.fileInputVal && rule.requiredFiles?.length) {
      e.preventDefault();
      onUpdate({ requiredFiles: rule.requiredFiles.slice(0, -1) });
    }
  };
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">File Paths</label>
      <div className="flex flex-wrap gap-2 items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg p-2 focus-within:border-slate-400 focus-within:ring-1 focus-within:ring-slate-400/20 transition-all">
        {(rule.requiredFiles || []).map(f => (
          <span key={f} className="px-2 py-1 bg-slate-100 dark:bg-slate-700 text-xs text-slate-600 dark:text-slate-300 rounded border border-slate-200 dark:border-slate-600 font-mono flex items-center gap-1">
            {f}
            <button type="button" onClick={() => onUpdate({ requiredFiles: rule.requiredFiles?.filter(x => x !== f) })} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"><i className="fa-solid fa-xmark text-[9px]"></i></button>
          </span>
        ))}
        <input type="text" value={rule.fileInputVal || ""} onChange={e => onUpdate({ fileInputVal: e.target.value })} onKeyDown={handleKey} placeholder={rule.requiredFiles?.length ? "Add file + Enter" : "e.g. README.md + Enter"} className="flex-1 min-w-[140px] border-none focus:ring-0 text-xs py-0.5 font-mono bg-transparent outline-none shadow-none placeholder-slate-400 dark:placeholder-slate-500 dark:text-slate-200" />
      </div>
    </div>
  );
}

function BranchProtectionConfig({ rule, onUpdateField, onUpdateRules, onUpdate }: {
  rule: ComplianceRule & { hasPendingBranch?: boolean };
  onUpdateField: (f: string, v: unknown) => void;
  onUpdateRules: (f: string, v: unknown) => void;
  onUpdate: (p: Partial<ComplianceRule & { hasPendingBranch?: boolean }>) => void;
}) {
  const hasRules = !!rule.rules && Object.values(rule.rules).some(v => v !== undefined && v !== false && v !== 0);
  const raw = rule.branchName ?? "__default__";
  const branches = raw.split(",").map(b => b.trim()).filter(Boolean);
  const isDefault = branches.includes("__default__");
  const tags = branches.filter(b => b !== "__default__");
  const build = (t: string[], d: boolean) => { const p = [...t]; if (d) p.push("__default__"); return p.length ? p.join(", ") : ""; };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex-1 space-y-2">
          <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">Branches</label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={isDefault} onChange={e => onUpdateField("branchName", build(tags, e.target.checked))} className="rounded border-slate-300 dark:border-slate-600 text-slate-800 focus:ring-slate-500" />
            <span className="font-medium text-slate-700 dark:text-slate-300">Include default branch</span>
          </label>
          <TagInput tags={tags} onChange={t => onUpdateField("branchName", build(t, isDefault))} placeholder="Branch name + Enter" onPendingTextChange={p => onUpdate({ hasPendingBranch: p })} icon="ph-git-branch" colorClass="blue" />
        </div>
        <div className="w-full sm:w-48 space-y-2">
          <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">Type</label>
          <select value={rule.protectionType || "any"} onChange={e => onUpdateField("protectionType", e.target.value)} className="block w-full rounded-md text-xs border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 py-1.5 px-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-600 outline-none focus:border-slate-400">
            <option value="any">Any protection</option>
            <option value="classic">Classic only</option>
            <option value="ruleset">Ruleset only</option>
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input type="checkbox" checked={hasRules} onChange={e => { if (e.target.checked) onUpdate({ rules: { requirePr: true, minApprovals: 1 } }); else onUpdate({ rules: undefined }); }} className="rounded border-slate-300 dark:border-slate-600 text-slate-800 focus:ring-slate-500" />
        <span className="font-medium text-slate-700 dark:text-slate-300">Check specific rules</span>
      </label>

      {hasRules && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-4">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requirePr} onChange={e => onUpdateRules("requirePr", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require Pull Request</span></label>
            {rule.rules?.requirePr && (
              <div className="flex items-center gap-2 text-xs"><span className="text-slate-500 dark:text-slate-400">Min Approvals:</span><input type="number" min={1} max={5} value={rule.rules?.minApprovals || 1} onChange={e => onUpdateRules("minApprovals", parseInt(e.target.value))} className="w-14 rounded border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 py-0.5 px-2 text-xs outline-none focus:border-slate-400" /></div>
            )}
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.dismissStaleReviews} onChange={e => onUpdateRules("dismissStaleReviews", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Dismiss stale reviews</span></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.preventForcePush} onChange={e => onUpdateRules("preventForcePush", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Prevent force push</span></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.preventDeletion} onChange={e => onUpdateRules("preventDeletion", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Prevent deletion</span></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.enforceAdmins} onChange={e => onUpdateRules("enforceAdmins", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Enforce for admins</span></label>
          </div>
          <details className="group/adv">
            <summary className="text-xs font-bold text-slate-500 dark:text-slate-400 cursor-pointer flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300 select-none pt-2 border-t border-slate-100 dark:border-slate-700">
              Advanced <i className="fa-solid fa-chevron-down text-[9px] transition-transform group-open/adv:rotate-180"></i>
            </summary>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-4 pl-2 border-l-2 border-slate-200 dark:border-slate-600">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireCodeOwnerReviews} onChange={e => onUpdateRules("requireCodeOwnerReviews", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require Code Owner review</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireConversationResolution} onChange={e => onUpdateRules("requireConversationResolution", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require conversation resolution</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireStatusChecks} onChange={e => onUpdateRules("requireStatusChecks", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require status checks</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.strictStatusChecks} onChange={e => onUpdateRules("strictStatusChecks", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Strict status checks</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireSignedCommits} onChange={e => onUpdateRules("requireSignedCommits", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require signed commits</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireLinearHistory} onChange={e => onUpdateRules("requireLinearHistory", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require linear history</span></label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function QueryRuleConfig({ rule, onUpdateField }: { rule: ComplianceRule; onUpdateField: (f: string, v: unknown) => void }) {
  const sel = QUERY_OPTIONS.find(q => q.id === rule.queryId);
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">Query</label>
        <select value={rule.queryId || ""} onChange={e => onUpdateField("queryId", e.target.value)} className="block w-full rounded-md text-xs border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 py-1.5 px-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-600 outline-none focus:border-slate-400">
          {QUERY_OPTIONS.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
        </select>
      </div>
      {sel?.requiresParam && (
        <div>
          <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">{sel.paramLabel}</label>
          <input type="text" value={rule.queryParam || ""} onChange={e => onUpdateField("queryParam", e.target.value)} className="block w-full rounded-md text-xs border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 py-1.5 px-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-600 outline-none focus:border-slate-400" />
        </div>
      )}
      <p className="text-[10px] text-slate-500 dark:text-slate-400">Repos matching this query will fail this compliance check.</p>
    </div>
  );
}
