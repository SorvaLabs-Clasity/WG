import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Page, RefreshButton, Button, Back, Note, Empty, Spinner, useCountUp, TYPE, SURFACE, enter } from "../design";
import { useAuth } from "../App";
import { useSecurityQuery, useGraphMeta, useTriggerAggregation } from "../hooks/useGraph";
import { useDependencies } from "../hooks/useDependencies";
import { useRepos } from "../hooks/useRepos";
import { QUERY_OPTIONS } from "../utils/queryOptions";
import { useWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget } from "../hooks/useWidgets";
import { usePermissions } from "../hooks/usePermissions";
import { useOrgConfig } from "../hooks/useOrgConfig";
import type { WidgetConfig } from "../api/widgets";
import { TagInput } from "../components/TagInput";

type WidgetType = "preset" | "query";
type DisplayType = "metric" | "table";
type PresetId = "dependabot" | "bypasses" | "vuln-repos";

/**
 * Which severities the "repositories with vulnerabilities" preset counts.
 *
 * A threshold — "high and above" — cannot express "critical and medium, but
 * not high", and there is no reason it should not be askable. So the setting is
 * a set, stored comma-separated in queryParam so it survives a reload with the
 * rest of the widget's configuration.
 */
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = typeof SEVERITIES[number];

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1 };

/** Thresholds the setting used to hold, kept readable so old widgets survive. */
const LEGACY_THRESHOLDS: Record<string, Severity[]> = {
  any: ["critical", "high", "medium", "low"],
  low: ["critical", "high", "medium", "low"],
  medium: ["critical", "high", "medium"],
  high: ["critical", "high"],
  critical: ["critical"],
};

/**
 * The stored form is prefixed, because a bare severity name is ambiguous.
 *
 * "low" used to mean "low and above", which is everything; as a set it means
 * low alone. Same for "high" and "medium". Without a marker, choosing one
 * severity would silently store the opposite of what was chosen, and the widget
 * would look like it was ignoring the setting.
 */
const SET_PREFIX = "sev:";

export function encodeSeverities(picked: Severity[]): string {
  // Written in the order the app lists them, so two widgets counting the same
  // set produce the same string.
  return SET_PREFIX + SEVERITIES.filter(x => picked.includes(x)).join(",");
}

export function parseSeverities(param: string | undefined): Severity[] {
  const raw = (param ?? "").trim();
  if (!raw) return [...SEVERITIES];

  const explicit = raw.startsWith(SET_PREFIX);
  const body = explicit ? raw.slice(SET_PREFIX.length) : raw;

  if (!explicit && LEGACY_THRESHOLDS[body]) return LEGACY_THRESHOLDS[body];

  const picked = body.split(",").map(x => x.trim().toLowerCase())
    .filter((x): x is Severity => (SEVERITIES as readonly string[]).includes(x));
  // An empty selection would count nothing at all, which reads on the card as
  // a clean check rather than as a misconfigured one.
  return picked.length ? picked : [...SEVERITIES];
}

/** "Critical and high", "all severities" — the label the card and form share. */
export function describeSeverities(picked: Severity[]): string {
  if (picked.length === SEVERITIES.length) return "all severities";
  const ordered = SEVERITIES.filter(s => picked.includes(s));
  if (ordered.length === 1) return `${ordered[0]} only`;
  return ordered.slice(0, -1).join(", ") + " and " + ordered[ordered.length - 1];
}

/**
 * The checks, as cards with weight.
 *
 * The page began as a grid of cards and three redesigns walked away from it —
 * bands, then a ledger, then a bar chart — each one flatter and more austere
 * than the last. That was the wrong direction: /.impeccable.md asks for
 * saturated colour, depth and layering, and names Vanta's control dashboard as
 * the reference. A grid was never the problem; a grid of thin grey boxes with a
 * centred number was.
 *
 * So: cards again, built the way the notes actually describe. Each carries a
 * ring showing how much of the organisation it concerns, a bar repeating that
 * at full width, and the first few affected repositories by name — because a
 * count tells you the size of a problem and a name tells you where it is.
 *
 * Severity drives saturation, elevation and the header wash together, so a card
 * that needs attention is heavier on the page than one that does not, without
 * being a different shape.
 */

type Level = "danger" | "warn" | "info" | "clear";

interface Verdict {
  level: Level;
  value: number;
  denominator: number | null;
  /** 0..1 — how much of what was checked this concerns. */
  share: number | null;
  caption: string;
  eyebrow: string;
}

function verdictFor(items: any[], total: number | null, config: WidgetConfig): Verdict {
  const hasStatus = items.some((i: any) => i.status);
  if (hasStatus) {
    const pass = items.filter((i: any) => i.status === "pass").length;
    const failing = items.length - pass;
    const share = items.length ? failing / items.length : 0;
    return {
      level: failing === 0 ? "clear" : share >= 0.2 ? "danger" : "warn",
      value: failing,
      denominator: items.length,
      share,
      // The ring always reads as "how much is wrong", so a pass/fail check
      // shows its failing share rather than its passing one. Two checks whose
      // rings look the same must mean the same thing.
      caption: failing === 0 ? "all passing" : `failing of ${items.length} checked`,
      eyebrow: failing === 0 ? "Passing" : "Failing",
    };
  }

  const option = config.type === "query" ? QUERY_OPTIONS.find(q => q.id === config.queryId) : undefined;
  const found = items.length;
  const share = total ? Math.min(1, found / total) : null;

  if (config.type === "query" && (option as any)?.informational) {
    return { level: "info", value: found, denominator: total, share, caption: total ? `of ${total} repositories` : "matching", eyebrow: "Matching" };
  }

  return {
    level: found === 0 ? "clear" : share !== null && share >= 0.1 ? "danger" : "warn",
    value: found,
    denominator: total,
    share,
    caption: found === 0 ? "nothing found" : total ? `of ${total} repositories` : "found",
    eyebrow: found === 0 ? "Clear" : "Affected",
  };
}

/**
 * One palette per level, used for the wash, the ring, the bar and the figure at
 * once. Colour is the only thing separating a card that matters from one that
 * does not, so it has to be applied consistently or the grid flattens again.
 */
