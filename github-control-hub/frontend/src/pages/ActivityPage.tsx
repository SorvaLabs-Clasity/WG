import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "../api/auth";
import {
  categoryOf, CATEGORY_LABELS, VIEW_ORDER,
  type ActivityView,
} from "../lib/activityCategories";
import { Page, INTENT, TYPE, SURFACE } from "../design";
import DiffViewer from "../components/DiffViewer";
import DetailedLoggingPanel from "../components/DetailedLoggingPanel";
import ImportantEvents from "../components/ImportantEvents";
import ActivityPulse from "../components/ActivityPulse";
import ActivityTimeline from "../components/ActivityTimeline";
import ActivityStats from "../components/ActivityStats";
import { IMPORTANT_KINDS, importantLabel } from "../lib/importantEvents";
import { ColumnResizeHandle } from "../design";
import { useColumnWidths } from "../hooks/useColumnWidths";
import { activityColumns, activityWidths, activityLayoutId } from "../lib/activityColumns";
import { ACTION_CONFIG, actionLabel } from "../lib/activityActions";
import UserAvatar from "../components/UserAvatar";
import { useAuth } from "../App";
import { useActivity, useActivityPulse, useUndoActivity, useRedoActivity, useRetryActivity, useUndoResolution } from "../hooks/useActivity";
import { useOrgConfig } from "../hooks/useOrgConfig";
import { useWebhookHealth } from "../hooks/useWebhookHealth";
import type { Activity, ActivityAction } from "../types/Activity";
import { buildConflictComparison } from "../utils/conflictComparison";
import CostPanel from "../components/CostPanel";
import GithubBudgetPanel from "../components/GithubBudgetPanel";
import { usePermissions } from "../hooks/usePermissions";


function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function countAllChildren(entry: Activity): number {
  if (!entry.children) return 0;
  let count = entry.children.length;
  for (const c of entry.children) count += countAllChildren(c);
  return count;
}

function countFailed(entry: Activity): number {
  let count = entry.failed ? 1 : 0;
  if (entry.children) for (const c of entry.children) count += countFailed(c);
  return count;
}

function isUndoRedoTracker(entry: Activity): boolean {
  return (
    entry.action === "activity.undo" ||
    entry.action === "activity.redo" ||
    entry.action === "conflict.override" ||
    entry.action === "conflict.skip"
  ) && !!entry.linkedActivityId;
}

/**
 * Records of something that happened to code. The server refuses to undo these
 * outright; the button is hidden so nobody is invited to try. Kept in step with
 * CODE_HISTORY_ACTIONS in backend/src/services/undoPolicy.ts.
 */
const CODE_HISTORY_ACTIONS = new Set([
  "github.push", "github.pr_opened", "github.pr_merged", "github.pr_closed",
]);

function isCodeHistory(entry: Activity): boolean {
  return CODE_HISTORY_ACTIONS.has(entry.action) || entry.source === "github";
}

function canUndo(entry: Activity): boolean {
  if (isUndoRedoTracker(entry) || isCodeHistory(entry)) return false;
  if (entry.undone || entry.failed) return false;
  if (entry.undoPayload) return true;
  if (entry.children && entry.children.length > 0) return entry.children.some(c => canUndo(c));
  return false;
}

function canRedo(entry: Activity): boolean {
  if (isUndoRedoTracker(entry) || isCodeHistory(entry)) return false;
  if (!entry.undone) return false;
  if (entry.undoPayload) return true;
  // Without a payload there is nothing to reapply. Offering redo here only
  // ever cleared a flag the old undo path should not have set.
  return entry.children?.some(canRedo) ?? false;
}

