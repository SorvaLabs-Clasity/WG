import React, { useState, useMemo, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Page, RefreshButton, Button, Back, Note, Empty, Spinner, useCountUp, TYPE, SURFACE, enter, SearchInput, Pager, ColumnResizeHandle } from "../design";
import { useTableControls } from "../hooks/useTableControls";
import { useColumnWidths } from "../hooks/useColumnWidths";
import { widgetColumns, defaultWidths, layoutId } from "../lib/widgetColumns";
import { PRESET_LABELS, presetOptions } from "../lib/widgetPresets";
import { fetchRenovate } from "../api/renovate";
import { apiGet } from "../api/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../lib/ago";
import RecrawlButton from "../components/RecrawlButton";
import AlarmModal from "../components/AlarmModal";
import { useAlarms } from "../hooks/useAlarms";
import { useAuth } from "../App";
import { useSecurityQuery, useGraphMeta, useTriggerAggregation, useGraphAggregation, useQueryFreshness, useRefreshQueryNow } from "../hooks/useGraph";
import { useDependencies } from "../hooks/useDependencies";
import { useRepos } from "../hooks/useRepos";
import { QUERY_OPTIONS, paramNoun } from "../utils/queryOptions";
import { useWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget, useWidgetSnapshots } from "../hooks/useWidgets";
import { usePermissions } from "../hooks/usePermissions";
import { useOrgConfig } from "../hooks/useOrgConfig";
import type { WidgetConfig } from "../api/widgets";
import { TagInput } from "../components/TagInput";
import { IncompleteQueryError } from "../api/client";
import { applyWidgetFilters, activeFilterCount } from "../lib/widgetFilters";

/**
 * The checks that read GitHub once per subject and therefore keep dated,
 * per-subject answers. Kept in one place because three separate lists of the
 * same three names is three chances for one of them to fall behind.
 */
/**
 * The checks whose answers are stored per subject rather than derived on the
 * spot, and so have an age and a "re-check now".
 *
 * Keyed by the query they run, not by how a widget happens to be configured:
 * "Protection rule bypasses" exists both as a preset and as a Security Insight
 * Query, and both run `protection-bypasses-ranking`. Matching only the query
 * form meant the preset showed neither its age nor the button, so somebody who
 * had just fixed a violation had no way to re-check and nothing telling them
 * the number was up to a day old.
 */
const BATCHED_CHECKS = new Set([
  "dormant-privileged-users",
  "stale-branch-protections",
  "protection-bypasses-ranking",
]);

/** Presets that are one of those checks wearing a friendlier name. */
const PRESET_QUERIES: Record<string, string> = {
  bypasses: "protection-bypasses-ranking",
};

/** The batched query a widget runs, however it was configured. */
function batchedQueryOf(config: { type: string; queryId?: string; presetId?: string }): string | null {
  const q = config.type === "query"
    ? config.queryId
    : PRESET_QUERIES[config.presetId ?? ""];
  return q && BATCHED_CHECKS.has(q) ? q : null;
}

/**
 * How long ago, in the shortest form that is still honest.
 *
 * Rounded down deliberately: a check taken fifty-nine minutes ago reads as
 * "59m", never "1h". Rounding up would make a stored answer look fresher than
 * it is, which is the one direction this must not be wrong in.
 */