const TONE: Record<Level, {
  wash: string; ring: string; track: string; bar: string; figure: string; chip: string; edge: string; lift: string;
}> = {
  danger: {
    wash: "bg-gradient-to-br from-rose-500/[0.13] to-rose-500/[0.04] dark:from-rose-500/[0.20] dark:to-rose-500/[0.06]",
    ring: "stroke-rose-500 dark:stroke-rose-400",
    track: "stroke-rose-500/15 dark:stroke-rose-400/15",
    bar: "bg-rose-500 dark:bg-rose-400",
    figure: "text-rose-600 dark:[color:#ff8095]",
    chip: "bg-rose-500 text-white",
    edge: "border-rose-200/80 dark:border-rose-500/25",
    lift: "shadow-[0_18px_40px_-16px_rgba(225,29,72,0.35)] dark:shadow-[0_18px_44px_-16px_rgba(0,0,0,0.8)]",
  },
  warn: {
    wash: "bg-gradient-to-br from-amber-500/[0.13] to-amber-500/[0.04] dark:from-amber-500/[0.20] dark:to-amber-500/[0.06]",
    ring: "stroke-amber-500 dark:stroke-amber-400",
    track: "stroke-amber-500/15 dark:stroke-amber-400/15",
    bar: "bg-amber-500 dark:bg-amber-400",
    figure: "text-amber-600 dark:[color:#ffc14d]",
    chip: "bg-amber-500 text-white",
    edge: "border-amber-200/80 dark:border-amber-500/25",
    lift: "shadow-[0_14px_32px_-16px_rgba(217,119,6,0.30)] dark:shadow-[0_14px_36px_-16px_rgba(0,0,0,0.7)]",
  },
  info: {
    wash: "bg-gradient-to-br from-blue-500/[0.10] to-blue-500/[0.03] dark:from-blue-500/[0.16] dark:to-blue-500/[0.05]",
    ring: "stroke-blue-500 dark:stroke-blue-400",
    track: "stroke-blue-500/15 dark:stroke-blue-400/15",
    bar: "bg-blue-500 dark:bg-blue-400",
    figure: "text-blue-600 dark:[color:#6bb4ff]",
    chip: "bg-blue-500 text-white",
    edge: "border-blue-200/80 dark:border-blue-500/25",
    lift: "shadow-sm",
  },
  clear: {
    wash: "bg-gradient-to-br from-emerald-500/[0.10] to-emerald-500/[0.03] dark:from-emerald-500/[0.14] dark:to-emerald-500/[0.04]",
    ring: "stroke-emerald-500 dark:stroke-emerald-400",
    track: "stroke-emerald-500/15 dark:stroke-emerald-400/15",
    bar: "bg-emerald-500 dark:bg-emerald-400",
    figure: "text-emerald-600 dark:[color:#3ddc97]",
    chip: "bg-emerald-500 text-white",
    edge: "border-emerald-200/80 dark:border-emerald-500/25",
    lift: "shadow-sm",
  },
};

const RANK: Record<Level, number> = { danger: 0, warn: 1, info: 2, clear: 3 };