function findActivityById(entries: Activity[], id: string): Activity | undefined {
  for (const e of entries) {
    if (e.id === id) return e;
    if (e.children) {
      const found = findActivityById(e.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function findActivityPath(entries: Activity[], targetId: string, path: string[] = []): string[] | null {
  for (const e of entries) {
    if (e.id === targetId) return [...path, e.id];
    if (e.children) {
      const found = findActivityPath(e.children, targetId, [...path, e.id]);
      if (found) return found;
    }
  }
  return null;
}

function canRetry(entry: Activity): boolean {
  if (entry.failed && entry.retryPayload) return true;
  if (entry.children && entry.children.length > 0) return entry.children.some(c => canRetry(c));
  return false;
}

function hasUnresolvedHold(entry: Activity): boolean {
  if (entry.action === "conflict.pending" && !entry.conflictResolution && !entry.undone) return true;
  if (entry.children) return entry.children.some(c => hasUnresolvedHold(c));
  return false;
}

function allChildrenUndone(entry: Activity): boolean {
  if (!entry.children || entry.children.length === 0) return entry.undone === true;
  return entry.children.every(c => allChildrenUndone(c));
}

/**
 * Whether GitHub is still reaching us.
 *
 * A broken webhook looks exactly like a quiet week, the feed simply stops
 * growing, and there is no backfill, so anything that happened in the meantime
 * is gone rather than late. Saying when GitHub last got through is what makes
 * the two distinguishable.
 */
/**
 * The stream, as a colour on the row's left edge.
 *
 * The same three the chart above uses, so a row and a band in the graph are
 * recognisably the same thing. It replaces a 116px column that held one icon.
 */
const STREAM_RAIL: Record<string, string> = {
  github: "bg-indigo-400 dark:bg-indigo-500",
  aws: "bg-amber-400 dark:bg-amber-500",
  app: "bg-emerald-400 dark:bg-emerald-500",
};

function WebhookPulse() {
  const { data } = useWebhookHealth();
  if (!data) return null;

  const tone = data.status === "healthy" ? "good" : data.status === "quiet" ? "info" : "warn";
  const label = data.status === "unknown" ? "No events received yet"
    : data.status === "healthy" ? "Receiving events"
    : data.status === "quiet" ? "Quiet for a day"
    : "Nothing for 3 days";

  const when = data.lastEventAt
    ? new Date(data.lastEventAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className={`shrink-0 inline-flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border ${INTENT[tone].soft} ${INTENT[tone].border}`}>
      <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${INTENT[tone].mark} ${data.status === "healthy" ? "animate-pulse" : ""}`} />
      <span className="min-w-0">
        <span className={`block text-[12.5px] font-bold ${INTENT[tone].text}`}>{label}</span>
        <span className="block text-[11.5px] text-slate-500 dark:text-slate-400 mt-0.5">
          {when ? <>last: {when}</> : "check the org webhook is configured"}
        </span>
      </span>
    </div>
  );
}

/**
 * How an actor reads in the table.
 *
 * Audit events GitHub raises itself carry no actor, a vulnerability alert being
 * created is not something a person did. Older rows say "unknown", which claims
 * the actor could not be identified rather than that there was none.
 */
function actorLabel(actor: string): string {
  const a = (actor || "").trim().toLowerCase();
  if (!a || a === "unknown" || a === "github[system]" || a === "system") return "GitHub (automatic)";
  return actor;
}

/**
 * What each stream holds, said plainly, because the tab label cannot.
 *
 * A row lands in a stream by what its action *changed*, not by where the change
 * came from, which is the part that reads as arbitrary until it is stated.
 * Removing branch protection is an Organization row whether somebody did it in
 * this app or on github.com, because the same thing changed either way.
 */
const CATEGORY_DESCRIPTIONS: Record<ActivityView, string> = {
  all: "Every row from all three streams, newest first. Each row is tagged with the stream it belongs to.",
  github: "Things that changed your GitHub organization, branches, protection, rulesets, repositories, Dependabot. Whether the change was made here or on github.com.",
  aws: "Findings and remediations from the AWS guardrail engine.",
  app: "This app's own settings, widgets, scanners, imports, and undo history. Nothing here changed GitHub or AWS.",
};

/** The views that replace the table, in the order they are offered. */
type Lens = "stats" | "feed" | "important" | "costs" | "github";

const LENSES: ReadonlyArray<readonly [Lens, string, string]> = [
  ["stats", "ph-chart-line-up", "Statistics"],
  ["feed", "ph-list-magnifying-glass", "Events"],
  ["important", "ph-shield-warning", "Important events"],
  ["costs", "ph-currency-dollar", "Costs"],
  ["github", "ph-git-branch", "GitHub requests"],
];

export default function ActivityPage() {
  const { user } = useAuth();
  const { data: orgConfig } = useOrgConfig();
  const undoMutation = useUndoActivity();
  const redoMutation = useRedoActivity();
  const retryMutation = useRetryActivity();
  const undoResolutionMutation = useUndoResolution();
  const [search, setSearch] = useState("");
  // Whether rows written under detailed logging are shown. A view preference,
  // not a query: hiding them filters the list the page already has, and the
  // choice survives reopening the app because it is the kind of preference
  // somebody sets once.
  // Matches the `lg:` breakpoint the Details column is gated on. Read rather
  // than assumed, because a colgroup with one entry too many shifts every width
  // one column across without throwing.
  const [wide, setWide] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const [showDetailed, setShowDetailed] = useState<boolean>(() => {
    try { return localStorage.getItem("activity:show-detailed") !== "hide"; }
    catch { return true; }
  });
  const setShowDetailedPersistent = (show: boolean) => {
    setShowDetailed(show);
    try { localStorage.setItem("activity:show-detailed", show ? "show" : "hide"); } catch { /* view still changes */ }
  };
  /**
   * Which streams this AWS account can even have rows in.
   *
   * An account holding no GitHub credentials has no GitHub half: no webhooks
   * arrive, no audit log is streamed, and the app's own GitHub-side settings
   * cannot be reached. Offering those streams there is offering three empty
   * lists, and defaulting to one of them opens the tab on nothing at all,
   * which reads as "the activity feed is broken" rather than as "this account
   * only does AWS".
   */
  const { data: authStatus } = useQuery({
    queryKey: ["auth", "status"],
    queryFn: fetchAuthStatus,
    staleTime: 60_000,
  });
  const awsOnly = authStatus?.githubAccess?.allowed === false;
  const views = useMemo(
    () => (awsOnly ? VIEW_ORDER.filter(v => v === "all" || v === "aws") : VIEW_ORDER),
    [awsOnly],
  );

  /**
   * The views on the right of the segmented control.
   *
   * GitHub requests is dropped in an AWS-only install rather than shown empty:
   * there is no GitHub App there, so the route behind it is gated off and the
   * lens would be a tab that only ever explains why it cannot load.
   */
  const { data: perms } = usePermissions();
  const awsAdmin = perms?.isAwsAdmin !== false;

  const lenses = useMemo(
    () => LENSES.filter(([v]) =>
      !(awsOnly && v === "github")
      // Costs reads the AWS account, on the route the AWS tab is gated behind.
      // Left visible it is a tab that only ever renders a permission error.
      && !(v === "costs" && !awsAdmin)),
    [awsOnly, awsAdmin]);

  // Defaults to the organization stream rather than to Everything. That is what
  // this app exists to record, and opening on a merged feed puts dashboard
  // housekeeping beside branch protection disappearing, which is the mixing
  // the streams were introduced to undo. Everything is one click away.
  const [category, setCategory] = useState<ActivityView>("github");

  // The merged view puts one more badge in every Action cell, so it gets its
  // own default width and remembers its own layout.
  const merged = category === "all";
  const columns = useMemo(() => activityColumns(wide, merged), [wide, merged]);
  const columnDefaults = useMemo(() => activityWidths(columns), [columns]);
  const cols = useColumnWidths(activityLayoutId(columns, merged), columnDefaults);

  /**
   * Four things this tab is for, separated rather than stacked, because each
   * answers a different question and got in the others' way on one screen.
   *
   *   Statistics       the shape everything makes. Never filtered.
   *   Events           find one row. Streams, filters, table or timeline.
   *   Important events the changes worth knowing about, and who is told.
   *   Costs            what the app's own AWS resources have consumed.
   *   GitHub requests  where the organization's API allowance goes.
   *
   * Not extra streams: the streams narrow which rows the table shows, and
   * these replace the table.
   *
   * Costs sits here rather than under AWS Guardrails because the bill covers
   * both halves of the app, and this is the tab that carries both and exists
   * in an AWS-only install. GitHub requests sits beside it because it is the
   * same question asked of the other half, and the two are read together.
   */
  const [lens, setLens] = useState<Lens>(() => {
    try {
      const v = localStorage.getItem("activity:lens");
      return v === "stats" || v === "important" || v === "costs" || v === "github" ? v : "feed";
    } catch { return "feed"; }
  });
  const setLensPersistent = (v: Lens) => {
    setLens(v);
    try { localStorage.setItem("activity:lens", v); } catch { /* the view still changes */ }
  };

  /**
   * Table or timeline. The same rows, the same filters, a different arrangement.
   *
   * The table is the right shape for working, with resizable columns, diffs and
   * the undo controls. The timeline is the right shape for the question people
   * open this tab with, which is "what happened last night", a question a
   * table answers only after you have done the grouping in your head.
   */
  const [shape, setShape] = useState<"table" | "timeline">(() => {
    try { return localStorage.getItem("activity:shape") === "timeline" ? "timeline" : "table"; }
    catch { return "table"; }
  });
  const setShapePersistent = (v: "table" | "timeline") => {
    setShape(v);
    try { localStorage.setItem("activity:shape", v); } catch { /* the view still changes */ }
  };

  /** How far back the header charts. Remembered, like the other view choices. */
  const [pulseHours, setPulseHours] = useState<number>(() => {
    try { return Number(localStorage.getItem("activity:pulse-hours")) || 168; }
    catch { return 168; }
  });
  const setPulseHoursPersistent = (h: number) => {
    setPulseHours(h);
    try { localStorage.setItem("activity:pulse-hours", String(h)); }
    catch { /* the view still changes */ }
  };
  const { data: pulse, isLoading: pulseLoading } = useActivityPulse(pulseHours);

  /**
   * Whether the important events show in the table, and which of them.
   *
   * Same shape as the detailed-rows toggle and for the same pair of wishes:
   * they are among the noisiest rows in the organization stream, and they are
   * also the ones people most often want on their own.
   *
   * An empty `kinds` means all of them. It is a narrowing, not a whitelist, so
   * a fresh install shows everything rather than nothing.
   */
  const [showImportant, setShowImportant] = useState<boolean>(() => {
    try { return localStorage.getItem("activity:show-important") !== "hide"; }
    catch { return true; }
  });
  const [importantKinds, setImportantKinds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("activity:important-kinds") || "[]"); }
    catch { return []; }
  });
  const setShowImportantPersistent = (show: boolean) => {
    setShowImportant(show);
    try { localStorage.setItem("activity:show-important", show ? "show" : "hide"); }
    catch { /* the view still changes */ }
  };
  const toggleKind = (id: string) => {
    setImportantKinds(prev => {
      const next = prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id];
      try { localStorage.setItem("activity:important-kinds", JSON.stringify(next)); }
      catch { /* the view still changes */ }
      return next;
    });
  };

  /**
   * Follow the account, including when it changes underneath the open tab.
   *
   * Switching accounts from the navbar does not remount this page, so a stream
   * that has just stopped existing would stay selected and show nothing.
   */
  useEffect(() => {
    if (awsOnly && !views.includes(category)) setCategory("aws");
  }, [awsOnly, views, category]);

  // A lens remembered from a GitHub-capable account, reopened against an
  // AWS-only one, would otherwise leave the control showing nothing selected.
  useEffect(() => {
    if (awsOnly && lens === "github") setLensPersistent("costs");
  }, [awsOnly, lens]);

  // A lens remembered from an account that could read it, reopened by somebody
  // who cannot, would leave the control showing nothing selected.
  useEffect(() => {
    if (!awsAdmin && lens === "costs") setLensPersistent("feed");
  }, [awsAdmin, lens]);
  /**
   * How rows somebody wrote arranging their own board are treated.
   *
   * Three states, because both narrowings are wanted and neither is the
   * default: "only" answers "what did I change on my own board", and "hide"
   * gives back the organization's history without personal housekeeping in it.
   */
  const [personalMode, setPersonalMode] = useState<"all" | "only" | "hide">(() => {
    try {
      const v = localStorage.getItem("activity:personal");
      return v === "only" || v === "hide" ? v : "all";
    } catch { return "all"; }
  });
  const setPersonalPersistent = (v: "all" | "only" | "hide") => {
    setPersonalMode(v);
    try { localStorage.setItem("activity:personal", v); } catch { /* the view still changes */ }
  };

  const [repoFilter, setRepoFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<Activity | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);
  const [conflictDiffOpenId, setConflictDiffOpenId] = useState<string | null>(null);
  const [perPage, setPerPage] = useState(50);

  /**
   * The pages walked so far. Index 0 is the newest page.
   *
   * DynamoDB pages forward with an opaque cursor and cannot jump to page N, so
   * "previous" is remembering where you were rather than computing it. Changing
   * any filter empties this, because the cursors describe a walk of the old
   * query.
   */
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);

  // Typing is not a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /**
   * How many filters are narrowing the feed right now.
   *
   * A filtered feed and an empty one look identical from the outside, and the
   * controls that caused it are collapsed into a card somebody has scrolled
   * past. This is the number that tells them which they are looking at.
   */
  const activeFilterCount = [
    !!repoFilter, !!targetFilter, !!search,
    !showDetailed, !showImportant, importantKinds.length > 0,
    personalMode !== "all",
  ].filter(Boolean).length;

  const serverQuery = useMemo(() => ({
    ...(debouncedSearch ? { q: debouncedSearch } : {}),
    ...(category !== "all" ? { category } : {}),
    ...(repoFilter ? { repoFilter } : {}),
    ...(targetFilter ? { target: targetFilter } : {}),
    ...(showDetailed ? {} : { detailed: "hide" as const }),
    ...(showImportant ? {} : { important: "hide" as const }),
    ...(showImportant && importantKinds.length ? { importantKinds: importantKinds.join(",") } : {}),
    ...(personalMode !== "all" ? { personal: personalMode } : {}),
    // Every value read above is listed below. A filter left out of this array
    // is a filter that does nothing at all: the object never rebuilds, so the
    // query key never changes and React Query never refetches. It looks exactly
    // like a broken backend from the outside.
  }), [debouncedSearch, category, repoFilter, targetFilter,
       showDetailed, showImportant, importantKinds, personalMode]);

  // Back to the newest page whenever the question changes.
  useEffect(() => {
    setCursors([undefined]);
    setPageIndex(0);
  }, [serverQuery]);

  const { data, isLoading, isFetching, error } = useActivity(
    perPage, cursors[pageIndex], undefined, serverQuery);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isBusy = undoMutation.isPending || redoMutation.isPending || retryMutation.isPending || undoResolutionMutation.isPending;

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleUndoFromPopup = useCallback((entry: Activity) => {
    undoMutation.mutate(entry.id, {
      onSuccess: (result) => {
        // The reason matters more than the count, a refusal here is usually
        // "that branch has commits on it", which the user has to act on.
        setSnack(result.errors.length > 0
          ? { msg: result.errors[0], severity: "error" }
          : { msg: `Undone ${result.undone.length} action${result.undone.length !== 1 ? 's' : ''}`, severity: "success" });
        setSelectedEvent(null);
      },
      onError: (err) => { setSnack({ msg: (err as Error).message, severity: "error" }); },
    });
  }, [undoMutation]);

  const handleRedoFromPopup = useCallback((entry: Activity) => {
    redoMutation.mutate(entry.id, {
      onSuccess: (result) => {
        setSnack({ msg: `Redone ${result.redone.length} action${result.redone.length !== 1 ? 's' : ''}`, severity: result.errors.length > 0 ? "error" : "success" });
        setSelectedEvent(null);
      },
      onError: (err) => { setSnack({ msg: (err as Error).message, severity: "error" }); },
    });
  }, [redoMutation]);

  const handleRetryFromPopup = useCallback((entry: Activity) => {
    retryMutation.mutate(entry.id, {
      onSuccess: (result) => {
        setSnack({ msg: `Retried ${result.retried.length} action${result.retried.length !== 1 ? 's' : ''}${result.errors.length > 0 ? ` (${result.errors.length} still failed)` : ''}`, severity: result.errors.length > 0 ? "error" : "success" });
        setSelectedEvent(null);
      },
      onError: (err) => { setSnack({ msg: (err as Error).message, severity: "error" }); },
    });
  }, [retryMutation]);

  const handleUndoResolution = useCallback((entry: Activity) => {
    undoResolutionMutation.mutate(entry.id, {
      onSuccess: () => {
        setSnack({ msg: `Resolution undone for "${entry.target}". Conflict is back on hold`, severity: "success" });
        setSelectedEvent(null);
      },
      onError: (err) => { setSnack({ msg: (err as Error).message, severity: "error" }); },
    });
  }, [undoResolutionMutation]);

  /**
   * Whatever the server matched. Every filter above ran against the whole
   * table, not against a page that happened to be loaded.
   */
  const filtered = data?.entries ?? [];

  /**
   * No per-stream totals, deliberately.
   *
   * Counted from the rows the browser holds, the number describes the page
   * rather than the stream. A real total means counting every row in the table
   * on every load, which is not worth a badge.
   */

  // Which sources exist in this view, and therefore whether offering the

  // filter can change anything at all.



  const paginatedEntries = filtered;
  const hasMore = !!data?.cursor;
  /**
   * The server read its budget without reaching the end.
   *
   * Only meaningful when nothing matched: "no results in the newest few
   * thousand rows" is a different answer from "no results", and saying the
   * second when you mean the first is how somebody concludes a change was never
   * recorded.
   */
  const stoppedEarly = data?.exhausted === false && filtered.length === 0;

  const goNext = () => {
    if (!data?.cursor) return;
    setCursors(prev => {
      const next = prev.slice(0, pageIndex + 1);
      next.push(data.cursor);
      return next;
    });
    setPageIndex(i => i + 1);
  };
  const goPrev = () => setPageIndex(i => Math.max(0, i - 1));
  const hasFilters = Object.keys(serverQuery).length > 0;

  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-activity-id="${highlightedId}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 3000);
    return () => { clearTimeout(timer); clearTimeout(highlightTimerRef.current); };
  }, [highlightedId]);

  const navigateToActivity = useCallback((targetId: string) => {
    let path = findActivityPath(filtered, targetId);
    let searchEntries = filtered;

    if (!path || path.length === 0) {
      if (data?.entries) {
        path = findActivityPath(data.entries, targetId);
        searchEntries = data.entries;
        if (path) {
          setRepoFilter("");
          setTargetFilter("");
          setSearch("");
        }
      }
    }

    if (!path || path.length === 0) return;

    const topLevelId = path[0];
    const topIdx = searchEntries.findIndex((e) => e.id === topLevelId);
    if (topIdx === -1) return;


    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < path!.length - 1; i++) next.add(path![i]);
      return next;
    });

    setSelectedEvent(null);
    setHighlightedId(targetId);
  }, [filtered, data, perPage]);

  const renderRow = (entry: Activity, depth: number) => {
    const cfg = ACTION_CONFIG[entry.action as ActivityAction] || { label: entry.action, colorClass: "bg-gray-50 dark:bg-slate-800", iconClass: "fa-solid fa-circle" };
    const hasChildren = entry.children && entry.children.length > 0;
    const isExpanded = expandedIds.has(entry.id);
    const isUndoneEntry = entry.undone === true;
    const isFailedEntry = entry.failed === true;
    const allDone = hasChildren && allChildrenUndone(entry);
    const dimmed = isUndoneEntry || allDone;
    const failedCount = hasChildren ? countFailed(entry) : 0;

    const rows: React.ReactElement[] = [];

    const isHold = entry.action === "conflict.pending" && !entry.conflictResolution && !entry.undone;
    const containsHold = !isHold && hasUnresolvedHold(entry);
    // A hold on this row itself is a historical, unresolvable state, the
    // templates feature that could act on it is gone, so it gets an
    // identifying badge below but not the amber "needs attention" row
    // treatment. Collapsed rows that merely contain one still get it, since
    // expanding them is an action a user can still take.
    const showHoldHighlight = containsHold && !isExpanded;

    const isHighlighted = highlightedId === entry.id;
    rows.push(
      <tr
        key={entry.id}
        data-activity-id={entry.id}
        // The hold state is a background wash only. It used to add a left
        // border too, which now runs down the same three pixels as the stream
        // rail and won, so a held row lost the one mark saying where it came
        // from.
        className={`group cursor-pointer transition-colors duration-150
          hover:bg-slate-50 dark:hover:bg-white/[0.04]
          ${dimmed ? "opacity-50" : ""}
          ${isFailedEntry ? "bg-red-50/40 dark:bg-red-950/40" : ""}
          ${isHighlighted ? "ring-2 ring-inset ring-gh-blue bg-blue-50/60 dark:bg-blue-950/60 animate-pulse-once" : ""}
          ${showHoldHighlight ? "bg-amber-50/70 dark:bg-amber-950/70" : ""}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('[data-expand-btn]')) return;
          setSelectedEvent(entry);
        }}
      >
        {/* ── 1. what happened ──────────────────────────────────────── */}
        <td className="py-3 pr-4 overflow-hidden relative"
            style={{ paddingLeft: `${16 + depth * 22}px` }}>
          {/* The stream, as a colour rather than as a column of its own. Same
              three colours the chart above uses, so a row and a band in the
              graph are recognisably the same thing. */}
          <span aria-hidden="true"
            className={`absolute left-0 inset-y-0 w-[3px] ${STREAM_RAIL[categoryOf(entry.action)] ?? "bg-slate-300 dark:bg-slate-600"}`} />

          <div className="flex items-start gap-2 min-w-0">
            <div className="flex items-center gap-1 shrink-0 pt-0.5">
              {depth > 0 && (
                <span className="text-slate-300 dark:text-slate-600 text-[10px] select-none" aria-hidden="true">
                  <i className="fa-solid fa-turn-up fa-rotate-90"></i>
                </span>
              )}
              {hasChildren ? (
                <button data-expand-btn onClick={(e) => { e.stopPropagation(); toggleExpanded(entry.id); }}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse" : `Expand ${countAllChildren(entry)} related`}
                  className="w-5 h-5 flex items-center justify-center rounded-md text-slate-400 dark:text-slate-500
                             hover:bg-slate-200 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
                  <i className={`fa-solid fa-chevron-${isExpanded ? "down" : "right"} text-[9px]`}></i>
                </button>
              ) : <span className="w-5 inline-block" />}

              {/* Audit rows had no case here and fell through to the shield,
                  captioned "Control Hub App Event". Which is the one thing they
                  are certainly not: they come from GitHub's enterprise stream
                  and this app never wrote them. */}
              {isFailedEntry
                ? <i className="fa-solid fa-circle-exclamation text-[13px] text-red-500" title="Failed"></i>
                : entry.source === "github"
                  ? <i className="fa-brands fa-github text-[13px] text-slate-500 dark:text-slate-400" title="Reported by GitHub webhook"></i>
                  : <i className="fa-solid fa-shield-halved text-[12px] text-gh-blue dark:text-blue-400" title="Done in the Control Hub app"></i>}
            </div>

            <div className="min-w-0 flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border shrink-0 ${isFailedEntry ? "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800" : cfg.colorClass} ${isUndoneEntry ? "line-through" : ""}`}>
                <i className={isFailedEntry ? "fa-solid fa-xmark text-[10px]" : cfg.iconClass}></i>
                {/* The event itself, not the category it belongs to. Every one
                    of these rows said "Security Alert", which is the name of
                    the drawer rather than the name of the thing in it. */}
                {isFailedEntry
                  ? `${cfg.label} (Failed)`
                  : entry.action === "security.alert"
                    ? importantLabel(entry.importantKind)
                    : cfg.label}
              </span>

              {entry.action === "security.alert" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium shrink-0"
                  title="An important event: it also raised an alert and may have been emailed">
                  important
                </span>
              )}
              {entry.personal && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-500/10
                                 text-violet-700 dark:text-violet-300 border border-violet-200
                                 dark:border-violet-500/30 font-medium shrink-0"
                  title="Somebody arranging their own board, not an organization setting">
                  personal
                </span>
              )}
              {entry.detailed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700/70 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-600 font-medium shrink-0" title="Recorded by detailed GitHub logging">
                  detailed
                </span>
              )}
              {hasChildren && !isExpanded && (
                <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                  +{countAllChildren(entry)}
                </span>
              )}
            </div>
          </div>
        </td>

        {/* ── 2. who ────────────────────────────────────────────────────── */}
        <td className="px-4 py-3 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <UserAvatar login={entry.actor} size={22} />
            <span className="text-[13px] font-medium text-gh-textBase dark:text-slate-200 truncate" title={entry.actor}>
              {actorLabel(entry.actor)}
            </span>
          </div>
        </td>

        {/* ── 3. where, both halves of it ───────────────────────────────── */}
        <td className="px-4 py-3 overflow-hidden">
          {/* Nothing at all when there is no repository.
              A rule was drawn here to mean "does not apply", which reads as
              information on the odd row among many that have one. In the App
              stream almost nothing is scoped to a repository, so every row
              carried the same mark and it became a texture rather than a fact.
              An empty cell under a column headed Scope already says it. */}
          {entry.repo && (
            <span className="block text-[13px] font-medium text-gh-textBase dark:text-slate-200 truncate" title={entry.repo}>
              {entry.repo === "*" ? "Everywhere" : entry.repo}
            </span>
          )}
          {entry.target && (
            <span className="mt-0.5 flex items-center gap-1 font-mono text-[11.5px] text-slate-500 dark:text-slate-400 min-w-0"
              title={entry.target}>
              {entry.action.includes("branch") && (
                <i className="fa-solid fa-code-branch text-[9px] shrink-0" aria-hidden="true"></i>
              )}
              <span className="truncate">{entry.target}</span>
            </span>
          )}
        </td>

        {/* ── 4. the detail line ────────────────────────────────────────── */}
        <td className="px-4 py-3 overflow-hidden hidden lg:table-cell">
          <span className={`text-[13px] truncate block ${isFailedEntry ? "text-red-600 dark:text-red-400" : "text-gh-muted dark:text-slate-400"}`}
            title={entry.details}>
            {entry.details || "\u2014"}
          </span>
        </td>

        {/* ── 5. when, and whether it wants anything ────────────────────── */}
        <td className="px-4 py-3 overflow-hidden text-right">
          <div className="flex items-center justify-end gap-2">
            <span className="text-[12.5px] tabular-nums text-gh-muted dark:text-slate-400" title={entry.timestamp}>
              {formatTimestamp(entry.timestamp)}
            </span>
            {isFailedEntry && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Failed - click to manage"></span>}
            {!isFailedEntry && (canUndo(entry) || canRedo(entry)) && (
              <span className={`w-2 h-2 rounded-full shrink-0 ${isUndoneEntry || allDone ? "bg-orange-400" : "bg-green-400"}`} title="Click to manage"></span>
            )}
            {/* Appears on hover: every row opens, and nothing said so. */}
            <i className="fa-solid fa-chevron-right text-[10px] text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
               aria-hidden="true"></i>
          </div>
        </td>
      </tr>
    );

    if (hasChildren && isExpanded) {
      for (const child of entry.children!) rows.push(...renderRow(child, depth + 1));
    }

    return rows;
  };

  const popupEntry = selectedEvent;
  const popupCfg = popupEntry ? (ACTION_CONFIG[popupEntry.action as ActivityAction] || { label: popupEntry.action, colorClass: "bg-gray-50 dark:bg-slate-800", iconClass: "fa-solid fa-circle" }) : null;
  const popupChildCount = popupEntry ? countAllChildren(popupEntry) : 0;
  const popupFailedCount = popupEntry ? countFailed(popupEntry) : 0;
  const popupIsTracker = popupEntry ? isUndoRedoTracker(popupEntry) : false;
  const popupOriginal = popupIsTracker && popupEntry?.linkedActivityId
    ? findActivityById(data?.entries || [], popupEntry.linkedActivityId)
    : undefined;
  const popupOriginalCfg = popupOriginal ? (ACTION_CONFIG[popupOriginal.action as ActivityAction] || { label: popupOriginal.action, colorClass: "bg-gray-50 dark:bg-slate-800", iconClass: "fa-solid fa-circle" }) : null;
  const popupIsOverriddenConflict = popupEntry?.action === "conflict.pending" && popupEntry.conflictResolution === "override" && !popupEntry.undone;
  const popupIsSkippedConflict = popupEntry?.action === "conflict.pending" && popupEntry.conflictResolution === "skip" && !popupEntry.undone;
  const popupCanUndo = popupEntry ? (!popupIsOverriddenConflict && canUndo(popupEntry)) : false;
  const popupCanRedo = popupEntry ? canRedo(popupEntry) : false;
  const popupCanRetry = popupEntry ? canRetry(popupEntry) : false;

  return (
    <Page user={user}>
        <header className="flex flex-col mb-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <h1 className={TYPE.title + " text-slate-900 dark:text-white"}>Activity</h1>
              {/* One line, and only where it is not already obvious. The stream
                  descriptions moved to the tabs themselves, where the thing
                  they describe is the thing being pointed at. */}
              <p className="text-[13.5px] text-slate-500 dark:text-slate-400 mt-1 max-w-[70ch]">
                {lens === "stats"
                  ? "The shape of everything, across the whole organization."
                  : lens === "important"
                    ? "Changes worth knowing about, grouped by what caused them. Most are somebody doing their job."
                    : lens === "costs"
                      ? "What this app's own AWS resources have consumed, resource by resource."
                      : lens === "github"
                        ? "Every request this app makes to GitHub, what triggers it, and what it draws on."
                        : "Everything this app and GitHub have recorded, newest first."}
              </p>
            </div>
            <WebhookPulse />
          </div>

          {/* Four streams, because four things write here and they are not read
              for the same reason. A widget being renamed and branch protection
              being removed were previously the same list.
              Everything sits first and merges all four, for the times you know
              roughly when something happened but not which stream recorded it -
              a repository going public shows up in Organization and again in the
              audit log, and searching one at a time is how you miss it. */}
          {/* ── the views ────────────────────────────────────────────────
              A segmented control, not tabs, because these are not slices of one
              list. They are separate jobs: see the shape, find a row, review
              what mattered, read a bill. Tabs would have put them on the same
              footing as the stream tabs below, which really are slices.
              Wrapping, because the labels are words rather than icons and five
              of them do not fit a narrow window on one line. */}
          <div className="flex items-center flex-wrap gap-1 p-1 rounded-xl
                          bg-slate-100 dark:bg-white/[0.06] w-fit max-w-full">
            {lenses.map(([v, icon, label]) => (
              <button key={v} onClick={() => setLensPersistent(v)} aria-pressed={lens === v}
                className={`px-3.5 py-2 rounded-lg text-[13px] font-semibold whitespace-nowrap
                            flex items-center gap-2 transition-all
                  ${lens === v
                    ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"}`}>
                <i className={`ph-bold ${icon} text-[14px]`} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          {/* ── the streams, which only narrow the feed ───────────────────
              overflow-y-hidden is load-bearing: setting overflow-x to anything
              but visible makes overflow-y compute to auto rather than staying
              visible, and the tabs' -mb-px against a 2px bottom border
              overflows by exactly enough to raise a vertical scrollbar on a row
              of buttons. */}
          {lens === "feed" && (
          <nav className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 -mb-px overflow-x-auto overflow-y-hidden">
            {views.map(c => {
              const active = category === c;
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  aria-current={active ? "page" : undefined}
                  className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors
                    ${active
                      ? "border-blue-600 dark:border-blue-400 text-slate-900 dark:text-white"
                      : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"}`}
                >
                  {CATEGORY_LABELS[c]}
                  {/* What is in each stream over the charted window, so the
                      choice of tab is informed before it is made rather than
                      after. From the pulse, which is unfiltered, so these are
                      stream totals and not a preview of the current filter. */}
                  {pulse && (
                    <span className={`ml-2 text-[11px] tabular-nums px-1.5 py-0.5 rounded-md
                      ${active
                        ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                        : "bg-slate-100 dark:bg-white/[0.07] text-slate-500 dark:text-slate-400"}`}>
                      {/* A "+" when the walk stopped before the window did.
                          The count is then a floor, not a total, and a precise
                          looking number that has quietly stopped rising is
                          worse than a rough one that admits it. */}
                      {(c === "all" ? pulse.total : pulse.byCategory?.[c] ?? 0).toLocaleString()}
                      {!pulse.exhausted && "+"}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          )}

          {/* The stream's own sentence, under the stream. A row lands in a
              stream by what its action *changed*, not by where the change came
              from, and that reads as arbitrary until it is stated. Beside the
              tabs it is read when the tab is chosen; in the page header it was
              read once and never again. */}
          {lens === "feed" && (
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 max-w-[86ch]">
              {CATEGORY_DESCRIPTIONS[category]}
            </p>
          )}

          {/* Every control in here narrows the table. On the dashboard lens
              there is no table, and the dashboard brings its own filters, so
              leaving these on screen would offer two filter sets where only
              one of them did anything. */}
          {lens === "feed" && (
          <div className={`${SURFACE.card} p-4`}>
            <div className="flex items-center gap-2 mb-3">
              <i className="fa-solid fa-filter text-slate-400 dark:text-slate-500 text-[11px]"></i>
              <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Narrow the feed</span>

              {/* What the filters are doing, in a number, beside the controls
                  doing it. A filtered feed and an empty one look identical
                  until something says which it is. */}
              {activeFilterCount > 0 && (
                <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-gh-blue/10 dark:bg-blue-400/15 text-gh-blue dark:text-blue-300">
                  {activeFilterCount} on
                </span>
              )}

              {/* The arrangement, beside the filters that feed it. Both views
                  read the same rows, so this is presentation and belongs with
                  the other view controls rather than in the toolbar. */}
              <div className="ml-auto flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-white/[0.07]">
                {([["table", "ph-table", "Table"], ["timeline", "ph-list-dashes", "Timeline"]] as const).map(
                  ([v, icon, label]) => (
                    <button key={v} onClick={() => setShapePersistent(v)} aria-pressed={shape === v} title={label}
                      className={`px-2.5 py-1 rounded-md text-[12px] font-semibold flex items-center gap-1.5 transition-colors
                        ${shape === v
                          ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm"
                          : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"}`}>
                      <i className={`ph-bold ${icon} text-[13px]`} aria-hidden="true" />
                      {label}
                    </button>
                  ))}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:grid-cols-4">
              {/* Same placement rule as detailed rows: only the streams these
                  can appear in. Elsewhere the control could not change
                  anything on screen. */}
              {(category === "github" || category === "all") && (
                <div>
                  <label className="block text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider mb-1">Important events</label>
                  <select value={showImportant ? "show" : "hide"}
                    onChange={(e) => setShowImportantPersistent(e.target.value === "show")}
                    className="w-full text-sm bg-gray-50 dark:bg-slate-800 border border-gh-border dark:border-slate-600 rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none dark:text-slate-200">
                    <option value="show">Shown</option>
                    <option value="hide">Hidden</option>
                  </select>
                </div>
              )}

              {/* Only where detailed rows can appear: the Organization stream
                  and the merged view. Elsewhere the control could not change
                  anything on screen. */}
              {(category === "github" || category === "all") && (
                <div>
                  <label className="block text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider mb-1">Detailed rows</label>
                  <select value={showDetailed ? "show" : "hide"}
                    onChange={(e) => setShowDetailedPersistent(e.target.value === "show")}
                    className="w-full text-sm bg-gray-50 dark:bg-slate-800 border border-gh-border dark:border-slate-600 rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none dark:text-slate-200">
                    <option value="show">Shown</option>
                    <option value="hide">Hidden</option>
                  </select>
                </div>
              )}
              {/* Only the two streams these rows land in. A personal widget or
                  alarm is an app change, so on the AWS stream this control
                  could not alter anything on screen. */}
              {(category === "app" || category === "all") && (
                <div>
                  <label className="block text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider mb-1">Personal rows</label>
                  <select value={personalMode}
                    onChange={(e) => setPersonalPersistent(e.target.value as "all" | "only" | "hide")}
                    className="w-full text-sm bg-gray-50 dark:bg-slate-800 border border-gh-border dark:border-slate-600 rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none dark:text-slate-200">
                    <option value="all">Shown</option>
                    <option value="only">Only personal</option>
                    <option value="hide">Hidden</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider mb-1">Repository</label>
                <input type="text" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} placeholder="e.g. web-platform" className="w-full text-sm bg-gray-50 dark:bg-slate-800 border border-gh-border dark:border-slate-600 rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none dark:text-slate-200" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider mb-1">Target (Branch/PR)</label>
                <input type="text" value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)} placeholder="e.g. main or 42" className="w-full text-sm bg-gray-50 dark:bg-slate-800 border border-gh-border dark:border-slate-600 rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none dark:text-slate-200" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider mb-1">Search Details</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none text-gray-400 dark:text-slate-500"><i className="fa-solid fa-magnifying-glass text-[11px]"></i></div>
                  <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="User, action, details..." className="w-full pl-7 pr-3 py-1.5 text-sm bg-gray-50 dark:bg-slate-800 border border-gh-border dark:border-slate-600 rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue outline-none dark:text-slate-200" />
                </div>
              </div>
            </div>
            {/* Which of them, once they are shown at all. Chips rather than a
                multi-select, because the answer is usually "these two" and a
                multi-select hides what is chosen behind a closed list.
                None selected means all: a narrowing, never a whitelist that
                would show an empty table until somebody ticked something. */}
            {showImportant && (category === "github" || category === "all") && (
              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700">
                <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                  <span className="text-[11px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider">
                    Which important events
                  </span>
                  <span className="text-[11px] text-gh-muted dark:text-slate-500">
                    {importantKinds.length === 0
                      ? "all of them"
                      : `${importantKinds.length} selected`}
                    {importantKinds.length > 0 && (
                      <button onClick={() => { setImportantKinds([]); try { localStorage.setItem("activity:important-kinds", "[]"); } catch { /* view still changes */ } }}
                        className="ml-2 font-semibold text-gh-muted dark:text-slate-400 hover:text-gh-blue dark:hover:text-blue-400">
                        show all
                      </button>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {IMPORTANT_KINDS.map(k => {
                    const on = importantKinds.includes(k.id);
                    return (
                      <button key={k.id} onClick={() => toggleKind(k.id)} aria-pressed={on}
                        className={`px-2.5 py-1 rounded-lg text-[12px] font-medium border transition-colors
                          ${on
                            ? "bg-rose-600 border-rose-600 text-white"
                            : "bg-gray-50 dark:bg-slate-800 border-gh-border dark:border-slate-600 text-gh-textBase dark:text-slate-300 hover:border-rose-400 dark:hover:border-rose-500"}`}>
                        {k.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {(repoFilter || targetFilter || search) && (
              <div className="mt-3 flex justify-end">
                <button onClick={() => { setRepoFilter(''); setTargetFilter(''); setSearch(''); }} className="text-[11px] font-medium text-gh-muted dark:text-slate-400 hover:text-gh-blue dark:hover:text-blue-400">Clear Filters</button>
              </div>
            )}
          </div>
          )}
        </header>

        {lens === "costs" ? (
          <CostPanel />
        ) : lens === "github" ? (
          <GithubBudgetPanel />
        ) : lens === "stats" ? (
          <div className="grid gap-4">
            {/* The chart keeps its own window control, and Statistics reads the
                same one, so the whole view moves together. */}
            <ActivityPulse pulse={pulse} hours={pulseHours}
              onHours={setPulseHoursPersistent} isLoading={pulseLoading} />
            <ActivityStats pulse={pulse} hours={pulseHours}
              windowLabel={pulseHours <= 24 ? "24 hours" : pulseHours <= 168 ? "7 days" : "30 days"} />
          </div>
        ) : lens === "important" ? <ImportantEvents /> : (
        <>

        {isLoading && <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div></div>}
        {error && <div className="bg-red-50 dark:bg-red-950/50 border-l-4 border-red-500 p-4 rounded-md mb-6"><p className="text-red-700 dark:text-red-400">Failed to load activity: {(error as Error).message}</p></div>}

        {/* Streaming status and its controls, above the table rather than in
            the empty state. Putting them in the empty state meant they were
            reachable only while nothing was arriving, so a stream working
            correctly hid its own off switch, which is the one moment somebody
            goes looking for it. */}
        {!isLoading && !error && category === "github" && <DetailedLoggingPanel />}

        {!isLoading && !error && (
          <div className="bg-white dark:bg-slate-900 rounded-lg border border-gh-border dark:border-slate-700 shadow-subtle overflow-hidden relative">
            {shape === "timeline" ? (
              <div className="px-5 py-3">
                {/* Read-only by design. Undo, redo and diffs live in the table,
                    and a second implementation of the one thing in this app
                    that writes is two chances to get it wrong. Opening a row
                    here takes you there. */}
                <ActivityTimeline
                  entries={filtered}
                  categoryOf={categoryOf}
                  // Opens the same detail panel a table row opens, in place.
                  //
                  // It used to switch back to the table first, which threw away
                  // the view somebody had deliberately chosen in order to show
                  // them something they could have seen without leaving it.
                  onOpen={setSelectedEvent}
                />
                {filtered.length === 0 && (
                  <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Nothing to show for this filter.
                  </p>
                )}
              </div>
            ) : (
            <div className="overflow-x-auto">
              <table
                className="text-left border-collapse"
                // Fixed layout is what makes the colgroup widths authoritative.
                // With `auto` the browser re-measures from content on every
                // render and the width you dragged to is only a suggestion.
                style={{
                  tableLayout: "fixed",
                  width: "100%",
                  // Below this the columns would be squeezed back under their
                  // own widths; the container scrolls instead. The last column
                  // is not counted, since it absorbs the slack.
                  minWidth: columns.slice(0, -1)
                    .reduce((sum, c) => sum + (cols.widths[c.id] ?? c.width), 0) + 160,
                }}
              >
                <colgroup>
                  {columns.map((c, i) => (
                    <col key={c.id} style={i === columns.length - 1
                      ? undefined : { width: cols.widths[c.id] ?? c.width }} />
                  ))}
                </colgroup>
                {/* Sticky, because the feed is long and a column you cannot
                    name is a column you have to scroll back up to read. */}
                <thead className="sticky top-0 z-10 bg-slate-50/95 dark:bg-slate-800/95 backdrop-blur-sm
                                  border-b border-gh-border dark:border-slate-700">
                  <tr>
                    {columns.map((c, i) => (
                      <th key={c.id}
                        className={`relative px-4 py-2.5 text-[10.5px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-[0.13em] ${
                          c.align === "right" ? "text-right" : ""}`}>
                        <span className="block truncate">{c.label}</span>
                        {/* Not on the last column: it has no width of its own
                            to drag, and everything to its left does. */}
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
                <tbody className="divide-y divide-gh-border dark:divide-slate-700">
                  {paginatedEntries.map((entry) => renderRow(entry, 0)).flat()}
                  {paginatedEntries.length === 0 && (
                    <tr><td colSpan={columns.length} className="px-6 py-10 text-center text-gh-muted dark:text-slate-400">
                      {stoppedEarly ? (
                        /* The server read its budget without reaching the end,
                           which is not the same answer as "there are none". */
                        <>
                          <p className="font-semibold text-slate-700 dark:text-slate-200">Nothing matched in the most recent {data?.examined?.toLocaleString() ?? "few thousand"} events</p>
                          <p className="text-sm mt-1">There may be older matches. Press <strong>Older</strong> to keep looking.</p>
                        </>
                      ) : hasFilters ? (
                        <>
                          <p className="font-semibold text-slate-700 dark:text-slate-200">No matching activity</p>
                          <p className="text-sm mt-1">Nothing in the whole feed matches these filters.</p>
                        </>
                      ) : (
                        <>
                          <p className="font-semibold text-slate-700 dark:text-slate-200">Nothing recorded here yet</p>
                          <p className="text-sm mt-1">{CATEGORY_DESCRIPTIONS[category]}</p>
                        </>
                      )}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
            {/* Numbered pages are gone with the client-side slice. DynamoDB
                pages forward with an opaque cursor and cannot jump to page N,
                so offering "page 7" would mean walking to it invisibly. What is
                offered instead is exactly what the store can do. */}
            <div className="px-6 py-3 border-t border-gh-border dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <span className="text-xs text-gh-muted dark:text-slate-400">
                  {paginatedEntries.length === 0
                    ? "No events"
                    : <>Page <strong>{pageIndex + 1}</strong> &middot; <strong>{paginatedEntries.length}</strong> event{paginatedEntries.length === 1 ? "" : "s"}</>}
                  {isFetching && <span className="ml-2 opacity-60">loading…</span>}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-gh-muted dark:text-slate-400">Per page:</span>
                  <select
                    value={perPage}
                    onChange={(e) => setPerPage(Number(e.target.value))}
                    className="text-xs bg-white dark:bg-slate-900 border border-gh-border dark:border-slate-700 rounded px-1.5 py-0.5 outline-none focus:border-gh-blue dark:text-slate-200"
                  >
                    {[25, 50, 100, 200].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { setCursors([undefined]); setPageIndex(0); }}
                  disabled={pageIndex === 0}
                  className="px-2 py-1 text-xs font-medium text-gh-muted dark:text-slate-400 border border-gh-border dark:border-slate-700 rounded bg-white dark:bg-slate-900 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                  title="Newest"
                ><i className="fa-solid fa-angles-left text-[10px]"></i></button>
                {/* Icons, matching the jump-to-newest button beside them. The
                    direction is the whole meaning, and two words of different
                    lengths made a row of controls that never lined up. Both
                    keep a title and an aria-label, since an arrow alone tells
                    a screen reader nothing. */}
                <button
                  onClick={goPrev}
                  disabled={pageIndex === 0}
                  title="Newer"
                  aria-label="Newer events"
                  className="px-2 py-1 text-xs font-medium text-gh-muted dark:text-slate-400 border border-gh-border dark:border-slate-700 rounded bg-white dark:bg-slate-900 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                ><i className="fa-solid fa-angle-left text-[10px]"></i></button>
                <button
                  onClick={goNext}
                  disabled={!hasMore || isFetching}
                  title="Older"
                  aria-label="Older events"
                  className="px-2 py-1 text-xs font-medium text-gh-muted dark:text-slate-400 border border-gh-border dark:border-slate-700 rounded bg-white dark:bg-slate-900 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                ><i className="fa-solid fa-angle-right text-[10px]"></i></button>
              </div>
            </div>
          </div>
        )}

      {/* EVENT DETAIL / UNDO-REDO-RETRY POPUP */}
      {popupEntry && popupCfg && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setSelectedEvent(null)}></div>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-modal border border-black/10 dark:border-slate-700 w-full max-w-lg relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gh-border dark:border-slate-700 flex justify-between items-start rounded-t-xl">
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${popupEntry.failed ? 'bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800' : popupCfg.colorClass}`}>
                  <i className={popupEntry.failed ? 'fa-solid fa-circle-exclamation text-sm' : popupCfg.iconClass.replace('text-[10px]', 'text-sm')}></i>
                </div>
                <div>
                  <h3 className="text-base font-bold text-gh-textBase dark:text-slate-200">{popupEntry.failed ? `${popupCfg.label} (Failed)` : popupCfg.label}</h3>
                  <p className="text-xs text-gh-muted dark:text-slate-400 mt-0.5">{formatTimestamp(popupEntry.timestamp)} &middot; {new Date(popupEntry.timestamp).toLocaleString()}</p>
                </div>
              </div>
              <button onClick={() => setSelectedEvent(null)} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors mt-1">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-4 overflow-y-auto space-y-4">
              {/* Failed banner */}
              {popupEntry.failed && (
                <div className="px-3 py-2.5 bg-red-50 dark:bg-red-950/50 rounded-lg border border-red-200 dark:border-red-800">
                  <div className="flex items-start gap-2">
                    <i className="fa-solid fa-circle-exclamation text-red-500 text-sm mt-0.5"></i>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-red-700 dark:text-red-400">This action failed</p>
                      {popupEntry.errorMessage && (
                        <pre className="mt-1.5 text-xs text-red-600 dark:text-red-400 bg-red-100/50 dark:bg-red-900/30 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono border border-red-200/50 dark:border-red-800">{popupEntry.errorMessage}</pre>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Parent has failed children banner */}
              {!popupEntry.failed && popupFailedCount > 0 && (
                <div className="px-3 py-2 bg-orange-50 dark:bg-orange-950/50 rounded-lg border border-orange-200 dark:border-orange-800 flex items-center gap-2">
                  <i className="fa-solid fa-triangle-exclamation text-orange-500 text-sm"></i>
                  <span className="text-sm text-orange-700 dark:text-orange-400 font-medium">{popupFailedCount} sub-action{popupFailedCount !== 1 ? 's' : ''} failed</span>
                </div>
              )}

              {/* Undone banner */}
              {popupEntry.undone && (
                <div className="flex items-center gap-2 px-3 py-2 bg-orange-50 dark:bg-orange-950/50 rounded-lg border border-orange-200 dark:border-orange-800">
                  <i className="fa-solid fa-rotate-left text-orange-500 text-sm"></i>
                  <span className="text-sm text-orange-700 dark:text-orange-400 font-medium">This action has been undone</span>
                  {popupEntry.undoneAt && <span className="text-xs text-orange-500 dark:text-orange-400 ml-auto">{formatTimestamp(popupEntry.undoneAt)}</span>}
                </div>
              )}

              {/* Original action card for undo/redo tracker entries */}
              {popupIsTracker && popupOriginal && popupOriginalCfg && (
                <div className="border border-gh-border dark:border-slate-700 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 dark:bg-slate-800 px-3 py-2 border-b border-gh-border dark:border-slate-700 flex items-center gap-2">
                    <i className="fa-solid fa-link text-gray-400 dark:text-slate-500 text-[10px]"></i>
                    <span className="text-xs font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider">Original Action</span>
                  </div>
                  <div className="px-4 py-3 space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${popupOriginal.undone ? 'line-through opacity-60' : ''} ${popupOriginalCfg.colorClass}`}>
                        <i className={popupOriginalCfg.iconClass}></i>
                        {popupOriginalCfg.label}
                      </span>
                      {popupOriginal.undone && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/50 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800 font-medium">Undone</span>}
                      {!popupOriginal.undone && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 font-medium">Active</span>}
                    </div>
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                      <span className="text-gh-muted dark:text-slate-400 text-xs">Repo</span>
                      <span className="font-mono text-xs text-gh-textBase dark:text-slate-200">{popupOriginal.repo === '*' ? '* (Global)' : popupOriginal.repo}</span>
                      <span className="text-gh-muted dark:text-slate-400 text-xs">Target</span>
                      <span className="font-mono text-xs text-gh-textBase dark:text-slate-200">{popupOriginal.target}</span>
                      {popupOriginal.details && (
                        <>
                          <span className="text-gh-muted dark:text-slate-400 text-xs">Details</span>
                          <span className="text-xs text-gh-textBase dark:text-slate-200 break-words">{popupOriginal.details}</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t border-gh-border/50 dark:border-slate-700">
                      <button
                        onClick={() => navigateToActivity(popupOriginal.id)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-gh-border dark:border-slate-700 text-gh-textBase dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-1.5"
                      >
                        <i className="fa-solid fa-location-arrow text-[10px] text-gray-400 dark:text-slate-500"></i>
                        Go to Original Event
                      </button>
                      {popupOriginal.action === "conflict.pending" && popupOriginal.conflictResolution === "skip" && !popupOriginal.undone && (
                        <button
                          onClick={() => handleUndoResolution(popupOriginal)}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                        >
                          <i className="fa-solid fa-rotate-left text-[10px]"></i>
                          Undo Skip
                        </button>
                      )}
                      {popupOriginal.action === "conflict.pending" && popupOriginal.conflictResolution === "override" && !popupOriginal.undone && (
                        <>
                          <button
                            onClick={() => handleUndoResolution(popupOriginal)}
                            disabled={isBusy}
                            className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                          >
                            <i className="fa-solid fa-rotate-left text-[10px]"></i>
                            Undo Override
                          </button>
                          <button
                            onClick={() => handleUndoFromPopup(popupOriginal)}
                            disabled={isBusy}
                            className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                          >
                            <i className="fa-solid fa-trash text-[10px]"></i>
                            Undo Event
                          </button>
                        </>
                      )}
                      {!(popupOriginal.action === "conflict.pending" && popupOriginal.conflictResolution) && canRedo(popupOriginal) && (
                        <button
                          onClick={() => handleRedoFromPopup(popupOriginal)}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                        >
                          <i className="fa-solid fa-rotate-right text-[10px]"></i>
                          Redo
                        </button>
                      )}
                      {!(popupOriginal.action === "conflict.pending" && popupOriginal.conflictResolution) && canUndo(popupOriginal) && (
                        <button
                          onClick={() => handleUndoFromPopup(popupOriginal)}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                        >
                          <i className="fa-solid fa-rotate-left text-[10px]"></i>
                          Undo
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {popupIsTracker && !popupOriginal && popupEntry.linkedActivityId && (
                <div className="px-3 py-2.5 bg-gray-50 dark:bg-slate-800 rounded-lg border border-gh-border dark:border-slate-700 flex items-center gap-2">
                  <i className="fa-solid fa-link-slash text-gray-400 dark:text-slate-500 text-sm"></i>
                  <span className="text-sm text-gh-muted dark:text-slate-400">Original event is not in the current view. It may be on another page or nested in a template run.</span>
                </div>
              )}

              {/* Details grid */}
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <span className="text-gh-muted dark:text-slate-400 font-medium">User</span>
                <div className="flex items-center gap-2">
                  <UserAvatar login={popupEntry.actor} size={20} />
                  <span className="font-medium text-gh-textBase dark:text-slate-200">{actorLabel(popupEntry.actor)}</span>
                </div>
                <span className="text-gh-muted dark:text-slate-400 font-medium">Repository</span>
                <span className="font-mono text-xs bg-gray-50 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-slate-700 w-fit">{popupEntry.repo === '*' ? '* (Global)' : popupEntry.repo}</span>
                <span className="text-gh-muted dark:text-slate-400 font-medium">Target</span>
                <span className="font-mono text-xs bg-gray-50 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-slate-700 w-fit">{popupEntry.target}</span>
                {popupEntry.details && (
                  <>
                    <span className="text-gh-muted dark:text-slate-400 font-medium">Details</span>
                    <span className="text-gh-textBase dark:text-slate-200 break-words">{popupEntry.details}</span>
                  </>
                )}
                <span className="text-gh-muted dark:text-slate-400 font-medium">Source</span>
                <span className="text-gh-textBase dark:text-slate-200">{popupEntry.source === 'github' ? 'Native GitHub Event' : 'Control Hub App'}</span>
              </div>

              {/* Children summary */}
              {popupEntry.children && popupEntry.children.length > 0 && (
                <div className="border border-gh-border dark:border-slate-700 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 dark:bg-slate-800 px-3 py-2 border-b border-gh-border dark:border-slate-700 text-xs font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider">
                    Sub-actions ({popupChildCount})
                    {popupFailedCount > 0 && <span className="ml-2 text-red-500 normal-case">&middot; {popupFailedCount} failed</span>}
                  </div>
                  <div className="divide-y divide-gh-border dark:divide-slate-700 max-h-48 overflow-y-auto">
                    {popupEntry.children.map(child => {
                      const childCfg = ACTION_CONFIG[child.action as ActivityAction] || { label: child.action, colorClass: "bg-gray-50 dark:bg-slate-800", iconClass: "fa-solid fa-circle" };
                      const childFailed = child.failed;
                      const childFailedCount = countFailed(child);
                      return (
                        <div
                          key={child.id}
                          className={`px-3 py-2 flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors ${child.undone ? 'opacity-50' : ''} ${childFailed ? 'bg-red-50/30 dark:bg-red-950/30' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setSelectedEvent(child); }}
                        >
                          {childFailed
                            ? <i className="fa-solid fa-circle-exclamation text-red-500 text-[11px]"></i>
                            : child.undone
                              ? <i className="fa-solid fa-rotate-left text-orange-400 text-[11px]"></i>
                              : child.action === "conflict.pending" && !child.conflictResolution
                                ? <i className="fa-solid fa-pause text-amber-500 text-[11px]"></i>
                                : <i className="fa-solid fa-check-circle text-green-500 text-[11px]"></i>}
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${childFailed ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800' : childCfg.colorClass} ${child.undone ? 'line-through' : ''}`}>
                            <i className={childFailed ? 'fa-solid fa-xmark text-[9px]' : childCfg.iconClass}></i>
                            {childCfg.label}
                          </span>
                          <span className="font-mono text-xs text-gray-500 dark:text-slate-400">{child.repo !== '*' && child.repo !== popupEntry.repo ? child.repo : ''}</span>
                          <span className="font-mono text-xs text-gh-textBase dark:text-slate-200">{child.target}</span>
                          {childFailed && child.errorMessage && (
                            <span className="text-[10px] text-red-500 ml-auto truncate max-w-[120px]" title={child.errorMessage}>{child.errorMessage}</span>
                          )}
                          {!childFailed && childFailedCount > 0 && (
                            <span className="text-[10px] text-red-500 ml-auto">{childFailedCount} failed</span>
                          )}
                          {child.undone && !childFailed && <span className="text-[10px] text-orange-500 ml-auto">undone</span>}
                          {child.action === "conflict.pending" && !child.conflictResolution && !childFailed && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 font-semibold ml-auto">On Hold</span>
                          )}
                          {child.conflictResolution === "override" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 font-medium ml-auto">Overridden</span>
                          )}
                          {child.conflictResolution === "skip" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-400 border border-gray-200 dark:border-slate-700 font-medium ml-auto">Skipped</span>
                          )}
                          {child.children && child.children.length > 0 && !childFailed && childFailedCount === 0 && (
                            <span className="text-[10px] text-gray-400 dark:text-slate-500 ml-auto">+{countAllChildren(child)} sub</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Conflict details, as history */}
              {popupEntry.conflictPayload && (
                <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
                  <div className="bg-amber-50 dark:bg-amber-950/50 px-3 py-2 border-b border-amber-200 dark:border-amber-800 flex items-center gap-2">
                    <i className="fa-solid fa-triangle-exclamation text-amber-600 text-xs"></i>
                    <span className="text-xs font-semibold text-amber-800 dark:text-amber-400">
                      {popupEntry.conflictResolution
                        ? `Resolved: ${popupEntry.conflictResolution === "override" ? "Overridden" : "Skipped"}`
                        : "Conflict, Awaiting Resolution"}
                    </span>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${popupEntry.conflictPayload.type === "ruleset" ? "bg-blue-50 text-blue-700 border border-blue-200/60 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800" : "bg-purple-50 text-purple-700 border border-purple-200/60 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-800"}`}>
                        {popupEntry.conflictPayload.type}
                      </span>
                      <span className="text-sm font-medium text-gh-textBase dark:text-slate-200">{popupEntry.conflictPayload.name}</span>
                      <span className="text-xs text-gh-muted dark:text-slate-400">in {popupEntry.conflictPayload.repo}</span>
                    </div>
                    <button
                      className="text-[11px] font-medium text-gh-blue dark:text-blue-400 hover:text-gh-blueHover mt-0.5 flex items-center gap-1"
                      onClick={() => setConflictDiffOpenId(prev => prev === popupEntry.id ? null : popupEntry.id)}
                    >
                      <i className={`fa-solid fa-chevron-${conflictDiffOpenId === popupEntry.id ? 'down' : 'right'} text-[8px]`}></i>
                      {conflictDiffOpenId === popupEntry.id ? "Hide" : "View"} {popupEntry.conflictPayload.differences.length} difference{popupEntry.conflictPayload.differences.length !== 1 ? "s" : ""}
                    </button>
                    {conflictDiffOpenId === popupEntry.id && (() => {
                      const rows = buildConflictComparison(popupEntry.conflictPayload.type, popupEntry.conflictPayload.existingConfig, popupEntry.conflictPayload.templateConfig);
                      return (
                        <div className="mt-2 border border-gh-border dark:border-slate-700 rounded-md overflow-hidden text-xs">
                          <table className="w-full">
                            <thead>
                              <tr className="bg-gray-50 dark:bg-slate-800 border-b border-gh-border dark:border-slate-700">
                                <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider">Setting</th>
                                <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-red-500 uppercase tracking-wider">Existing</th>
                                <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-green-600 dark:text-green-400 uppercase tracking-wider">Template</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gh-border dark:divide-slate-700">
                              {rows.map((r, ri) => (
                                <tr key={ri} className="hover:bg-amber-50/30 dark:hover:bg-amber-950/30">
                                  <td className="px-3 py-1.5 font-medium text-gh-textBase dark:text-slate-200">{r.label}</td>
                                  <td className="px-3 py-1.5 text-red-600 dark:text-red-400 bg-red-50/30 dark:bg-red-950/30 font-mono">{r.existing}</td>
                                  <td className="px-3 py-1.5 text-green-700 dark:text-green-400 bg-green-50/30 dark:bg-green-950/30 font-mono">{r.template}</td>
                                </tr>
                              ))}
                              {rows.length === 0 && (
                                <tr><td colSpan={3} className="px-3 py-2 text-gh-muted dark:text-slate-400 text-center">No structured differences found</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                    {!popupEntry.conflictResolution && (
                      <p className="text-[11px] text-gh-muted dark:text-slate-400 pt-2">
                        This conflict was never resolved, and can no longer be, the templates
                        feature that raised it has been removed. The repository still has the
                        configuration shown under &ldquo;Existing&rdquo;.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Diff viewer */}
              {popupEntry.diff && (
                <div>
                  <h4 className="text-sm font-semibold text-gh-textBase dark:text-slate-200 mb-2 border-b dark:border-slate-700 pb-2">Changes Made</h4>
                  <div className="space-y-3">
                    {Object.entries(popupEntry.diff).map(([key, changes]: [string, any]) => (
                      <div key={key} className="border border-gh-border dark:border-slate-700 rounded-md overflow-hidden">
                        <div className="bg-gray-50 dark:bg-slate-800 px-3 py-1.5 border-b border-gh-border dark:border-slate-700 text-xs font-mono font-semibold text-gray-600 dark:text-slate-400 uppercase tracking-wider">{key}</div>
                        <DiffViewer oldValue={changes.old} newValue={changes.new} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer with undo/redo/retry */}
            <div className="bg-gray-50 dark:bg-slate-800 px-6 py-3 flex items-center justify-between gap-3 border-t border-gh-border dark:border-slate-700 rounded-b-xl shrink-0">
              <div className="text-xs text-gh-muted dark:text-slate-400">
                {!popupCanUndo && !popupCanRedo && !popupCanRetry && !popupIsOverriddenConflict && !popupIsSkippedConflict && 'No actions available'}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setSelectedEvent(null)} className="px-4 py-2 border border-gh-border dark:border-slate-700 shadow-sm text-sm font-medium rounded-md text-gh-textBase dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700">
                  Close
                </button>
                {popupCanRetry && (
                  <button
                    onClick={() => handleRetryFromPopup(popupEntry)}
                    disabled={isBusy}
                    className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {retryMutation.isPending
                      ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>Retrying...</>
                      : <><i className="fa-solid fa-arrow-rotate-right text-xs"></i>{popupFailedCount > 1 ? `Retry All Failed (${popupFailedCount})` : 'Retry'}</>}
                  </button>
                )}
                {popupCanRedo && (
                  <button
                    onClick={() => handleRedoFromPopup(popupEntry)}
                    disabled={isBusy}
                    className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {redoMutation.isPending
                      ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>Redoing...</>
                      : <><i className="fa-solid fa-rotate-right text-xs"></i>{popupEntry.children && popupEntry.children.length > 0 ? 'Redo All' : 'Redo'}</>}
                  </button>
                )}
                {popupIsSkippedConflict && (
                  <button
                    onClick={() => handleUndoResolution(popupEntry)}
                    disabled={isBusy}
                    className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {undoResolutionMutation.isPending
                      ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>Undoing...</>
                      : <><i className="fa-solid fa-rotate-left text-xs"></i>Undo Skip</>}
                  </button>
                )}
                {popupIsOverriddenConflict && (
                  <>
                    <button
                      onClick={() => handleUndoResolution(popupEntry)}
                      disabled={isBusy}
                      className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {undoResolutionMutation.isPending
                        ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>Undoing...</>
                        : <><i className="fa-solid fa-rotate-left text-xs"></i>Undo Override</>}
                    </button>
                    <button
                      onClick={() => handleUndoFromPopup(popupEntry)}
                      disabled={isBusy}
                      className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {undoMutation.isPending
                        ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>Undoing...</>
                        : <><i className="fa-solid fa-trash text-xs"></i>Undo Event</>}
                    </button>
                  </>
                )}
                {popupCanUndo && (
                  <button
                    onClick={() => handleUndoFromPopup(popupEntry)}
                    disabled={isBusy}
                    className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {undoMutation.isPending
                      ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>Undoing...</>
                      : <><i className="fa-solid fa-rotate-left text-xs"></i>{popupEntry.children && popupEntry.children.length > 0 ? 'Undo All' : 'Undo'}</>}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SNACK */}
      {snack && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-slide-up">
          <div className={`flex items-center gap-3 px-5 py-3 rounded-lg shadow-lg border ${snack.severity === "success" ? "bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800 text-green-800 dark:text-green-400" : "bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800 text-red-800 dark:text-red-400"}`}>
            <i className={`fa-solid ${snack.severity === "success" ? "fa-check-circle" : "fa-exclamation-circle"} text-lg`}></i>
            <span className="text-sm font-medium">{snack.msg}</span>
            <button onClick={() => setSnack(null)} className="ml-2 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300"><i className="fa-solid fa-xmark"></i></button>
          </div>
        </div>
      )}
        </>
        )}
    </Page>
  );
}