function since(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type WidgetType = "preset" | "query";
type DisplayType = "metric" | "table";
type PresetId = "dependabot" | "bypasses" | "vuln-repos" | "renovate-open";

/**
 * Which severities the "repositories with vulnerabilities" preset counts.
 *
 * A threshold, "high and above", cannot express "critical and medium, but
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
 * As a threshold "low" means low and above, which is everything; as a set it
 * means low alone. Without a marker, choosing one severity silently stores the
 * opposite of what was chosen and the widget looks like it is ignoring the
 * setting.
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

/** "Critical and high", "all severities", the label the card and form share. */
export function describeSeverities(picked: Severity[]): string {
  if (picked.length === SEVERITIES.length) return "all severities";
  const ordered = SEVERITIES.filter(s => picked.includes(s));
  if (ordered.length === 1) return `${ordered[0]} only`;
  return ordered.slice(0, -1).join(", ") + " and " + ordered[ordered.length - 1];
}

/**
 * The checks, as cards with weight.
 *
 * Each carries a ring showing how much of the organization it concerns, a bar
 * repeating that at full width, and the first few affected repositories by
 * name: a count gives the size of a problem, a name gives its location.
 *
 * Severity drives saturation, elevation and the header wash together, so a card
 * needing attention is heavier on the page without being a different shape.
 * See /.impeccable.md for the visual direction.
 */

export type Level = "danger" | "warn" | "info" | "clear";

export interface Verdict {
  level: Level;
  value: number;
  denominator: number | null;
  /** 0..1, how much of what was checked this concerns. */
  share: number | null;
  caption: string;
  eyebrow: string;
}

export function verdictFor(items: any[], total: number | null, config: WidgetConfig): Verdict {
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
export const TONE: Record<Level, {
  wash: string; ring: string; track: string; bar: string; figure: string; chip: string; edge: string; lift: string;
}> = {
  danger: {
    wash: "bg-crimson-wash",
    ring: "stroke-crimson",
    track: "stroke-rule",
    bar: "bg-crimson",
    figure: "text-crimson",
    chip: "bg-crimson text-reverse",
    edge: "border-crimson-edge",
    lift: "",
  },
  warn: {
    wash: "bg-ochre-wash",
    ring: "stroke-ochre",
    track: "stroke-rule",
    bar: "bg-ochre",
    figure: "text-ochre",
    chip: "bg-ochre text-reverse",
    edge: "border-ochre-edge",
    lift: "",
  },
  info: {
    wash: "bg-indigo-wash",
    ring: "stroke-indigo",
    track: "stroke-rule",
    bar: "bg-indigo",
    figure: "text-indigo",
    chip: "bg-indigo text-reverse",
    edge: "border-indigo-edge",
    lift: "",
  },
  clear: {
    wash: "bg-forest-wash",
    ring: "stroke-forest",
    track: "stroke-rule",
    bar: "bg-forest",
    figure: "text-forest",
    chip: "bg-forest text-reverse",
    edge: "border-forest-edge",
    lift: "",
  },
};

const RANK: Record<Level, number> = { danger: 0, warn: 1, info: 2, clear: 3 };

/**
 * How long a manual refresh keeps the dashboard reading live.
 *
 * Long enough for the cards to finish and be looked at, short enough that
 * leaving the tab open does not quietly return it to running every check on
 * every render, which is the behaviour the snapshots exist to remove.
 */
const LIVE_WINDOW_MS = 90_000;

export default function AnalyticsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [liveUntil, setLiveUntil] = useState(0);
  const [refreshingLive, setRefreshingLive] = useState(false);
  const live = Date.now() < liveUntil;
  const { data: widgets = [], isLoading: widgetsLoading, isFetching: widgetsFetching, refetch: refetchWidgets } = useWidgets();
  const { data: snapshots } = useWidgetSnapshots();

  /** The oldest snapshot on screen, what the page can honestly claim. */
  const oldestComputedAt = useMemo(() => {
    const times = (snapshots ?? [])
      .filter(sn => widgets.some(w => w.id === sn.widgetId))
      .map(sn => sn.computedAt)
      .filter(Boolean);
    return times.length ? times.reduce((a, b) => (a < b ? a : b)) : null;
  }, [snapshots, widgets]);
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
  // Only so the confirmation can say how many connections are being re-read.
  const { data: graphInfo } = useGraphAggregation();
  const graphEmpty = graphMeta?.edgeCount === 0;

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [alarmWidgetId, setAlarmWidgetId] = useState<string | null>(null);
  // Admin-gated on the server; this only avoids offering a control that would
  // be refused, and avoids a 403 for everyone else.
  const isAwsAdmin = permissions?.isAwsAdmin ?? false;
  const { data: alarms } = useAlarms(isAwsAdmin);
  const focused = useMemo(() => widgets.find(w => w.id === focusId) ?? null, [widgets, focusId]);

  /**
   * Each card reports its verdict once its data arrives.
   *
   * The parent cannot work this out itself: the queries behind a check depend
   * on its configuration, so evaluating N checks means N hook calls and the
   * list length changes between renders. Reporting upward keeps the hooks where
   * they belong and still lets the page order the grid and state the posture.
   */
  const [search, setSearch] = useState("");
  /**
   * Cards or rows.
   *
   * Remembered per browser, because it is a preference about how somebody
   * reads rather than anything about the organization, and being put back into
   * the other one on every launch is the kind of small friction people stop
   * reporting and start working around.
   */
  const [view, setView] = useState<"cards" | "rows">(() => {
    try { return localStorage.getItem("overview:view") === "rows" ? "rows" : "cards"; }
    catch { return "cards"; }
  });
  const setViewPersistent = (v: "cards" | "rows") => {
    setView(v);
    try { localStorage.setItem("overview:view", v); } catch { /* the view still changes */ }
  };
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

  /**
   * The checks a search actually matches.
   *
   * Searches the title *and* the underlying check, so "protection" finds a card
   * somebody named "Prod repos" whose check is about branch protection. A
   * dashboard is usually named by the person who built it, and the words they
   * chose are not the words somebody else looks for.
   */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(w => {
      const label = w.type === "query"
        ? QUERY_OPTIONS.find(o => o.id === w.queryId)?.label ?? ""
        : PRESET_LABELS[w.presetId as string] ?? "";
      return `${w.title} ${label} ${w.queryParam ?? ""}`.toLowerCase().includes(q);
    });
  }, [ordered, search]);


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
          live={live}
          onBack={() => setFocusId(null)}
          onEdit={() => setEditingWidget(focused)}
          onAlarm={() => setAlarmWidgetId(focused.id)}
          canAlarm={isAwsAdmin}
          alarmCount={alarms?.filter(a => a.widgetId === focused.id).length ?? 0}
          canEdit={canEditDashboard}
          graphEmpty={graphEmpty}
          orgName={orgName}
        />
      ) : (
        <>
      {/* The front page. The verdict is the headline, set in the display serif
          at a size nothing else on the screen competes with, and the dateline
          under it carries the things that qualify it: whose organization, how
          many checks, and how old the answers are. */}
      <header className="mb-8" style={enter(0)}>
        <div className="flex items-end justify-between gap-8 flex-wrap pb-4">
          <div className="min-w-0">
            <p className="caps mb-3">
              {orgName || "Organization"} · {posture.total} {posture.total === 1 ? "check" : "checks"}
            </p>
            <h1 className="display text-[clamp(2.25rem,4.6vw,3.4rem)] leading-[1.05] max-w-[20ch] text-ink">
              {widgetsLoading ? (
                <span className="text-ink-4">Reading the organization…</span>
              ) : posture.total === 0 ? (
                <>Nothing is being watched yet.</>
              ) : posture.answered === 0 ? (
                <span className="text-ink-4">Working it out…</span>
              ) : posture.attention === 0 ? (
                <>Everything checked is <span className={TONE.clear.figure}>clear</span>.</>
              ) : (
                <>
                  <span className={TONE[posture.worst].figure}>{posture.attention}</span>
                  {" "}of {posture.answered} checks need attention.
                </>
              )}
            </h1>
            {/* Said rather than implied. These numbers come from the last
                scheduled pass, and a figure presented as current when it is
                twenty minutes old is the thing this is meant to avoid. */}
            {oldestComputedAt && !live && (
              <p className="standfirst text-[13px] mt-3">
                Checked {ago(oldestComputedAt)} · refresh to run them now
              </p>
            )}
            {live && <p className="standfirst text-[13px] mt-3">Running every check now…</p>}
          </div>

          <div className="flex items-center gap-5 shrink-0 flex-wrap">
            {/* Recompute now, rather than waiting for the next scheduled pass.
                Every card drops its stored answer and runs its own check —
                which is what the page used to do on every open. Deliberately a
                choice now, not the default. */}
            <RefreshButton
              busy={widgetsFetching || refreshingLive}
              onRefresh={async () => {
                setLiveUntil(Date.now() + LIVE_WINDOW_MS);
                setRefreshingLive(true);
                try {
                  await Promise.all([
                    refetchWidgets(),
                    qc.invalidateQueries({ queryKey: ["graph", "security-query"] }),
                    qc.invalidateQueries({ queryKey: ["dependencies"] }),
                    qc.invalidateQueries({ queryKey: ["renovate"] }),
                    qc.invalidateQueries({ queryKey: ["widget-snapshots"] }),
                  ]);
                } finally {
                  setRefreshingLive(false);
                }
              }}
            />
            {/* Gated to match the endpoint. Syncing walks the whole organization
                and spends its GitHub budget, so it is admin-only on the server —
                and a button everyone can see, that only some can use, teaches
                the rest that the app is broken.

                Deliberately not the same shape as Refresh beside it. That one
                re-reads a stored answer in a second; this one re-reads the
                whole organization over several minutes. They looked identical,
                which is how the expensive one got pressed by mistake. */}
            {canEditDashboard && <RecrawlButton dense className="whitespace-nowrap" />}
            {canEditDashboard && (
              <Button variant="primary" onClick={() => setShowAddModal(true)}>Add check</Button>
            )}
          </div>
        </div>
        <div className="border-t-2 border-ink" />
      </header>

      {/* Search and view, above the checks rather than in the header, because
          they act on what is below them and a control that acts on a list
          belongs next to the list. Hidden entirely when there is nothing to
          search or switch: a filter over two cards is furniture. */}
      {widgets.length > 2 && (
        <div style={enter(1)} className="mb-6 flex items-end gap-6 flex-wrap border-b border-rule pb-3">
          <label className="relative flex-1 min-w-[15rem] max-w-md flex items-baseline gap-2.5">
            <span className="caps shrink-0">Find</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="a check by name, or by what it asks"
              aria-label="Search checks"
              className="w-full bg-transparent border-0 px-0 py-1 text-[14px] text-ink placeholder:text-ink-4 focus:outline-none"
            />
            {search && (
              <button onClick={() => setSearch("")} aria-label="Clear search" className="textlink caps shrink-0">
                Clear
              </button>
            )}
          </label>

          {/* Said out loud, because a filtered list that looks like the whole
              list is how somebody concludes a check has been deleted. */}
          {search && (
            <span className="caps text-ink">{visible.length} of {widgets.length}</span>
          )}

          <div className="ml-auto flex items-baseline gap-4 shrink-0">
            <span className="caps">Set as</span>
            {([["cards", "Cards"], ["rows", "Column"]] as const).map(([v, label]) => (
              <button key={v} onClick={() => setViewPersistent(v)} aria-pressed={view === v}
                className={`caps transition-colors ${
                  view === v ? "text-ink underline underline-offset-4 decoration-ink" : "hover:text-ink"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {graphEmpty && (
        <div style={enter(1)} className="mb-5">
          <Note intent="warn">
            The graph has no data, so anything reading from it comes back empty. It builds
            itself once a day, or an admin can recrawl now.
          </Note>
        </div>
      )}
      {aggregation.isError && (
        <div style={enter(1)} className="mb-5">
          <Note intent="danger">Sync failed: {(aggregation.error as Error)?.message || "unknown error"}.</Note>
        </div>
      )}

      {widgetsLoading ? (
        <Spinner />
      ) : widgets.length === 0 ? (
        <Empty
          title="No checks yet"
          body="A check is a question about the organization. Which repositories have an unprotected default branch, who holds admin nobody granted, which packages are exposing you. Add one and it gets a card here."
          action={canEditDashboard
            ? <Button variant="primary" onClick={() => setShowAddModal(true)}>Add the first check</Button>
            : undefined}
        />
      ) : (
        visible.length === 0 ? (
          <Empty
            title="No checks match that"
            body={`Nothing here answers to "${search}". Try the name of a repository, a package, or what the check asks about.`}
            action={<Button onClick={() => setSearch("")}>Clear the search</Button>}
          />
        ) : view === "cards" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {/* No `items-start`: grid rows stretch by default, so every card in a
              row matches the tallest. Each card root carries `h-full` to fill
              the cell it is given, which is what makes them line up. */}
          {visible.map((w, i) => (
            <CheckCard
              key={w.id}
              config={w}
              live={live}
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
        ) : (
        /* One row per check, ordered exactly as the cards are, so switching
           view never reorders anything. Denser on purpose: this is the view for
           twenty checks, where a grid of cards is three screens of scrolling. */
        <div className="border-t-2 border-ink">
          <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_120px_minmax(0,190px)_44px] gap-4 px-3 py-2 border-b border-rule">
            <span className="caps">Check</span>
            <span className="caps text-right">Found</span>
            <span className="caps">Share</span>
            <span></span>
          </div>
          {visible.map((w, i) => (
            <CheckRow
              key={w.id}
              config={w}
              live={live}
              index={i}
              onOpen={() => setFocusId(w.id)}
              onReport={report}
              graphEmpty={graphEmpty}
            />
          ))}
        </div>
        )
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

      {alarmWidgetId && (
        <AlarmModal
          isOpen
          widgetId={alarmWidgetId}
          existing={alarms?.find(a => a.widgetId === alarmWidgetId) ?? null}
          onClose={() => setAlarmWidgetId(null)}
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
  const R = 27, C = 2 * Math.PI * R;
  return (
    <div className="relative w-[68px] h-[68px] shrink-0">
      {/* An engraved arc: a hairline track and a 2px sweep, no round cap and no
          filled puck. The dash offset carries the value, so the animation stays
          on the compositor. */}
      <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
        <circle cx="32" cy="32" r={R} fill="none" strokeWidth="1" className={tone.track} />
        <circle
          cx="32" cy="32" r={R} fill="none" strokeWidth="2.5"
          className={tone.ring}
          style={{
            strokeDasharray: C,
            strokeDashoffset: C * (1 - Math.max(0, Math.min(1, share))),
            transition: "stroke-dashoffset 900ms cubic-bezier(0.22,1,0.36,1)",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`figure text-[1.0625rem] ${tone.figure}`}>{children}</span>
      </div>
    </div>
  );
}

/**
 * One check, on its own. The board steps aside rather than carrying a
 * seven-column table inside a card, so the table gets the whole width and
 * nothing reflows underneath it. Same pattern as the AWS page.
 */
/**
 * Exported so the personal board shows the same detail view, rather than a
 * modal pointing at the Overview tab. The table, the verdict and the freshness
 * stamp all live here.
 */
export function CheckDetail({ config, onBack, onEdit, canEdit, graphEmpty, orgName,
                      onAlarm, canAlarm, alarmCount, live }: {
  config: WidgetConfig; onBack: () => void; onEdit: () => void;
  onAlarm: () => void; canAlarm: boolean; alarmCount: number;
  canEdit: boolean; graphEmpty?: boolean; orgName?: string;
  /** Ignore the stored answer and compute now. Set by the refresh button. */
  live?: boolean;
}) {
  // `live` as well as `needAllRows`: pressing Refresh has to reach here too.
  // Without it the Overview went live and the detail table kept reading the
  // stored snapshot, so a check that had started reporting a new field showed
  // the old shape until the next scheduled pass wrote one.
  const { items, isLoading, total, entity, filtered, unfiltered } =
    useWidgetData(config, { needAllRows: true, live });
  const verdict = useMemo(() => verdictFor(items, total, config), [items, total, config]);
  const tone = TONE[verdict.level];
  const pct = verdict.share === null ? null : Math.round(verdict.share * 100);
  const n = useCountUp(verdict.value);

  return (
    <div style={enter(0)}>
      <Back onClick={onBack}>All checks</Back>

      {filtered && (
        <div className="mb-4">
          <Note intent="info">
            This card is narrowed by its own filters, so it is showing{" "}
            {items.length.toLocaleString()} of the{" "}
            {unfiltered.toLocaleString()} rows the check found. The check itself
            still looks at the whole organization.
          </Note>
        </div>
      )}

      <div className="mb-7">
        <span className={`block h-[3px] w-full ${tone.bar}`} aria-hidden="true" />
        <div className="pt-5 flex items-start gap-7 flex-wrap">
          {pct === null
            ? <Emblem kind={entity} tone={tone} />
            : <Ring share={verdict.share ?? 0} tone={tone}>{`${pct}%`}</Ring>}

          <div className="flex-1 min-w-[14rem]">
            <p className={`caps ${tone.figure} mb-2`}>
              {config.type === "preset" && config.presetId === "vuln-repos"
                ? describeSeverities(parseSeverities(config.queryParam))
                : verdict.eyebrow}
            </p>
            <h2 className="display text-[clamp(1.75rem,3vw,2.25rem)] leading-tight text-ink">{config.title}</h2>
            <p className="flex items-baseline gap-3 mt-4">
              <span className={`figure text-[2.75rem] ${tone.figure}`}>{n}</span>
              <span className="caps">
                {verdict.share === null && verdict.value > 0 ? nounFor(entity, verdict.value) : verdict.caption}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            {canAlarm && (
              <Button onClick={onAlarm}>
                {alarmCount > 0 ? `Alarms (${alarmCount})` : "Add alarm"}
              </Button>
            )}
            {canEdit && <Button onClick={onEdit}>Edit check</Button>}
          </div>
        </div>
        <div className="border-t-2 border-ink mt-6" />
      </div>

      <div className="overflow-x-auto">
        {isLoading
          ? <Spinner label="Reading the check" />
          : <WidgetDataTable config={config} items={items} graphEmpty={graphEmpty} orgName={orgName} />}
      </div>
    </div>
  );
}

export type Entity = "repository" | "user" | "team";

/**
 * What a check counts.
 *
 * Declared on the query rather than inferred: an empty result has no rows to
 * read, and the id is not a description, inferring from a "repos-" prefix is
 * what gave "unowned-repos" no denominator while its neighbour had one.
 */
export function entityForConfig(config: WidgetConfig): Entity {
  if (config.type === "preset") return "repository";
  const option = QUERY_OPTIONS.find(q => q.id === config.queryId) as { entity?: Entity } | undefined;
  return option?.entity ?? "repository";
}

const PLURAL: Record<Entity, [string, string]> = {
  repository: ["repository", "repositories"],
  user: ["user", "users"],
  team: ["team", "teams"],
};

export const nounFor = (kind: Entity, n: number) => PLURAL[kind][n === 1 ? 0 : 1];

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
    <div className={`w-[68px] h-[68px] shrink-0 flex items-center justify-center border ${tone.edge} ${tone.wash}`}>
      <i className={`${EMBLEM[kind]} text-[24px] ${tone.figure}`}></i>
    </div>
  );
}

/** The first few affected things, by name. A count sizes a problem; a name locates it. */
function nameOf(item: any): string {
  return item?.repo || item?.user || item?.team || "-";
}

function detailOf(item: any, config: WidgetConfig): string {
  if (config.type === "preset" && config.presetId === "dependabot") return `${item.total ?? 0} alerts`;
  if (config.type === "preset" && config.presetId === "vuln-repos") return item.worst ?? "";
  // Both forms of the bypass check, which return the same rows. Read off the
  // row rather than off the config so the query form gets "3 bypasses" instead
  // of falling through to a truncated sentence saying the same thing.
  if (typeof item?.bypasses === "number") return `${item.bypasses} bypasses`;
  if (config.type === "preset" && config.presetId === "renovate-open") return `#${item.number} · open ${item.ageDays}d`;
  if (item?.status) return item.status;
  const r = String(item?.reason ?? "");
  return r.length > 28 ? r.slice(0, 27) + "…" : r;
}

/**
 * One check as a row, for the list view.
 *
 * Deliberately a sibling of CheckCard rather than a mode inside it: the two
 * render almost nothing in common, and a component that is a card or a row
 * depending on a prop ends up being neither well.
 *
 * What it does share is the data path. It calls the same `useWidgetData` and
 * the same `verdictFor`, and reports its verdict the same way, because the
 * dashboard's ordering and its headline count are both derived from what the
 * rendered checks report. A row view that skipped that would leave the page
 * saying "0 of 0 checks" while showing twenty rows.
 */
function CheckRow({
  config, index, onOpen, onReport, live, graphEmpty,
}: {
  config: WidgetConfig; index: number; onOpen: () => void;
  live?: boolean;
  onReport: (id: string, v: Verdict) => void;
  graphEmpty?: boolean;
}) {
  const { items, isLoading, total, error } = useWidgetData(config, { live });
  const verdict = useMemo(() => verdictFor(items, total, config), [items, total, config]);
  const tone = TONE[verdict.level];

  useEffect(() => {
    if (!isLoading) onReport(config.id, verdict);
  }, [isLoading, verdict, config.id, onReport]);

  const label = config.type === "query"
    ? QUERY_OPTIONS.find(o => o.id === config.queryId)?.label ?? "Check"
    : PRESET_LABELS[config.presetId as string] ?? "Check";
  const pct = verdict.share === null ? null : Math.round(verdict.share * 100);
  const broken = !!error;

  return (
    <button
      onClick={onOpen}
      style={enter(Math.min(index, 8))}
      className="w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,190px)_44px] gap-4 items-baseline px-3 py-3.5 border-b border-rule last:border-b-0 hover:bg-ink/[0.035] transition-colors"
    >
      <span className="min-w-0 flex items-baseline gap-3">
        {/* The same ink the card uses, as a marginal rule rather than an arc. It
            is the only thing here that is scannable down a column of twenty. */}
        <span className={`w-[3px] h-7 shrink-0 translate-y-1 ${
          broken ? "bg-rule-strong" : tone.bar}`} />
        <span className="min-w-0">
          <span className="display block text-[1.0625rem] text-ink truncate leading-snug">
            {config.title}
          </span>
          <span className="block caps truncate mt-1">
            {label}{config.queryParam ? ` · ${config.queryParam}` : ""}
          </span>
        </span>
      </span>

      <span className="text-right">
        {isLoading ? (
          <span className="inline-block w-10 h-3 bg-paper-3 animate-pulse" />
        ) : broken ? (
          <span className="caps">unreadable</span>
        ) : (
          <>
            <span className={`figure text-[1.5rem] ${tone.figure}`}>{verdict.value}</span>
            {verdict.denominator !== null && (
              <span className="figure text-[0.9rem] text-ink-4">/{verdict.denominator}</span>
            )}
          </>
        )}
      </span>

      {/* Both hidden on narrow screens rather than wrapped: a share rule folded
          onto its own line reads as a second finding. */}
      <span className="hidden sm:block min-w-0">
        {!isLoading && !broken && (
          pct === null ? (
            <span className="caps truncate block">{verdict.caption}</span>
          ) : (
            <span className="flex items-center gap-3">
              <span className="h-[3px] flex-1 bg-rule overflow-hidden">
                <span className={`block h-full ${tone.bar}`} style={{ width: `${Math.max(pct, 2)}%` }} />
              </span>
              <span className="figure text-[0.8125rem] text-ink-2 w-9 text-right">{pct}%</span>
            </span>
          )
        )}
      </span>

      <span className="hidden sm:flex justify-end caps text-ink-4">Open</span>
    </button>
  );
}

/**
 * Exported so the personal dashboard can render the same card.
 *
 * The alternative was a second card that looked nearly the same and drifted,
 * and the verdict logic, the freshness stamp and the failure states inside this
 * are exactly the parts that must not be reimplemented twice.
 */
export function CheckCard({
  config, index, onOpen, onReport, canEdit, onEdit, onRemove, graphEmpty, live,
}: {
  config: WidgetConfig; index: number; onOpen: () => void;
  /** Ignore the stored answer and compute now. Set by the refresh button. */
  live?: boolean;
  onReport: (id: string, v: Verdict) => void;
  canEdit: boolean; onEdit: () => void; onRemove: () => void;
  graphEmpty?: boolean;
}) {
  const { items, isLoading, total, entity, error, computedAt } = useWidgetData(config, { live });
  const refreshNow = useRefreshQueryNow();

  // Only for the checks that keep per-subject answers. Everything else is
  // derived from the graph on the spot, so "when was this last checked" has no
  // meaning and asking would be a request that answers nothing.
  const batchedId = batchedQueryOf(config);
  const batchedQuery = batchedId !== null;
  const { data: freshness } = useQueryFreshness(batchedId);

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

  // Working, not broken.
  //
  // The three subject-by-subject checks read a batch per pass and answer
  // nothing until every subject is covered, which takes a few passes on a large
  // organization. Rendering that as the amber "Not running" warning below, with
  // a Remove button, tells somebody their check is broken at the one moment it
  // is doing exactly what it should, and invites them to delete it.
  if (error instanceof IncompleteQueryError) {
    const pctDone = error.total > 0 ? Math.round((error.covered / error.total) * 100) : 0;
    return (
      <article style={enter(index)}
        className="group rounded-2xl border border-slate-200/80 dark:border-ink/[0.09] bg-white dark:bg-paper overflow-hidden h-full">
        <div className="px-5 pt-5 pb-4 flex items-start gap-4">
          <div className="w-[68px] h-[68px] shrink-0 rounded-2xl flex items-center justify-center bg-ink/10 border border-gh-blue/20">
            <i className="ph ph-circle-notch text-[26px] text-gh-blue animate-spin"></i>
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <p className={`${TYPE.label} text-gh-blue mb-1.5`}>Building coverage</p>
            <h3 className="display text-[1.1875rem] text-ink line-clamp-2">
              {config.title}
            </h3>
            <p className="text-[13px] tabular-nums text-slate-500 dark:text-slate-400 mt-1">
              {error.covered} of {error.total} checked
            </p>
          </div>
        </div>
        {/* A bar, because "75 of 250" and "230 of 250" are the same sentence at
            a glance and completely different amounts of waiting. */}
        <div className="px-5">
          <div className="h-1.5 rounded-full bg-slate-100 dark:bg-ink/[0.07] overflow-hidden">
            <div className="h-full  bg-ink transition-[width] duration-700"
              style={{ width: `${Math.max(2, pctDone)}%` }} />
          </div>
        </div>
        <div className="px-5 py-4">
          <p className="text-[13px] text-slate-500 dark:text-slate-400 leading-relaxed">
            This check reads one account or repository at a time against a GitHub limit measured
            per minute, so it covers them in batches. It updates on its own.
          </p>
          {canEdit && (
            <button
              onClick={e => { e.stopPropagation(); refreshNow.mutate(batchedId!); }}
              disabled={refreshNow.isPending}
              className="textlink caps mt-3">
              {refreshNow.isPending ? "Checking…" : "Check the rest now"}
            </button>
          )}
          {refreshNow.data && (
            <p className="mt-2 text-[12px] text-slate-500 dark:text-slate-400">{refreshNow.data.message}</p>
          )}
        </div>
      </article>
    );
  }

  if (error) {
    return (
      <article style={enter(index)} className="border border-rule bg-paper h-full">
        <span className="block h-[3px] w-full bg-ochre" aria-hidden="true" />
        <div className="px-5 pt-5 pb-4 flex items-start gap-4">
          <div className="w-[68px] h-[68px] shrink-0 flex items-center justify-center border border-ochre-edge bg-ochre-wash">
            <i className="ph-fill ph-warning text-[24px] text-ochre"></i>
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <p className="caps text-ochre mb-1.5">
              {/* "Needs data" and "no longer exists" are different problems
                  with different fixes, and the card is where that is decided. */}
              {/recrawl/i.test(error.message) ? "Needs a recrawl" : "Not running"}
            </p>
            <h3 className="display text-[1.125rem] text-ink leading-snug line-clamp-2">{config.title}</h3>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-rule">
          <p className="standfirst text-[13px]">{error.message}</p>
          {canEdit && !/recrawl/i.test(error.message) && (
            <div className="flex gap-5 mt-3">
              <button onClick={e => { e.stopPropagation(); onEdit(); }} className="textlink caps">Edit check</button>
              <button onClick={e => { e.stopPropagation(); onRemove(); }} className="textlink caps hover:!text-crimson">Remove</button>
            </div>
          )}
        </div>
      </article>
    );
  }

  if (isLoading) {
    return (
      <div className="border border-rule bg-paper p-5 h-full min-h-[268px]" style={enter(index)}>
        <div className="flex items-center gap-4">
          <div className="w-[68px] h-[68px] border border-rule animate-pulse" />
          <div className="flex-1 space-y-2.5">
            <div className="h-2.5 w-20 bg-paper-3 animate-pulse" />
            <div className="h-4 w-32 bg-paper-3 animate-pulse" />
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
      className={`group cursor-pointer border ${tone.edge} bg-paper h-full flex flex-col
        transition-colors duration-150 hover:bg-ink/[0.035] focus-visible:outline-none`}
    >
      {/* The state's ink as a rule across the head, rather than a wash over the
          whole card: the names below stay on the page's own stock and remain
          readable, and the state is still the first thing seen. */}
      <span className={`block h-[3px] w-full ${tone.bar}`} aria-hidden="true" />

      <div className="px-5 pt-5 pb-4">
        <div className="flex items-start gap-4">
          {pct === null ? (
            // Nothing to take a share of — a check about people or teams has no
            // repository count behind it, so an arc reading " " was a chart of
            // nothing. A marked square says what kind of thing was counted
            // instead, and keeps the head the same height either way.
            <Emblem kind={entity} tone={tone} />
          ) : (
            <Ring share={verdict.share ?? 0} tone={tone}>{`${pct}%`}</Ring>
          )}

          <div className="flex-1 min-w-0 pt-0.5">
            <p className={`caps ${tone.figure} mb-1.5 truncate`}>
              {/* Two of these can sit side by side counting different
                  severities, and the title alone will not say which. */}
              {config.type === "preset" && config.presetId === "vuln-repos"
                ? describeSeverities(parseSeverities(config.queryParam))
                : verdict.eyebrow}
            </p>
            <h3 className="display text-[1.1875rem] text-ink leading-snug line-clamp-2">
              {config.title}
            </h3>
          </div>

          {canEdit && (
            <div className="flex items-baseline gap-4 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button onClick={e => { e.stopPropagation(); onEdit(); }} className="textlink caps">Edit</button>
              <button onClick={e => { e.stopPropagation(); onRemove(); }} className="textlink caps hover:!text-crimson">Remove</button>
            </div>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-rule">
          <p className="flex items-baseline gap-2.5">
            <span className={`figure text-[2.75rem] ${tone.figure}`}>{n}</span>
            <span className="caps">
              {verdict.share === null && verdict.value > 0
                ? nounFor(entity, verdict.value)
                : verdict.caption}
            </span>
          </p>
          {verdict.share !== null && (
            <div className="mt-3 h-[3px] bg-rule overflow-hidden">
              <div
                className={`h-full origin-left ${tone.bar}`}
                style={{
                  transform: `scaleX(${drawn ? Math.max(verdict.share, verdict.value > 0 ? 0.012 : 0) : 0})`,
                  transition: "transform 700ms cubic-bezier(0.22,1,0.36,1)",
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Names. A count sizes a problem; a name locates it, so what is affected
          is on the card rather than one click away.

          `flex-1`: a card showing one name and a card showing three end up the
          same height, and the difference reads as space under the list rather
          than as a ragged grid. */}
      <div className="px-5 py-4 border-t border-rule flex-1">
        {preview.length === 0 ? (
          <p className="standfirst text-[13px] py-1">
            {graphEmpty ? "No graph data. Sync to populate." : "Nothing to show."}
          </p>
        ) : (
          <ul>
            {preview.map((item: any, k: number) => (
              <li key={k} className="flex items-baseline justify-between gap-3 py-1.5 border-b border-rule last:border-0">
                <span className="font-mono text-[12.5px] text-ink truncate">{nameOf(item)}</span>
                <span className="text-[12px] text-ink-3 shrink-0 truncate max-w-[45%]"
                  title={item.checkedAt ? `Checked ${since(item.checkedAt)}` : undefined}>
                  {detailOf(item, config)}
                  {/* Per row, because subjects are checked at different times —
                      one may be twenty hours old while its neighbour is fresh,
                      and a single date on the card would hide that. */}
                  {item.checkedAt && <span className="ml-1.5 text-ink-4">· {since(item.checkedAt)}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        <button onClick={onOpen} className={`textlink caps mt-4 ${tone.figure}`}>
          {hidden > 0 ? `${hidden} more →` : "Open →"}
        </button>

        {/* When this was established, for the checks whose answers are stored
            rather than derived on the spot. A finding with no date on it is a
            claim the reader cannot weigh: "this repository bypasses its rules"
            means something different four minutes old than twenty hours old.
            The oldest is shown, not the newest, because the oldest is the one
            that decides how much the whole card can be trusted. */}
        {batchedQuery && freshness?.batched && freshness.oldestAt && (
          <div className="mt-4 pt-3 border-t border-rule flex items-baseline justify-between gap-3">
            <span className="caps">
              Oldest check {since(freshness.oldestAt)}
              {freshness.checked > 0 && ` · ${freshness.checked} stored`}
            </span>
            {canEdit && (
              <button
                onClick={e => { e.stopPropagation(); refreshNow.mutate(batchedId!); }}
                disabled={refreshNow.isPending}
                className="textlink caps shrink-0">
                {refreshNow.isPending ? "Re-checking…" : "Re-check all"}
              </button>
            )}
          </div>
        )}
        {batchedQuery && refreshNow.data && (
          <p className="standfirst text-[12px] mt-2">{refreshNow.data.message}</p>
        )}
      </div>

    </article>
  );
}

/**
 * A card's rows, from the schedule where possible and live where not.
 *
 * Running every check inside the request that draws the card means a graph
 * scan, live GitHub calls and up to twenty-five commit searches while the page
 * waits. The scheduled pass computes and stores the same rows, and this reads
 * them.
 *
 * The live sources are switched *off* when a snapshot is in use rather than
 * fetched and ignored, which would leave the cost where it was and hide it.
 *
 * Live is still the answer with no snapshot yet, when the stored one records an
 * error, and whenever somebody presses refresh.
 */
export function useWidgetData(
  config: WidgetConfig,
  opts?: {
    /** Ignore the stored answer and compute now. */
    live?: boolean;
    /**
     * The caller needs every row, not just the count and a preview. A snapshot
     * trimmed to fit the item limit is not enough for the detail table, so it
     * falls through to a live read, a card can be served from a short list,
     * a table listing them cannot.
     */
    needAllRows?: boolean;
  },
) {
  const { data: snapshots } = useWidgetSnapshots();

  const snapshot = opts?.live
    ? undefined
    : snapshots?.find(s => s.widgetId === config.id);
  // A stored error is not an answer. Fall through and let the live path
  // produce the real one, and the real message with it.
  // A trimmed snapshot holds some of the rows and the true count of all of
  // them. Filtering it would compare a filter against rows that are missing
  // and report the result as exact, so a filtered widget reads live instead.
  const filtering = activeFilterCount(config.filters) > 0;
  const fromSnapshot = !!snapshot && !snapshot.error
    && !((opts?.needAllRows || filtering) && snapshot.trimmed);

  const { data: depsData, isLoading: depsLoading } = useDependencies(!fromSnapshot);
  const isBypass = !fromSnapshot && config.type === "preset" && config.presetId === "bypasses";
  const isRenovate = !fromSnapshot && config.type === "preset" && config.presetId === "renovate-open";
  const { data: renovateData, isLoading: renovateLoading } = useQuery({
    queryKey: ["renovate"],
    queryFn: () => fetchRenovate(),
    staleTime: 120_000,
    enabled: isRenovate,
  });
  const { data: bypassData, isLoading: bypassLoading } = useSecurityQuery(isBypass ? "protection-bypasses-ranking" : null);

  const isQuery = !fromSnapshot && config.type === "query";
  const { data: queryData, isLoading: queryLoading, error: queryError } = useSecurityQuery(isQuery ? config.queryId! : null, config.queryParam, config.queryAdvanced);

  const { data: repos } = useRepos();

  const { items, isLoading } = useMemo(() => {
    // The stored answer, when there is one. Returned before any of the live
    // branches are consulted, because those sources are switched off in that
    // case and would read as empty rather than as absent.
    if (fromSnapshot && snapshot) {
      return { items: snapshot.rows ?? [], isLoading: false };
    }

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
        // adding this widget costs no additional GitHub requests, the list is
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
            } else if (config.presetId === "renovate-open") {
        // Only the open ones. The card answers "what is waiting to be merged",
        // which a closed PR has by definition stopped being.
        loading = renovateLoading;
        rawItems = (renovateData?.prs ?? []).filter((p: any) => p.state === "open");
      }
    } else {
      loading = queryLoading;
      rawItems = queryData || [];
    }

    return { items: rawItems, isLoading: loading };
  }, [config, fromSnapshot, snapshot, depsData, depsLoading, bypassData, bypassLoading, queryData, queryLoading, renovateData, renovateLoading]);

  // Only a check that counts repositories has the organization as its
  // denominator. Users and teams do not, and a share of the wrong thing is
  // worse than no share.
  const entity = entityForConfig(config);
  // The snapshot's own denominator first, and the live repository list only as
  // a fallback.
  //
  // The rows arrived instantly from the snapshot while `repos` was a separate
  // request that landed a few seconds later. Until it did, `total` was null, so
  // the card had no share, drew itself amber, printed "found" instead of "of N
  // repositories", and then repainted. Everything needed to draw it correctly
  // was already known when the snapshot was written.
  const total = entity !== "repository" ? null
    : typeof snapshot?.repoTotal === "number" ? snapshot.repoTotal
    : repos ? repos.length : null;

  // A widget whose check has been removed returns nothing, which on a card
  // looks exactly like a check that found nothing. Carrying the failure up
  // means it can say so instead of reading as clean.
  // Applied here rather than in the table, so the number on the card and the
  // rows behind it are the same answer to the same question. A card reading 112
  // that opens onto four rows is the bug this placement exists to prevent.
  const shown = useMemo(
    () => applyWidgetFilters(items, config.filters),
    [items, config.filters],
  );

  return {
    items: shown, isLoading, total, entity,
    /**
     * The rows before this widget's own filters.
     *
     * The filter editor builds its choices from these: offering only the values
     * that survive the current filter would make a narrowed board impossible to
     * widen again, because the option you wanted would have been filtered out
     * of the list of options.
     */
    allItems: items,
    error: (queryError as Error) ?? null,
    /** When this was computed, or null when it was worked out just now. */
    computedAt: fromSnapshot ? snapshot!.computedAt : null,
    /** The true row count. A trimmed snapshot still knows how many there were. */
    count: filtering ? shown.length : fromSnapshot ? snapshot!.total : items.length,
    /** Rows the check found before this widget's own filters narrowed them. */
    unfiltered: fromSnapshot ? snapshot!.total : items.length,
    /** Whether any filter is narrowing what is shown. */
    filtered: filtering,
    /** A stored snapshot that could not hold every row; the detail reads live. */
    trimmed: fromSnapshot ? snapshot!.trimmed : false,
  };
}

/* ─── Widget Card (Grid View) ─── */

function WidgetDataTable({ config, items, graphEmpty, orgName }: { config: WidgetConfig; items: any[]; graphEmpty?: boolean; orgName?: string }) {
  const [selectedItem, setSelectedItem] = useState<any | null>(null);

  // A widget answering a question about the whole organization returns a row
  // per repository, so this is the table most likely to be hundreds long.
  //
  // Rows are shaped by whichever query produced them, so search covers the
  // subject (repo/user/team) plus every scalar field the row happens to carry
  // rather than a fixed list. Objects are skipped, stringifying them matches
  // punctuation nobody typed.
  // Above the early return, because these are hooks and that return is
  // conditional. `hasStatus` is recomputed here rather than reused, because the
  // original is declared below it for the same reason.
  const columns = widgetColumns({
    type: config.type,
    presetId: config.presetId,
    hasStatus: items.some((i: any) => i.status),
    // Any row carrying the field, including one where it is null, null is the
    // answer "no team owns this", which is exactly what the column is for.
    hasOwner: items.some((i: any) => "owner" in i),
    hasVisibility: items.some((i: any) => "visibility" in i),
    hasBypasses: items.some((i: any) => typeof i.bypasses === "number"),
  });
  const widthDefaults = defaultWidths(columns);
  const cols = useColumnWidths(layoutId(config.id, columns), widthDefaults);

  const table = useTableControls(items, {
    searchText: (it: any) => Object.entries(it)
      .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
      .map(([, v]) => String(v ?? ""))
      .join(" "),
    columns: [
      { key: "name", label: "Name", value: (it: any) => it.repo || it.user || it.team || "" },
      { key: "status", label: "Status", value: (it: any) => it.status ?? "" },
    ],
    perPage: 50,
  });

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
      {(items.length > 8 || cols.customised) && (
        <div className="px-6 py-4 flex items-center gap-3">
          {items.length > 8 && (
            <div className="flex-1 min-w-0">
              <SearchInput value={table.search} onChange={table.setSearch} placeholder="Search rows…" />
            </div>
          )}
          {/* Only once something has been dragged. A control that undoes
              nothing is noise on every table that was never touched. */}
          {cols.customised && (
            <button
              onClick={cols.resetAll}
              className="textlink caps shrink-0 transition-colors"
            >
              <i className="ph-bold ph-arrows-in-line-horizontal mr-1.5"></i>Reset columns
            </button>
          )}
        </div>
      )}
      {table.visible.length === 0 ? (
        <div className="p-12 text-center text-slate-500 dark:text-slate-400">
          <i className="ph-fill ph-magnifying-glass text-4xl text-slate-300 dark:text-slate-600 mb-3 block"></i>
          Nothing in {table.totalCount} rows matches "{table.search.trim()}".
        </div>
      ) : (
      <table
        className="text-left border-collapse"
        // Fixed layout is what makes the colgroup widths authoritative. With
        // `auto` the browser re-measures from content on every render and the
        // width you dragged to is a suggestion it feels free to ignore.
        style={{
          tableLayout: "fixed",
          width: "100%",
          // Below this the columns would be squeezed back under their own
          // widths; the container scrolls instead. The last column is not
          // counted, since it is the one absorbing the slack.
          minWidth: columns.slice(0, -1).reduce((sum, c) => sum + (cols.widths[c.id] ?? c.width), 0) + 200,
        }}
      >
        <colgroup>
          {columns.map((c, i) => (
            // The last column has no width: it takes whatever is left, so the
            // table has a clean right edge without any column claiming 100%.
            <col key={c.id} style={i === columns.length - 1 ? undefined : { width: cols.widths[c.id] ?? c.width }} />
          ))}
        </colgroup>
        <thead className="caps bg-slate-50 sticky top-0 z-10 border-b border-slate-200">
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.id}
                className={`relative px-6 py-3 ${c.align === "center" ? "text-center" : ""} ${c.headClass ?? ""}`}
              >
                <span className="block truncate">{c.label}</span>
                {/* Not on the last column: it has no width of its own to drag,
                    and everything to its left does. */}
                {i < columns.length - 1 && (
                  <ColumnResizeHandle
                    label={c.label}
                    active={cols.dragging === c.id}
                    onPointerDown={(e) => cols.onResizeStart(c.id, e)}
                    onPointerMove={cols.onResizeMove}
                    onPointerUp={cols.onResizeEnd}
                    onDoubleClick={() => cols.resetColumn(c.id)}
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-rule text-sm">
          {table.visible.map((item: any, idx: number) => {
            const name = item.repo || item.user || item.team || "Unknown";
            return (
              <tr
                key={idx}
                className={`group hover:bg-slate-50 dark:hover:bg-paper-2 transition-colors cursor-pointer ${idx % 2 === 1 ? 'bg-slate-50/50 dark:bg-paper-2/50' : ''}`}
                onClick={() => setSelectedItem(item)}
              >
                <td className="px-6 py-4 font-mono text-slate-400 dark:text-slate-500 text-xs">{String((table.page - 1) * 50 + idx + 1).padStart(3, "0")}</td>
                <td className="px-6 py-4">
                  <div className="font-bold text-slate-800 dark:text-slate-200 truncate" title={name}>{name}</div>
                  {config.type === "query" && (
                    <div className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">{item.repo ? "repository" : item.user ? "user" : item.team ? "team" : "unknown"}</div>
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
                      <span className={`inline-flex px-2.5 py-0.5  text-xs font-bold uppercase tracking-wide ${
                        item.worst === "critical" ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400"
                        : item.worst === "high" ? "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400"
                        : item.worst === "medium" || item.worst === "moderate" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                        : "bg-slate-100 text-slate-600 dark:bg-paper-2 dark:text-slate-400"}`}>
                        {item.worst}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center font-mono font-bold">{item.total}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "renovate-open" && (
                  <>
                    <td className="px-6 py-4 text-sm">
                      <span title={item.title} className="block truncate text-slate-800 dark:text-slate-200">
                        {item.title || "Untitled"}
                      </span>
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400">#{item.number}</span>
                    </td>
                    {/* Age is the reason this widget exists: a Renovate pull
                        request nobody merges is the finding, not its title. */}
                    <td className={`px-6 py-4 text-center font-mono text-sm ${
                      item.ageDays >= 30 ? "text-rose-600 dark:text-red-400 font-bold"
                        : item.ageDays >= 7 ? "text-amber-600 dark:text-amber-400"
                        : "text-slate-500 dark:text-slate-400"}`}>
                      {item.ageDays}d
                    </td>
                    <td className="px-6 py-4 text-center">
                      {/* Stops the row's own click handler: this opens GitHub,
                          the row opens the detail panel, and one gesture must
                          not do both. */}
                      <a
                        href={item.url} target="_blank" rel="noreferrer noopener"
                        onClick={(e) => e.stopPropagation()}
                        title={`Open #${item.number} on GitHub`}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-gh-blue hover:underline"
                      >
                        Open <i className="fa-solid fa-arrow-up-right-from-square text-[9px]"></i>
                      </a>
                    </td>
                  </>
                )}

                {config.type === "preset" && config.presetId === "bypasses" && (
                  <>
                    <td className="px-6 py-4 font-mono font-bold text-rose-600 dark:text-red-400">{item.bypasses}</td>
                    <td className="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 truncate">{item.reason}</td>
                  </>
                )}

                {config.type === "query" && columns.some(c => c.id === "bypasses") && (
                  <td className="px-6 py-4 text-center font-mono font-bold text-rose-600 dark:text-red-400">{item.bypasses}</td>
                )}

                {config.type === "query" && columns.some(c => c.id === "visibility") && (
                  <td className="px-6 py-4 text-center">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5  text-xs font-medium border ${
                      item.visibility === "public"
                        ? "bg-rose-50 dark:bg-red-950/50 text-rose-700 dark:text-red-400 border-rose-200 dark:border-red-800"
                        : "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800"}`}>
                      <i className={item.visibility === "public" ? "fa-solid fa-globe" : "fa-solid fa-building"}></i>
                      {item.visibility ?? "unknown"}
                    </span>
                  </td>
                )}

                {config.type === "query" && hasStatus && (
                  <td className="px-6 py-4 text-center">
                    {item.status === "pass" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5  text-xs font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                        <i className="fas fa-check-circle"></i> Pass
                      </span>
                    ) : item.status === "fail" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5  text-xs font-medium bg-rose-50 dark:bg-red-950/50 text-rose-700 dark:text-red-400 border border-rose-200 dark:border-red-800">
                        <i className="fas fa-times-circle"></i> Fail
                      </span>
                    ) : null}
                  </td>
                )}
                {config.type === "query" && columns.some(c => c.id === "owner") && (
                  <td className="px-6 py-4 text-sm">
                    {item.owner ? (
                      <span title={item.owner} className="block truncate">
                        <span className="font-mono text-slate-700 dark:text-slate-300">{item.owner}</span>
                        {/* The kind, always. Without it a team slug and a
                            username look identical, and "who owns this" gets a
                            different answer depending on which you assumed. */}
                        <span className="ml-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                          {item.ownerKind === "team" ? "team"
                            : item.ownerKind === "admin" ? "admin"
                            : item.ownerKind === "unlinked-committer" ? "top committer \u00b7 no account"
                            : "top committer"}
                        </span>
                      </span>
                    ) : (
                      /* Said outright. An empty cell reads as "not looked up",
                         and having nobody at all is a finding in itself. */
                      <span className="text-amber-700 dark:text-amber-500">No owner found</span>
                    )}
                  </td>
                )}
                {config.type === "query" && (
                  <td className="px-6 py-4 text-sm">
                    <span title={item.reason} className={`block truncate ${item.status === "fail" ? "text-rose-700 dark:text-red-400" : "text-slate-800 dark:text-slate-200"}`}>{item.reason}</span>
                    {item.details && <span title={item.details} className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5 block truncate">{item.details}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      )}
      <Pager
        page={table.page} totalPages={table.totalPages} onPage={table.setPage}
        matchCount={table.matchCount} totalCount={table.totalCount}
        filtered={table.filtered} noun="rows"
      />
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

  // Rendered into <body>, not in place.
  //
  // The expanded widget sits inside a div carrying enter(), whose fadeInUp
  // animation runs with fill-mode `both` and so leaves transform:translateY(0)
  // applied for good. A transform on an ancestor makes that ancestor the
  // containing block for position:fixed descendants, so `fixed inset-0`
  // measured against the card instead of the viewport and the dialog opened
  // below the fold. A portal escapes the whole chain, and keeps doing so if
  // someone adds a transform higher up later.
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/40  animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-paper rounded-2xl shadow-xl border border-slate-200 dark:border-rule w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-rule flex items-center justify-between bg-white dark:bg-paper shrink-0 rounded-t-2xl">
          <h3 className="display text-[1.1875rem] text-ink flex items-center gap-2">
            <i className="ph-fill ph-info text-blue-600 dark:text-blue-400"></i>
            {name}
          </h3>
          <div className="flex items-center gap-3">
            {githubLink && (
              <a
                href={githubLink}
                target="_blank"
                rel="noopener noreferrer"
                className="stamp stamp-hollow"
              >
                <i className="ph-fill ph-github-logo text-sm"></i>
                View in GitHub
              </a>
            )}
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-ink hover:bg-slate-100 dark:hover:bg-paper-2 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div className="p-6 overflow-y-auto bg-slate-50 dark:bg-paper flex-1 rounded-b-2xl">
          <div className="flex flex-col gap-4">
            {item.status && (
              <div className="flex flex-col border-b border-slate-100 dark:border-rule pb-3">
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
              <div className="flex flex-col border-b border-slate-100 dark:border-rule pb-3">
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
              <div className="flex flex-col border-b border-slate-100 dark:border-rule pb-3">
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
              <div key={i} className="flex flex-col border-b border-slate-100 dark:border-rule pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 dark:text-slate-200 bg-white dark:bg-paper p-3 rounded-lg border border-slate-200 dark:border-rule overflow-x-auto whitespace-pre-wrap font-mono">
                  {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                </pre>
              </div>
            ))}
            {!item.status && Object.entries(item).filter(([k]) => ["reason"].includes(k)).map(([k, v], i) => (
              <div key={`r-${i}`} className="flex flex-col border-b border-slate-100 dark:border-rule pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 dark:text-slate-200 bg-white dark:bg-paper p-3 rounded-lg border border-slate-200 dark:border-rule overflow-x-auto whitespace-pre-wrap font-mono">
                  {String(v)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  ), document.body);
}

/* ─── Widget Details Modal (expanded from grid card) ─── */


/* ─── Widget Form Modal (Add / Edit) ─── */

export function WidgetFormModal({ onClose, onSave, isSaving, initialData }: { onClose: () => void; onSave: (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => void; isSaving?: boolean; initialData?: WidgetConfig }) {
  const isEditing = !!initialData;
  const [title, setTitle] = useState(initialData?.title || "");
  const [type, setType] = useState<WidgetType>(initialData?.type || "preset");
  const [presetId, setPresetId] = useState<PresetId>((initialData?.presetId as PresetId) || "dependabot");
  // Reuses queryParam rather than adding a field, so it persists with the rest
  // of the widget without a schema change.
  const [picked, setSeverities] = useState<Severity[]>(() => parseSeverities(initialData?.queryParam));
  /**
   * Nothing reads this any more. A widget renders as a card carrying both a
   * number and a table, so the setting changed nothing about what you got.
   *
   * The field stays because the API requires one and every stored widget has
   * one, so it is sent as a constant rather than dropped from the payload,
   * which keeps widgets created before and after identical on disk.
   */
  const displayType: DisplayType = initialData?.displayType || "table";

  const [selectedQueryId, setSelectedQueryId] = useState<string>(initialData?.queryId || QUERY_OPTIONS[0].id);
  const initParam = initialData?.queryParam || "";
  const initQuery = initialData?.queryId ? QUERY_OPTIONS.find(q => q.id === initialData.queryId) : null;
  const initAdv = initialData?.queryAdvanced;
  const [paramValue, setParamValue] = useState<string>(initQuery?.useTagInput ? "" : initParam);
  const [paramTags, setParamTags] = useState<string[]>(initQuery?.useTagInput && initParam ? initParam.split(",").map(s => s.trim()).filter(Boolean) : []);
  const [hasPendingTag, setHasPendingTag] = useState(false);
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
    setParamTags([]);
  };

  const pendingTagError = type === "query" && selectedQuery?.useTagInput && hasPendingTag;
  const emptyTagError = type === "query" && selectedQuery?.useTagInput && paramTags.length === 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!title.trim()) return;
    if (pendingTagError || emptyTagError) return;
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
      const resolvedParam = selectedQuery?.useTagInput ? paramTags.join(", ") : paramValue.trim();
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
      <div className="absolute inset-0 bg-slate-900/40  animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-paper rounded-2xl shadow-xl border border-slate-200 dark:border-rule w-full max-w-xl relative z-10 animate-slide-up flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-rule flex items-center justify-between rounded-t-2xl">
          <h3 className="display text-[1.1875rem] text-ink">{isEditing ? "Edit Widget" : "Add Dashboard Widget"}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-ink"><i className="ph ph-x text-lg"></i></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-semibold text-slate-900 dark:text-ink mb-1">Widget Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-rule rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-paper-2 dark:text-slate-200"
              placeholder="e.g. My Custom Metric"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-900 dark:text-ink mb-1">Data Source</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as WidgetType)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-rule rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-paper-2 dark:text-slate-200"
            >
              <option value="preset">Built-in Ranking Presets</option>
              <option value="query">Security Insight Query</option>
            </select>
          </div>

          <div className="p-4 bg-slate-50 dark:bg-paper border border-slate-200 dark:border-rule rounded-lg space-y-4">
            {type === "preset" ? (
              <div>
                <label className="block text-sm font-semibold text-slate-900 dark:text-ink mb-1">Select Preset</label>
                <select
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value as PresetId)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-rule rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-paper-2 dark:text-slate-200"
                >
                  {presetOptions(initialData?.presetId).map(id => (
                    <option key={id} value={id}>{PRESET_LABELS[id] ?? id}</option>
                  ))}
                </select>

                {presetId === "vuln-repos" && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between gap-3 mb-2">
                      <label className="block text-sm font-semibold text-slate-900 dark:text-ink">Count which severities</label>
                      <button
                        type="button"
                        onClick={() => setSeverities(picked.length === SEVERITIES.length ? ["critical"] : [...SEVERITIES])}
                        className="textlink caps !text-indigo"
                      >
                        {picked.length === SEVERITIES.length ? "Critical only" : "Select all"}
                      </button>
                    </div>

                    {/* Any combination, not a threshold, "critical and medium
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
                                ? "border-slate-900 dark:border-white bg-slate-900 dark:bg-white text-reverse dark:text-slate-900"
                                : "border-slate-300 dark:border-rule text-slate-600 dark:text-slate-300 hover:border-slate-400 dark:hover:border-rule"}`}
                          >
                            <i className={`ph-bold ${on ? "ph-check-square" : "ph-square"} text-base`}></i>
                            {sev}
                          </button>
                        );
                      })}
                    </div>

                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2.5">
                      Counting <span className="font-semibold text-slate-600 dark:text-slate-300">{describeSeverities(picked)}</span>.
                      Repositories, not alerts. A repo with six criticals counts once. Reads the same
                      data as the Dependabot tab, so this widget makes no extra GitHub requests.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-semibold text-slate-900 dark:text-ink mb-1">Select Insight Query</label>
                  <select
                    value={selectedQueryId}
                    onChange={(e) => handleQuerySelect(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-rule rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-paper-2 dark:text-slate-200"
                  >
                    {QUERY_OPTIONS.map(q => (
                      <option key={q.id} value={q.id}>{q.label}</option>
                    ))}
                  </select>
                </div>

                {selectedQuery?.requiresParam && (
                  <div>
                    <label className="block text-sm font-semibold text-slate-900 dark:text-ink mb-1">{selectedQuery.paramLabel}</label>
                    {selectedQuery.useTagInput ? (
                      <>
                        <TagInput
                          tags={paramTags}
                          onChange={setParamTags}
                          onPendingTextChange={setHasPendingTag}
                          icon={selectedQuery.paramIcon ?? selectedQuery.icon}
                          colorClass="blue"
                          placeholder={`Type ${paramNoun(selectedQuery.paramLabel)} and press Enter`}
                        />
                        {submitAttempted && pendingTagError && (
                          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                            <i className="ph-bold ph-warning-circle"></i>
                            Press Enter to confirm the {paramNoun(selectedQuery.paramLabel)} before saving.
                          </p>
                        )}
                        {submitAttempted && emptyTagError && !pendingTagError && (
                          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                            <i className="ph-bold ph-warning-circle"></i>
                            At least one {paramNoun(selectedQuery.paramLabel)} is required.
                          </p>
                        )}
                      </>
                    ) : (
                      <input
                        type="text"
                        value={paramValue}
                        onChange={(e) => setParamValue(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 dark:border-rule rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-paper-2 dark:text-slate-200"
                        required
                      />
                    )}
                  </div>
                )}

                {selectedQuery?.hasAdvancedRules && (
                  <div className="pt-3 border-t border-slate-200 dark:border-rule space-y-3">
                    <label className="caps block">Branch Rule Configuration</label>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 dark:text-ink mb-1">Protection Type</label>
                        <select
                          value={protectionType}
                          onChange={(e) => setProtectionType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 dark:border-rule rounded-md text-sm outline-none focus:border-blue-500 bg-white dark:bg-paper-2 dark:text-slate-200"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="classic">Must use Classic Protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 dark:text-ink mb-1">Rule Matching Mode</label>
                        <select
                          value={ruleMatchType}
                          onChange={(e) => setRuleMatchType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 dark:border-rule rounded-md text-sm outline-none focus:border-blue-500 bg-white dark:bg-paper-2 dark:text-slate-200"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>
                    </div>

                    {ruleMatchType !== "any" && (
                      <div className="bg-white dark:bg-paper border border-slate-200 dark:border-rule rounded-lg p-3">
                        <h4 className="caps mb-2">Required Rules</h4>
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
                                className="w-16 rounded-md border-slate-300 dark:border-rule py-1 px-2 text-xs ring-1 ring-inset ring-slate-300 dark:ring-rule outline-none focus:border-blue-500 bg-white dark:bg-paper-2 dark:text-slate-200"
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
                          <summary className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 cursor-pointer hover:underline list-none flex items-center gap-1 select-none pt-2 border-t border-slate-100 dark:border-rule">
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

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 dark:border-rule">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 dark:border-rule rounded-lg text-sm font-medium hover:bg-slate-50 dark:hover:bg-paper-2 dark:text-slate-300 transition-colors" disabled={isSaving}>
              Cancel
            </button>
            <button type="submit" className="stamp" disabled={isSaving}>
              {isSaving ? "Saving..." : isEditing ? "Update Widget" : "Save Widget"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