export default function AnalyticsPage() {
  const { user } = useAuth();
  const { data: widgets = [], isLoading: widgetsLoading, isFetching: widgetsFetching, refetch: refetchWidgets } = useWidgets();
  const createWidget = useCreateWidget();
  const updateWidget = useUpdateWidget();
  const deleteWidgetMut = useDeleteWidget();

  // One dashboard, shared by everyone, so editing it is gated like the rest of
  // the org-wide configuration. The server enforces it; this only stops
  // offering controls that would be refused.
  const { data: permissions } = usePermissions();
  const canEditDashboard = permissions?.isControlHubAdmin ?? false;

  const { data: orgConfig } = useOrgConfig();
  const orgName = orgConfig?.org || "";
  const { data: graphMeta } = useGraphMeta();
  const aggregation = useTriggerAggregation();
  const graphEmpty = graphMeta?.edgeCount === 0;

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const focused = useMemo(() => widgets.find(w => w.id === focusId) ?? null, [widgets, focusId]);

  /**
   * Each card reports its verdict once its data arrives.
   *
   * The parent cannot work this out itself: the queries behind a check depend
   * on its configuration, so evaluating N checks means N hook calls and the
   * list length changes between renders. Reporting upward keeps the hooks where
   * they belong and still lets the page order the grid and state the posture.
   */
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const report = useCallback((id: string, v: Verdict) => {
    setVerdicts(prev => {
      const old = prev[id];
      if (old && old.level === v.level && old.value === v.value && old.share === v.share) return prev;
      return { ...prev, [id]: v };
    });
  }, []);

  const posture = useMemo(() => {
    const seen = widgets.map(w => verdicts[w.id]).filter(Boolean);
    return {
      attention: seen.filter(v => v.level === "danger" || v.level === "warn").length,
      answered: seen.length,
      total: widgets.length,
      worst: (seen.some(v => v.level === "danger") ? "danger" : seen.some(v => v.level === "warn") ? "warn" : "clear") as Level,
    };
  }, [widgets, verdicts]);

  const ordered = useMemo(() => {
    return [...widgets].sort((a, b) => {
      const va = verdicts[a.id], vb = verdicts[b.id];
      const ra = va ? RANK[va.level] : 2.5, rb = vb ? RANK[vb.level] : 2.5;
      return ra - rb || (vb?.share ?? 0) - (va?.share ?? 0) || (vb?.value ?? 0) - (va?.value ?? 0);
    });
  }, [widgets, verdicts]);

  const handleSave = (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => {
    if (editingWidget) {
      updateWidget.mutate({ id: editingWidget.id, data: config }, { onSuccess: () => setEditingWidget(null) });
    } else {
      createWidget.mutate(config, { onSuccess: () => setShowAddModal(false) });
    }
  };

  const removeWidget = (id: string) => {
    if (window.confirm("Remove this from the dashboard?")) deleteWidgetMut.mutate(id);
  };

  return (
    <Page user={user}>
      {focused ? (
        <CheckDetail
          config={focused}
          onBack={() => setFocusId(null)}
          onEdit={() => setEditingWidget(focused)}
          canEdit={canEditDashboard}
          graphEmpty={graphEmpty}
          orgName={orgName}
        />
      ) : (
        <>
      <header className="mb-9" style={enter(0)}>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <p className={`${TYPE.label} text-slate-400 dark:text-slate-500 mb-3`}>
              {orgName || "Organisation"} · {posture.total} {posture.total === 1 ? "check" : "checks"}
            </p>
            <h1 className="text-[38px] sm:text-[52px] font-black tracking-[-0.035em] leading-[1.02] max-w-[18ch]">
              {widgetsLoading ? (
                <span className="text-slate-300 dark:text-slate-700">Reading the organisation…</span>
              ) : posture.total === 0 ? (
                <>Nothing is being watched yet.</>
              ) : posture.answered === 0 ? (
                <span className="text-slate-300 dark:text-slate-700">Working it out…</span>
              ) : posture.attention === 0 ? (
                <>Everything checked is <span className={TONE.clear.figure}>clear</span>.</>
              ) : (
                <>
                  <span className={TONE[posture.worst].figure}>{posture.attention}</span>
                  {" "}of {posture.answered} checks need attention.
                </>
              )}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0 pt-1">
            <RefreshButton busy={widgetsFetching} onRefresh={() => refetchWidgets()} />
            <Button onClick={() => aggregation.mutate()} disabled={aggregation.isPending} className="whitespace-nowrap">
              <i className={`ph-bold ph-arrows-clockwise mr-2 ${aggregation.isPending ? "animate-spin" : ""}`}></i>
              {aggregation.isPending ? "Syncing" : "Sync data"}
            </Button>
            {canEditDashboard && (
              <Button variant="primary" onClick={() => setShowAddModal(true)}>
                <i className="ph-bold ph-plus mr-2"></i>Add check
              </Button>
            )}
          </div>
        </div>
      </header>

      {graphEmpty && (
        <div style={enter(1)} className="mb-5">
          <Note intent="warn">
            The graph has no data, so anything reading from it comes back empty. Sync data to build it.
          </Note>
        </div>
      )}
      {aggregation.isError && (
        <div style={enter(1)} className="mb-5">
          <Note intent="danger">Sync failed — {(aggregation.error as Error)?.message || "unknown error"}.</Note>
        </div>
      )}

      {widgetsLoading ? (
        <Spinner />
      ) : widgets.length === 0 ? (
        <Empty
          title="No checks yet"
          body="A check is a question about the organisation — which repositories have an unprotected default branch, who holds admin nobody granted, which packages are exposing you. Add one and it gets a card here."
          action={canEditDashboard
            ? <Button variant="primary" onClick={() => setShowAddModal(true)}>Add the first check</Button>
            : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 items-start">
          {ordered.map((w, i) => (
            <CheckCard
              key={w.id}
              config={w}
              index={i}
              onOpen={() => setFocusId(w.id)}
              onReport={report}
              canEdit={canEditDashboard}
              onEdit={() => setEditingWidget(w)}
              onRemove={() => removeWidget(w.id)}
              graphEmpty={graphEmpty}
            />
          ))}
        </div>
      )}

        </>
      )}

      {(showAddModal || editingWidget) && (
        <WidgetFormModal
          onClose={() => { setShowAddModal(false); setEditingWidget(null); }}
          onSave={handleSave}
          isSaving={createWidget.isPending || updateWidget.isPending}
          initialData={editingWidget || undefined}
        />
      )}
    </Page>
  );
}

/**
 * The proportion, drawn.
 *
 * Sized in the SVG's own coordinates and scaled by the container, so one
 * component serves every size without a prop for it. The dash offset carries
 * the value: animating that rather than the geometry keeps it on the compositor.
 */
function Ring({ share, tone, children }: { share: number; tone: typeof TONE[Level]; children: React.ReactNode }) {
  const R = 26, C = 2 * Math.PI * R;
  return (
    <div className="relative w-[68px] h-[68px] shrink-0">
      <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
        <circle cx="32" cy="32" r={R} fill="none" strokeWidth="7" className={tone.track} />
        <circle
          cx="32" cy="32" r={R} fill="none" strokeWidth="7" strokeLinecap="round"
          className={tone.ring}
          style={{
            strokeDasharray: C,
            strokeDashoffset: C * (1 - Math.max(0, Math.min(1, share))),
            transition: "stroke-dashoffset 900ms cubic-bezier(0.16,1,0.3,1)",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`text-[15px] font-black tabular-nums ${tone.figure}`}>{children}</span>
      </div>
    </div>
  );
}

/**
 * One check, on its own.
 *
 * Detail used to unroll inside the card, which meant a seven-column table in a
 * third of a row, and then — when the card was widened to fit it — a grid that
 * reflowed around whatever was open. Both were the same mistake: making the
 * board carry something the board is the wrong shape for.
 *
 * So the board steps aside instead. This is the pattern the AWS page already
 * uses, and the table gets the whole width without anything moving underneath
 * it.
 */
function CheckDetail({ config, onBack, onEdit, canEdit, graphEmpty, orgName }: {
  config: WidgetConfig; onBack: () => void; onEdit: () => void;
  canEdit: boolean; graphEmpty?: boolean; orgName?: string;
}) {
  const { items, isLoading, total, entity } = useWidgetData(config);
  const verdict = useMemo(() => verdictFor(items, total, config), [items, total, config]);
  const tone = TONE[verdict.level];
  const pct = verdict.share === null ? null : Math.round(verdict.share * 100);
  const n = useCountUp(verdict.value);

  return (
    <div style={enter(0)}>
      <Back onClick={onBack}>All checks</Back>

      <div className={`${SURFACE.sheet} mb-5`}>
        <div className={`${tone.wash} px-6 sm:px-8 py-7 flex items-start gap-6 flex-wrap`}>
          {pct === null
            ? <Emblem kind={entity} tone={tone} />
            : <Ring share={verdict.share ?? 0} tone={tone}>{`${pct}%`}</Ring>}

          <div className="flex-1 min-w-[220px]">
            <p className={`${TYPE.label} ${tone.figure} mb-2`}>
              {config.type === "preset" && config.presetId === "vuln-repos"
                ? describeSeverities(parseSeverities(config.queryParam))
                : verdict.eyebrow}
            </p>
            <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">{config.title}</h2>
            <p className="flex items-baseline gap-2 mt-3">
              <span className={`text-[38px] font-black tabular-nums leading-none tracking-tight ${tone.figure}`}>{n}</span>
              <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                {verdict.share === null && verdict.value > 0 ? nounFor(entity, verdict.value) : verdict.caption}
              </span>
            </p>
          </div>

          {canEdit && (
            <Button onClick={onEdit}>
              <i className="ph-bold ph-pencil-simple mr-2"></i>Edit check
            </Button>
          )}
        </div>
      </div>

      <div className={`${SURFACE.sheet} overflow-x-auto`}>
        {isLoading
          ? <Spinner />
          : <WidgetDataTable config={config} items={items} graphEmpty={graphEmpty} orgName={orgName} />}
      </div>
    </div>
  );
}

type Entity = "repository" | "user" | "team";

/**
 * What a check counts.
 *
 * Declared on the query rather than inferred: an empty result has no rows to
 * read, and the id is not a description — inferring from a "repos-" prefix is
 * what gave "unowned-repos" no denominator while its neighbour had one.
 */
function entityForConfig(config: WidgetConfig): Entity {
  if (config.type === "preset") return "repository";
  const option = QUERY_OPTIONS.find(q => q.id === config.queryId) as { entity?: Entity } | undefined;
  return option?.entity ?? "repository";
}

const PLURAL: Record<Entity, [string, string]> = {
  repository: ["repository", "repositories"],
  user: ["user", "users"],
  team: ["team", "teams"],
};

const nounFor = (kind: Entity, n: number) => PLURAL[kind][n === 1 ? 0 : 1];

const EMBLEM: Record<Entity, string> = {
  repository: "ph-fill ph-books",
  user: "ph-fill ph-user-circle",
  team: "ph-fill ph-users-three",
};

/**
 * Stands in for the ring when there is no denominator.
 *
 * Same 68px footprint so the header does not change height between cards, and
 * the same tone, so a card about people still reads as urgent or settled at a
 * glance.
 */
function Emblem({ kind, tone }: { kind: Entity; tone: typeof TONE[Level] }) {
  return (
    <div className={`w-[68px] h-[68px] shrink-0 rounded-2xl flex items-center justify-center ${tone.wash} border ${tone.edge}`}>
      <i className={`${EMBLEM[kind]} text-[26px] ${tone.figure}`}></i>
    </div>
  );
}

/** The first few affected things, by name. A count sizes a problem; a name locates it. */
function nameOf(item: any): string {
  return item?.repo || item?.user || item?.team || "—";
}

function detailOf(item: any, config: WidgetConfig): string {
  if (config.type === "preset" && config.presetId === "dependabot") return `${item.total ?? 0} alerts`;
  if (config.type === "preset" && config.presetId === "vuln-repos") return item.worst ?? "";
  if (config.type === "preset" && config.presetId === "bypasses") return `${item.bypasses ?? 0} bypasses`;
  if (item?.status) return item.status;
  const r = String(item?.reason ?? "");
  return r.length > 28 ? r.slice(0, 27) + "…" : r;
}

function CheckCard({
  config, index, onOpen, onReport, canEdit, onEdit, onRemove, graphEmpty,
}: {
  config: WidgetConfig; index: number; onOpen: () => void;
  onReport: (id: string, v: Verdict) => void;
  canEdit: boolean; onEdit: () => void; onRemove: () => void;
  graphEmpty?: boolean;
}) {
  const { items, isLoading, total, entity, error } = useWidgetData(config);
  const verdict = useMemo(() => verdictFor(items, total, config), [items, total, config]);
  const n = useCountUp(verdict.value);
  const tone = TONE[verdict.level];

  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (isLoading) return;
    const t = setTimeout(() => setDrawn(true), 80 + Math.min(index * 60, 400));
    return () => clearTimeout(t);
  }, [isLoading, index]);

  useEffect(() => {
    if (!isLoading) onReport(config.id, verdict);
  }, [isLoading, verdict, config.id, onReport]);

  const pct = verdict.share === null ? null : Math.round(verdict.share * 100);
  const preview = items.filter((i: any) => !i.status || i.status === "fail").slice(0, 3);
  const hidden = Math.max(0, verdict.value - preview.length);

  if (error) {
    return (
      <article style={enter(index)}
        className="group rounded-2xl border border-amber-200/80 dark:border-amber-500/25 bg-white dark:bg-[#151a23] overflow-hidden">
        <div className="bg-gradient-to-br from-amber-500/[0.13] to-amber-500/[0.04] dark:from-amber-500/[0.20] dark:to-amber-500/[0.06] px-5 pt-5 pb-4 flex items-start gap-4">
          <div className="w-[68px] h-[68px] shrink-0 rounded-2xl flex items-center justify-center bg-amber-500/10 border border-amber-200/80 dark:border-amber-500/25">
            <i className="ph-fill ph-warning text-[26px] text-amber-600 dark:[color:#ffc14d]"></i>
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <p className={`${TYPE.label} text-amber-600 dark:[color:#ffc14d] mb-1.5`}>Not running</p>
            <h3 className="text-[15px] font-black text-slate-900 dark:text-white leading-tight line-clamp-2">{config.title}</h3>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-slate-100 dark:border-white/[0.06]">
          <p className="text-[13px] text-slate-500 dark:text-slate-400 leading-relaxed">{error.message}</p>
          {canEdit && (
            <div className="flex gap-2 mt-3">
              <button onClick={e => { e.stopPropagation(); onEdit(); }}
                className="text-[12.5px] font-bold text-slate-700 dark:text-slate-200 hover:underline">Edit check</button>
              <button onClick={e => { e.stopPropagation(); onRemove(); }}
                className="text-[12.5px] font-bold text-rose-600 dark:text-rose-400 hover:underline">Remove</button>
            </div>
          )}
        </div>
      </article>
    );
  }

  if (isLoading) {
    return (
      <div className={`${SURFACE.card} p-6 h-[268px]`} style={enter(index)}>
        <div className="flex items-center gap-4">
          <div className="w-[68px] h-[68px] rounded-full bg-slate-100 dark:bg-white/[0.06] animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-20 rounded bg-slate-100 dark:bg-white/[0.06] animate-pulse" />
            <div className="h-4 w-32 rounded bg-slate-100 dark:bg-white/[0.06] animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <article
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={enter(index)}
      className={`group cursor-pointer rounded-2xl border ${tone.edge} ${tone.lift} bg-white dark:bg-[#151a23] overflow-hidden
        transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/30`}
    >
      {/* Header: the wash lives here rather than over the whole card, so the
          names below stay on a plain surface and remain readable. */}
      <div className={`${tone.wash} px-5 pt-5 pb-4`}>
        <div className="flex items-start gap-4">
          {pct === null ? (
            // Nothing to take a share of — a check about people or teams has no
            // repository count behind it, so a ring reading "—" was a chart of
            // nothing. A marked disc says what kind of thing was counted
            // instead, and keeps the header the same height either way.
            <Emblem kind={entity} tone={tone} />
          ) : (
            <Ring share={verdict.share ?? 0} tone={tone}>{`${pct}%`}</Ring>
          )}

          <div className="flex-1 min-w-0 pt-1">
            <p className={`${TYPE.label} ${tone.figure} mb-1.5 truncate`}>
              {/* Two of these can sit side by side counting different
                  severities, and the title alone will not say which. */}
              {config.type === "preset" && config.presetId === "vuln-repos"
                ? describeSeverities(parseSeverities(config.queryParam))
                : verdict.eyebrow}
            </p>
            <h3 className="text-[15px] font-black text-slate-900 dark:text-white leading-tight line-clamp-2">
              {config.title}
            </h3>
          </div>

          {canEdit && (
            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 hover:opacity-100 transition-opacity">
              <button onClick={e => { e.stopPropagation(); onEdit(); }} title="Edit"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white/60 dark:hover:bg-white/10 transition-colors">
                <i className="ph-bold ph-pencil-simple text-[13px]"></i>
              </button>
              <button onClick={e => { e.stopPropagation(); onRemove(); }} title="Remove"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-white/60 dark:hover:bg-white/10 transition-colors">
                <i className="ph-bold ph-trash text-[13px]"></i>
              </button>
            </div>
          )}
        </div>

        <div className="mt-4">
          <p className="flex items-baseline gap-2">
            <span className={`text-[32px] font-black tabular-nums leading-none tracking-tight ${tone.figure}`}>{n}</span>
            <span className="text-[13px] font-semibold text-slate-500 dark:text-slate-400">
              {verdict.share === null && verdict.value > 0
                ? nounFor(entity, verdict.value)
                : verdict.caption}
            </span>
          </p>
          {verdict.share !== null && (
            <div className="mt-3 h-1.5 rounded-full bg-slate-900/[0.07] dark:bg-white/[0.08] overflow-hidden">
              <div
                className={`h-full rounded-full origin-left ${tone.bar}`}
                style={{
                  transform: `scaleX(${drawn ? Math.max(verdict.share, verdict.value > 0 ? 0.012 : 0) : 0})`,
                  transition: "transform 700ms cubic-bezier(0.16,1,0.3,1)",
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Names. Two-line cells, so what is affected is on the card rather than
          one click away. */}
      <div className="px-5 py-4 border-t border-slate-100 dark:border-white/[0.06]">
        {preview.length === 0 ? (
          <p className="text-[13px] text-slate-400 dark:text-slate-500 py-1.5">
            {graphEmpty ? "No graph data — sync to populate." : "Nothing to show."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {preview.map((item: any, k: number) => (
              <li key={k} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="font-mono text-slate-700 dark:text-slate-200 truncate">{nameOf(item)}</span>
                <span className="text-slate-400 dark:text-slate-500 shrink-0 truncate max-w-[45%]">{detailOf(item, config)}</span>
              </li>
            ))}
          </ul>
        )}

        <button
          onClick={onOpen}
          className={`mt-3 -mb-1 w-full flex items-center justify-between text-[12.5px] font-bold ${tone.figure} hover:opacity-80 transition-opacity`}
        >
          <span>{hidden > 0 ? `${hidden} more` : "Open"}</span>
          <i className="ph-bold ph-arrow-right text-[11px]"></i>
        </button>
      </div>

    </article>
  );
}

function useWidgetData(config: WidgetConfig) {
  const { data: depsData, isLoading: depsLoading } = useDependencies();
  const isBypass = config.type === "preset" && config.presetId === "bypasses";
  const { data: bypassData, isLoading: bypassLoading } = useSecurityQuery(isBypass ? "protection-bypasses-ranking" : null);

  const isQuery = config.type === "query";
  const { data: queryData, isLoading: queryLoading, error: queryError } = useSecurityQuery(isQuery ? config.queryId! : null, config.queryParam, config.queryAdvanced);

  const { data: repos } = useRepos();

  const { items, isLoading } = useMemo(() => {
    let rawItems: any[] = [];
    let loading = false;

    if (config.type === "preset") {
      if (config.presetId === "dependabot") {
        loading = depsLoading;
        const map = new Map<string, any>();
        if (depsData) {
          for (const dep of depsData) {
            if (dep.clean || dep.disabled) continue;
            if (!map.has(dep.repo)) map.set(dep.repo, { repo: dep.repo, total: 0, critical: 0, high: 0, medium: 0, low: 0 });
            const e = map.get(dep.repo)!;
            e.total++;
            if (dep.severity === "critical") e.critical++;
            else if (dep.severity === "high") e.high++;
            else if (dep.severity === "medium" || (dep.severity as string) === "moderate") e.medium++;
            else e.low++;
          }
        }
        rawItems = Array.from(map.values()).sort((a, b) => b.critical !== a.critical ? b.critical - a.critical : b.high !== a.high ? b.high - a.high : b.total - a.total);
      } else if (config.presetId === "vuln-repos") {
        // Reads the same ["dependencies"] query the Dependabot tab uses, so
        // adding this widget costs no additional GitHub requests — the list is
        // one request per repository and must not be fetched twice.
        loading = depsLoading;
        const wanted = new Set<string>(parseSeverities(config.queryParam));
        // GitHub calls it "moderate"; the rest of the app calls it medium.
        if (wanted.has("medium")) wanted.add("moderate");
        const map = new Map<string, any>();
        for (const dep of depsData ?? []) {
          if (dep.clean || dep.disabled || dep.scanning) continue;
          if (!wanted.has(dep.severity)) continue;
          if (!map.has(dep.repo)) map.set(dep.repo, { repo: dep.repo, total: 0, worst: "low" });
          const e = map.get(dep.repo)!;
          e.total++;
          if ((SEVERITY_RANK[dep.severity] ?? 0) > (SEVERITY_RANK[e.worst] ?? 0)) e.worst = dep.severity;
        }
        rawItems = Array.from(map.values()).sort(
          (a, b) => (SEVERITY_RANK[b.worst] - SEVERITY_RANK[a.worst]) || b.total - a.total);
      } else if (config.presetId === "bypasses") {
        loading = bypassLoading;
        rawItems = bypassData || [];
      }
    } else {
      loading = queryLoading;
      rawItems = queryData || [];
    }

    return { items: rawItems, isLoading: loading };
  }, [config, depsData, depsLoading, bypassData, bypassLoading, queryData, queryLoading]);

  // Only a check that counts repositories has the organisation as its
  // denominator. Users and teams do not, and a share of the wrong thing is
  // worse than no share.
  const entity = entityForConfig(config);
  const total = entity === "repository" && repos ? repos.length : null;

  // A widget whose check has been removed returns nothing, which on a card
  // looks exactly like a check that found nothing. Carrying the failure up
  // means it can say so instead of reading as clean.
  return { items, isLoading, total, entity, error: (queryError as Error) ?? null };
}

/* ─── Widget Card (Grid View) ─── */

function WidgetDataTable({ config, items, graphEmpty, orgName }: { config: WidgetConfig; items: any[]; graphEmpty?: boolean; orgName?: string }) {
  const [selectedItem, setSelectedItem] = useState<any | null>(null);

  if (items.length === 0) {
    return (
      <div className="p-12 text-center text-slate-500 dark:text-slate-400">
        {graphEmpty ? (
          <>
            <i className="ph-fill ph-database text-4xl text-amber-500 mb-3 block opacity-80"></i>
            <p className="font-medium text-slate-700 dark:text-slate-300 mb-1">No graph data available</p>
            <p className="text-sm">Use the "Sync Now" button above to pull data from GitHub before running queries.</p>
          </>
        ) : (
          <>
            <i className="ph-fill ph-check-circle text-4xl text-emerald-500 mb-3 block opacity-80"></i>
            No data matches this query or preset.
          </>
        )}
      </div>
    );
  }

  const hasStatus = items.some((i: any) => i.status);

  return (
    <>
      <table className="w-full text-left border-collapse">
        <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0 z-10 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
          <tr>
            <th className="px-6 py-3 w-16">#</th>
            <th className="px-6 py-3">Entity</th>

            {config.type === "preset" && config.presetId === "dependabot" && (
              <>
                <th className="px-6 py-3 text-center text-rose-600 dark:text-red-400">Critical</th>
                <th className="px-6 py-3 text-center text-orange-500 dark:text-orange-400">High</th>
                <th className="px-6 py-3 text-center text-amber-600 dark:text-amber-400">Medium</th>
                <th className="px-6 py-3 text-center text-slate-500 dark:text-slate-400">Low</th>
                <th className="px-6 py-3 text-center">Total</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "vuln-repos" && (
              <>
                <th className="px-6 py-3 text-center">Worst</th>
                <th className="px-6 py-3 text-center">Alerts</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "bypasses" && (
              <>
                <th className="px-6 py-3">Bypasses</th>
                <th className="px-6 py-3 w-full">Reason</th>
              </>
            )}
            {config.type === "query" && hasStatus && <th className="px-6 py-3 text-center w-[80px]">Status</th>}
            {config.type === "query" && <th className="px-6 py-3 w-full">Details</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
          {items.map((item: any, idx: number) => {
            const name = item.repo || item.user || item.team || "Unknown";
            return (
              <tr
                key={idx}
                className={`group hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer ${idx % 2 === 1 ? 'bg-slate-50/50 dark:bg-slate-800/50' : ''}`}
                onClick={() => setSelectedItem(item)}
              >
                <td className="px-6 py-4 font-mono text-slate-400 dark:text-slate-500 text-xs">{String(idx + 1).padStart(3, "0")}</td>
                <td className="px-6 py-4">
                  <div className="font-bold text-slate-800 dark:text-slate-200">{name}</div>
                  {config.type === "query" && (
                    <div className="text-xs text-slate-400 dark:text-slate-500 font-mono">{item.repo ? "repository" : item.user ? "user" : item.team ? "team" : "unknown"}</div>
                  )}
                </td>

                {config.type === "preset" && config.presetId === "dependabot" && (
                  <>
                    <td className="px-6 py-4 text-center font-mono font-medium text-rose-600 dark:text-red-400">{item.critical || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-orange-500 dark:text-orange-400">{item.high || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-amber-600 dark:text-amber-400">{item.medium || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-slate-500 dark:text-slate-400">{item.low || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-bold">{item.total}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "vuln-repos" && (
                  <>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide ${
                        item.worst === "critical" ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400"
                        : item.worst === "high" ? "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400"
                        : item.worst === "medium" || item.worst === "moderate" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"}`}>
                        {item.worst}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center font-mono font-bold">{item.total}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "bypasses" && (
                  <>
                    <td className="px-6 py-4 font-mono font-bold text-rose-600 dark:text-red-400">{item.bypasses}</td>
                    <td className="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 truncate">{item.reason}</td>
                  </>
                )}

                {config.type === "query" && hasStatus && (
                  <td className="px-6 py-4 text-center">
                    {item.status === "pass" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                        <i className="fas fa-check-circle"></i> Pass
                      </span>
                    ) : item.status === "fail" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-50 dark:bg-red-950/50 text-rose-700 dark:text-red-400 border border-rose-200 dark:border-red-800">
                        <i className="fas fa-times-circle"></i> Fail
                      </span>
                    ) : null}
                  </td>
                )}
                {config.type === "query" && (
                  <td className="px-6 py-4 text-sm">
                    <span className={`block truncate max-w-xl ${item.status === "fail" ? "text-rose-700 dark:text-red-400" : "text-slate-800 dark:text-slate-200"}`}>{item.reason}</span>
                    {item.details && <span className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5 block truncate max-w-xl">{item.details}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {selectedItem && <RawDetailsModal item={selectedItem} config={config} onClose={() => setSelectedItem(null)} orgName={orgName} />}
    </>
  );
}

/* ─── Raw Details Modal ─── */

function RawDetailsModal({ item, config, onClose, orgName }: { item: any; config: WidgetConfig; onClose: () => void; orgName?: string }) {
  const name = item.repo || item.user || item.team || "Unknown Entity";

  let githubLink = null;
  if (item.repo && orgName) {
    githubLink = `https://github.com/${orgName}/${item.repo}`;
    if (config.type === "preset" && config.presetId === "dependabot") {
      githubLink += "/security/dependabot";
    }
  } else if (item.user) {
    githubLink = `https://github.com/${item.user}`;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-900 shrink-0 rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <i className="ph-fill ph-info text-blue-600 dark:text-blue-400"></i>
            {name}
          </h3>
          <div className="flex items-center gap-3">
            {githubLink && (
              <a
                href={githubLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 border border-slate-200 dark:border-slate-700"
              >
                <i className="ph-fill ph-github-logo text-sm"></i>
                View in GitHub
              </a>
            )}
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div className="p-6 overflow-y-auto bg-slate-50 dark:bg-slate-950 flex-1 rounded-b-2xl">
          <div className="flex flex-col gap-4">
            {item.status && (
              <div className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Status</span>
                <div>
                  {item.status === "pass" ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-check-circle"></i>Passing</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-rose-700 dark:text-red-400 bg-rose-50 dark:bg-red-950/50 border border-rose-200 dark:border-red-800 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-x-circle"></i>Failing</span>
                  )}
                </div>
              </div>
            )}
            {item.status === "fail" && item.reason && (
              <div className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Failure Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).replace(/"/g, "").trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-rose-50 dark:bg-red-950/50 border border-rose-200 dark:border-red-800 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-800 dark:text-rose-300 bg-rose-100 dark:bg-rose-900 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-rose-700 dark:text-red-400">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {item.status === "pass" && item.reason && (
              <div className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Branch Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-emerald-700 dark:text-emerald-400">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {Object.entries(item).filter(([k]) => !["repo", "user", "team", "status", "reason"].includes(k)).map(([k, v], i) => (
              <div key={i} className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto whitespace-pre-wrap font-mono">
                  {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                </pre>
              </div>
            ))}
            {!item.status && Object.entries(item).filter(([k]) => ["reason"].includes(k)).map(([k, v], i) => (
              <div key={`r-${i}`} className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto whitespace-pre-wrap font-mono">
                  {String(v)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Widget Details Modal (expanded from grid card) ─── */


/* ─── Widget Form Modal (Add / Edit) ─── */

function WidgetFormModal({ onClose, onSave, isSaving, initialData }: { onClose: () => void; onSave: (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => void; isSaving?: boolean; initialData?: WidgetConfig }) {
  const isEditing = !!initialData;
  const [title, setTitle] = useState(initialData?.title || "");
  const [type, setType] = useState<WidgetType>(initialData?.type || "preset");
  const [presetId, setPresetId] = useState<PresetId>((initialData?.presetId as PresetId) || "dependabot");
  // Reuses queryParam rather than adding a field, so it persists with the rest
  // of the widget without a schema change.
  const [picked, setSeverities] = useState<Severity[]>(() => parseSeverities(initialData?.queryParam));
  const [displayType, setDisplayType] = useState<DisplayType>(initialData?.displayType || "metric");

  const [selectedQueryId, setSelectedQueryId] = useState<string>(initialData?.queryId || QUERY_OPTIONS[0].id);
  const initParam = initialData?.queryParam || "";
  const initQuery = initialData?.queryId ? QUERY_OPTIONS.find(q => q.id === initialData.queryId) : null;
  const initAdv = initialData?.queryAdvanced;
  const [paramValue, setParamValue] = useState<string>(initQuery?.useTagInput ? "" : initParam);
  const [branchTags, setBranchTags] = useState<string[]>(initQuery?.useTagInput && initParam ? initParam.split(",").map(s => s.trim()).filter(Boolean) : []);
  const [hasPendingBranch, setHasPendingBranch] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [protectionType, setProtectionType] = useState<string>(initAdv?.protectionType || "any");
  const [ruleMatchType, setRuleMatchType] = useState<string>(initAdv?.ruleMatchType || "at_least");
  const [requirePr, setRequirePr] = useState(initAdv?.requirePr || false);
  const [minApprovals, setMinApprovals] = useState(initAdv?.minApprovals ?? 1);
  const [dismissStaleReviews, setDismissStaleReviews] = useState(initAdv?.dismissStaleReviews || false);
  const [requireCodeOwnerReviews, setRequireCodeOwnerReviews] = useState(initAdv?.requireCodeOwnerReviews || false);
  const [requireConversationResolution, setRequireConversationResolution] = useState(initAdv?.requireConversationResolution || false);
  const [requireStatusChecks, setRequireStatusChecks] = useState(initAdv?.requireStatusChecks || false);
  const [strictStatusChecks, setStrictStatusChecks] = useState(initAdv?.strictStatusChecks || false);
  const [requireSignedCommits, setRequireSignedCommits] = useState(initAdv?.requireSignedCommits || false);
  const [requireLinearHistory, setRequireLinearHistory] = useState(initAdv?.requireLinearHistory || false);
  const [enforceAdmins, setEnforceAdmins] = useState(initAdv?.enforceAdmins || false);
  const [preventForcePush, setPreventForcePush] = useState(initAdv?.preventForcePush || false);
  const [preventDeletion, setPreventDeletion] = useState(initAdv?.preventDeletion || false);

  const selectedQuery = QUERY_OPTIONS.find(q => q.id === selectedQueryId);

  const handleQuerySelect = (id: string) => {
    setSelectedQueryId(id);
    const q = QUERY_OPTIONS.find(opt => opt.id === id);
    if (q?.requiresParam && q.paramDefault) setParamValue(q.paramDefault);
    else setParamValue("");
    setBranchTags([]);
  };

  const pendingBranchError = type === "query" && selectedQuery?.useTagInput && hasPendingBranch;
  const emptyBranchError = type === "query" && selectedQuery?.useTagInput && branchTags.length === 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!title.trim()) return;
    if (pendingBranchError || emptyBranchError) return;
    if (type === "query" && selectedQuery?.requiresParam && !selectedQuery?.useTagInput && !paramValue.trim()) return;

    if (type === "preset") {
      onSave({
        title, type, presetId, displayType,
        ...(presetId === "vuln-repos" && { queryParam: encodeSeverities(picked) }),
      });
    } else {
      let advanced = undefined;
      if (selectedQuery?.hasAdvancedRules) {
        advanced = {
          protectionType,
          ruleMatchType,
          requirePr,
          minApprovals,
          dismissStaleReviews,
          requireCodeOwnerReviews,
          requireConversationResolution,
          requireStatusChecks,
          strictStatusChecks,
          requireSignedCommits,
          requireLinearHistory,
          enforceAdmins,
          preventForcePush,
          preventDeletion,
        };
      }
      const resolvedParam = selectedQuery?.useTagInput ? branchTags.join(", ") : paramValue.trim();
      onSave({
        title,
        type,
        queryId: selectedQueryId,
        queryParam: selectedQuery?.requiresParam ? resolvedParam : undefined,
        queryAdvanced: advanced,
        displayType,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-xl relative z-10 animate-slide-up flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">{isEditing ? "Edit Widget" : "Add Dashboard Widget"}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white"><i className="ph ph-x text-lg"></i></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Widget Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
              placeholder="e.g. My Custom Metric"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Data Source</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as WidgetType)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
              >
                <option value="preset">Built-in Ranking Presets</option>
                <option value="query">Security Insight Query</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Display Format</label>
              <select
                value={displayType}
                onChange={(e) => setDisplayType(e.target.value as DisplayType)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
              >
                <option value="metric">Big Metric (Count)</option>
                <option value="table">List / Table</option>
              </select>
            </div>
          </div>

          <div className="p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg space-y-4">
            {type === "preset" ? (
              <div>
                <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Select Preset</label>
                <select
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value as PresetId)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                >
                  <option value="dependabot">Dependabot Issues Ranking</option>
                  <option value="vuln-repos">Repositories with vulnerabilities</option>
                  <option value="bypasses">Protection Rule Bypasses</option>
                </select>

                {presetId === "vuln-repos" && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between gap-3 mb-2">
                      <label className="block text-sm font-semibold text-slate-900 dark:text-white">Count which severities</label>
                      <button
                        type="button"
                        onClick={() => setSeverities(picked.length === SEVERITIES.length ? ["critical"] : [...SEVERITIES])}
                        className="text-[12px] font-bold text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {picked.length === SEVERITIES.length ? "Critical only" : "Select all"}
                      </button>
                    </div>

                    {/* Any combination, not a threshold — "critical and medium
                        but not high" is a reasonable thing to ask for. */}
                    <div className="grid grid-cols-2 gap-2">
                      {SEVERITIES.map(sev => {
                        const on = picked.includes(sev);
                        return (
                          <button
                            key={sev}
                            type="button"
                            onClick={() => setSeverities(
                              on ? picked.filter(x => x !== sev) : [...picked, sev]
                            )}
                            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-semibold capitalize transition-colors ${
                              on
                                ? "border-slate-900 dark:border-white bg-slate-900 dark:bg-white text-white dark:text-slate-900"
                                : "border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-500"}`}
                          >
                            <i className={`ph-bold ${on ? "ph-check-square" : "ph-square"} text-base`}></i>
                            {sev}
                          </button>
                        );
                      })}
                    </div>

                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2.5">
                      Counting <span className="font-semibold text-slate-600 dark:text-slate-300">{describeSeverities(picked)}</span>.
                      Repositories, not alerts — a repo with six criticals counts once. Reads the same
                      data as the Dependabot tab, so this widget makes no extra GitHub requests.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Select Insight Query</label>
                  <select
                    value={selectedQueryId}
                    onChange={(e) => handleQuerySelect(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                  >
                    {QUERY_OPTIONS.map(q => (
                      <option key={q.id} value={q.id}>{q.label}</option>
                    ))}
                  </select>
                </div>

                {selectedQuery?.requiresParam && (
                  <div>
                    <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">{selectedQuery.paramLabel}</label>
                    {selectedQuery.useTagInput ? (
                      <>
                        <TagInput
                          tags={branchTags}
                          onChange={setBranchTags}
                          onPendingTextChange={setHasPendingBranch}
                          icon="ph-git-branch"
                          colorClass="blue"
                          placeholder="Type branch name and press Enter"
                        />
                        {submitAttempted && pendingBranchError && (
                          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                            <i className="ph-bold ph-warning-circle"></i>
                            Press Enter to confirm the branch name before saving.
                          </p>
                        )}
                        {submitAttempted && emptyBranchError && !pendingBranchError && (
                          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                            <i className="ph-bold ph-warning-circle"></i>
                            At least one branch name is required.
                          </p>
                        )}
                      </>
                    ) : (
                      <input
                        type="text"
                        value={paramValue}
                        onChange={(e) => setParamValue(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                        required
                      />
                    )}
                  </div>
                )}

                {selectedQuery?.hasAdvancedRules && (
                  <div className="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-3">
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Branch Rule Configuration</label>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 dark:text-white mb-1">Protection Type</label>
                        <select
                          value={protectionType}
                          onChange={(e) => setProtectionType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded-md text-sm outline-none focus:border-blue-500 bg-white dark:bg-slate-800 dark:text-slate-200"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="classic">Must use Classic Protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 dark:text-white mb-1">Rule Matching Mode</label>
                        <select
                          value={ruleMatchType}
                          onChange={(e) => setRuleMatchType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded-md text-sm outline-none focus:border-blue-500 bg-white dark:bg-slate-800 dark:text-slate-200"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>
                    </div>

                    {ruleMatchType !== "any" && (
                      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                        <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Required Rules</h4>
                        <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={requirePr} onChange={e => setRequirePr(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Require Pull Request
                          </label>
                          {requirePr && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-slate-500 dark:text-slate-400">Min. Approvals:</span>
                              <input
                                type="number" min={1} max={5}
                                value={minApprovals}
                                onChange={(e) => setMinApprovals(parseInt(e.target.value))}
                                className="w-16 rounded-md border-slate-300 dark:border-slate-600 py-1 px-2 text-xs ring-1 ring-inset ring-slate-300 dark:ring-slate-600 outline-none focus:border-blue-500 bg-white dark:bg-slate-800 dark:text-slate-200"
                              />
                            </div>
                          )}
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={dismissStaleReviews} onChange={e => setDismissStaleReviews(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Dismiss stale reviews
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={preventForcePush} onChange={e => setPreventForcePush(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Prevent force pushing
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={preventDeletion} onChange={e => setPreventDeletion(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Prevent deletion
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={enforceAdmins} onChange={e => setEnforceAdmins(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Enforce for admins
                          </label>
                        </div>

                        <details className="group/det mt-3">
                          <summary className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 cursor-pointer hover:underline list-none flex items-center gap-1 select-none pt-2 border-t border-slate-100 dark:border-slate-700">
                            <i className="ph-bold ph-caret-right text-[10px] group-open/det:rotate-90 transition-transform"></i>
                            Advanced Rules
                          </summary>
                          <div className="grid grid-cols-2 gap-y-2 gap-x-4 pt-3 mt-1 text-sm">
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireCodeOwnerReviews} onChange={e => setRequireCodeOwnerReviews(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require Code Owner review
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireConversationResolution} onChange={e => setRequireConversationResolution(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require conversation resolution
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireStatusChecks} onChange={e => setRequireStatusChecks(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require status checks
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={strictStatusChecks} onChange={e => setStrictStatusChecks(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Strict status checks (up to date)
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireSignedCommits} onChange={e => setRequireSignedCommits(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require signed commits
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireLinearHistory} onChange={e => setRequireLinearHistory(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require linear history
                            </label>
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 dark:text-slate-300 transition-colors" disabled={isSaving}>
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors" disabled={isSaving}>
              {isSaving ? "Saving..." : isEditing ? "Update Widget" : "Save Widget"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
