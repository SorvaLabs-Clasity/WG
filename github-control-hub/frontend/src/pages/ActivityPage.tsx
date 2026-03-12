import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Navbar from "../components/Navbar";
import DiffViewer from "../components/DiffViewer";
import UserAvatar from "../components/UserAvatar";
import { useAuth } from "../App";
import { useActivity, useUndoActivity, useRedoActivity, useRetryActivity, useResolveConflict, useUndoResolution } from "../hooks/useActivity";
import { useOrgConfig } from "../hooks/useOrgConfig";
import type { Activity, ActivityAction } from "../types/Activity";
import { buildConflictComparison } from "../api/templates";

const ACTION_CONFIG: Record<
  ActivityAction,
  { label: string; colorClass: string; iconClass: string }
> = {
  "branch.create": { label: "Branch Created", colorClass: "bg-green-50 text-green-700 border-green-200/60", iconClass: "fa-solid fa-plus text-[10px]" },
  "branch.delete": { label: "Branch Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-trash text-[10px]" },
  "branch.rename": { label: "Branch Renamed", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60", iconClass: "fa-solid fa-pen text-[10px]" },
  "branch.protect": { label: "Branch Protected", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60", iconClass: "fa-solid fa-shield text-[10px]" },
  "template.apply": { label: "Template Applied", colorClass: "bg-sky-50 text-sky-700 border-sky-200/60", iconClass: "fa-solid fa-play text-[10px]" },
  "template.apply.repo": { label: "Template \u2192 Repo", colorClass: "bg-sky-50 text-sky-700 border-sky-200/60", iconClass: "fa-solid fa-cube text-[10px]" },
  "template.create": { label: "Template Created", colorClass: "bg-purple-50 text-purple-700 border-purple-200/60", iconClass: "fa-solid fa-gear text-[10px]" },
  "template.update": { label: "Template Updated", colorClass: "bg-orange-50 text-orange-700 border-orange-200/60", iconClass: "fa-solid fa-pen text-[10px]" },
  "template.delete": { label: "Template Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-trash text-[10px]" },
  "exclusion.create": { label: "Exclusion List Created", colorClass: "bg-purple-50 text-purple-700 border-purple-200/60", iconClass: "fa-solid fa-ban text-[10px]" },
  "exclusion.update": { label: "Exclusion List Updated", colorClass: "bg-orange-50 text-orange-700 border-orange-200/60", iconClass: "fa-solid fa-pen text-[10px]" },
  "exclusion.delete": { label: "Exclusion List Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-trash text-[10px]" },
  "branch.unprotect": { label: "Branch Unprotected", colorClass: "bg-orange-50 text-orange-700 border-orange-200/60", iconClass: "fa-solid fa-shield-slash text-[10px]" },
  "repo.ruleset.create": { label: "Ruleset Created", colorClass: "bg-indigo-50 text-indigo-700 border-indigo-200/60", iconClass: "fa-solid fa-list-check text-[10px]" },
  "repo.ruleset.delete": { label: "Ruleset Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-trash text-[10px]" },
  "repo.ruleset.import": { label: "Ruleset Imported", colorClass: "bg-indigo-50 text-indigo-700 border-indigo-200/60", iconClass: "fa-solid fa-file-import text-[10px]" },
  "activity.undo": { label: "Action Undone", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60", iconClass: "fa-solid fa-rotate-left text-[10px]" },
  "activity.redo": { label: "Action Redone", colorClass: "bg-cyan-50 text-cyan-700 border-cyan-200/60", iconClass: "fa-solid fa-rotate-right text-[10px]" },
  "activity.retry": { label: "Action Retried", colorClass: "bg-violet-50 text-violet-700 border-violet-200/60", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "conflict.pending": { label: "Conflict — On Hold", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60", iconClass: "fa-solid fa-pause text-[10px]" },
  "conflict.override": { label: "Conflict Overridden", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-arrow-right-arrow-left text-[10px]" },
  "conflict.skip": { label: "Conflict Skipped", colorClass: "bg-gray-50 text-gray-600 border-gray-200/60", iconClass: "fa-solid fa-forward text-[10px]" },
  "github.push": { label: "Code Pushed", colorClass: "bg-teal-50 text-teal-700 border-teal-200/60", iconClass: "fa-solid fa-code-commit text-[10px]" },
  "github.pr_opened": { label: "PR Opened", colorClass: "bg-green-50 text-green-700 border-green-200/60", iconClass: "fa-solid fa-code-pull-request text-[10px]" },
  "github.pr_merged": { label: "PR Merged", colorClass: "bg-purple-50 text-purple-700 border-purple-200/60", iconClass: "fa-solid fa-code-merge text-[10px]" },
  "github.pr_closed": { label: "PR Closed", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-code-pull-request text-[10px]" },
  "github.issue_opened": { label: "Issue Opened", colorClass: "bg-green-50 text-green-700 border-green-200/60", iconClass: "fa-regular fa-circle-dot text-[10px]" },
  "repo.created": { label: "Repo Created", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60", iconClass: "fa-solid fa-repo text-[10px]" },
  "repo.publicized": { label: "Repo Made Public", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60", iconClass: "fa-solid fa-globe text-[10px]" },
  "github.branch_protection_edited": { label: "Protection Changed", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60", iconClass: "fa-solid fa-shield-halved text-[10px]" },
  "github.ruleset_edited": { label: "Ruleset Changed", colorClass: "bg-indigo-50 text-indigo-700 border-indigo-200/60", iconClass: "fa-solid fa-list-check text-[10px]" },
  "scanner.create": { label: "Scanner Created", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60", iconClass: "fa-solid fa-radar text-[10px]" },
  "scanner.update": { label: "Scanner Updated", colorClass: "bg-yellow-50 text-yellow-700 border-yellow-200/60", iconClass: "fa-solid fa-radar text-[10px]" },
  "scanner.delete": { label: "Scanner Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-radar text-[10px]" },
  "widget.create": { label: "Widget Created", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "widget.update": { label: "Widget Updated", colorClass: "bg-yellow-50 text-yellow-700 border-yellow-200/60", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "widget.delete": { label: "Widget Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "dependabot.enable": { label: "Dependabot Enabled", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60", iconClass: "fa-solid fa-bug text-[10px]" },
  "dependabot.disable": { label: "Dependabot Disabled", colorClass: "bg-red-50 text-red-700 border-red-200/60", iconClass: "fa-solid fa-bug-slash text-[10px]" },
  "audit.event": { label: "Audit Log", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60", iconClass: "fa-solid fa-clipboard-list text-[10px]" },
};

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

function canUndo(entry: Activity): boolean {
  if (isUndoRedoTracker(entry)) return false;
  if (entry.undone || entry.failed) return false;
  if (entry.undoPayload) return true;
  if (entry.children && entry.children.length > 0) return entry.children.some(c => canUndo(c));
  return false;
}

function canRedo(entry: Activity): boolean {
  if (isUndoRedoTracker(entry)) return false;
  if (!entry.undone) return false;
  if (entry.undoPayload) return true;
  if (entry.children && entry.children.length > 0) return entry.children.some(c => canRedo(c));
  return true;
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

function allChildrenUndone(entry: Activity): boolean {
  if (!entry.children || entry.children.length === 0) return entry.undone === true;
  return entry.children.every(c => allChildrenUndone(c));
}

export default function ActivityPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useActivity(100);
  const { data: orgConfig } = useOrgConfig();
  const undoMutation = useUndoActivity();
  const redoMutation = useRedoActivity();
  const retryMutation = useRetryActivity();
  const resolveConflictMutation = useResolveConflict();
  const undoResolutionMutation = useUndoResolution();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "app" | "github">("all");
  const [repoFilter, setRepoFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<Activity | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);
  const [conflictDiffOpenId, setConflictDiffOpenId] = useState<string | null>(null);
  const [perPage, setPerPage] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isBusy = undoMutation.isPending || redoMutation.isPending || retryMutation.isPending || resolveConflictMutation.isPending || undoResolutionMutation.isPending;

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
        setSnack({ msg: `Undone ${result.undone.length} action${result.undone.length !== 1 ? 's' : ''}`, severity: result.errors.length > 0 ? "error" : "success" });
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
        setSnack({ msg: `Resolution undone for "${entry.target}" — conflict is back on hold`, severity: "success" });
        setSelectedEvent(null);
      },
      onError: (err) => { setSnack({ msg: (err as Error).message, severity: "error" }); },
    });
  }, [undoResolutionMutation]);

  const handleResolveConflictFromPopup = useCallback((entry: Activity, resolution: "override" | "skip") => {
    resolveConflictMutation.mutate(
      { activityId: entry.id, resolution },
      {
        onSuccess: () => {
          setSnack({ msg: `Conflict ${resolution === "override" ? "overridden" : "skipped"} for "${entry.target}"`, severity: "success" });
          setSelectedEvent(null);
        },
        onError: (err) => { setSnack({ msg: (err as Error).message, severity: "error" }); },
      }
    );
  }, [resolveConflictMutation]);

  const filtered = useMemo(() => {
    if (!data?.entries) return [];
    let entries = data.entries;
    if (sourceFilter !== "all") entries = entries.filter((e) => e.source === sourceFilter);
    if (repoFilter) { const q = repoFilter.toLowerCase(); entries = entries.filter((e) => e.repo.toLowerCase().includes(q)); }
    if (targetFilter) { const q = targetFilter.toLowerCase(); entries = entries.filter((e) => e.target.toLowerCase().includes(q) || (e.prNumber && e.prNumber.toString() === q) || (e.commitSha && e.commitSha.toLowerCase().includes(q))); }
    if (search) { const q = search.toLowerCase(); entries = entries.filter((e) => e.actor.toLowerCase().includes(q) || e.action.toLowerCase().includes(q) || (e.details && e.details.toLowerCase().includes(q))); }
    return entries;
  }, [data, search, sourceFilter, repoFilter, targetFilter]);

  const totalTopLevel = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalTopLevel / perPage));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * perPage;
  const paginatedEntries = filtered.slice(pageStart, pageStart + perPage);

  useEffect(() => { setCurrentPage(1); }, [search, sourceFilter, repoFilter, targetFilter, perPage]);

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
          setSourceFilter("all");
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

    const targetPage = Math.floor(topIdx / perPage) + 1;

    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < path!.length - 1; i++) next.add(path![i]);
      return next;
    });

    setCurrentPage(targetPage);
    setSelectedEvent(null);
    setHighlightedId(targetId);
  }, [filtered, data, perPage]);

  const renderRow = (entry: Activity, depth: number) => {
    const cfg = ACTION_CONFIG[entry.action as ActivityAction] || { label: entry.action, colorClass: "bg-gray-50", iconClass: "fa-solid fa-circle" };
    const hasChildren = entry.children && entry.children.length > 0;
    const isExpanded = expandedIds.has(entry.id);
    const isUndoneEntry = entry.undone === true;
    const isFailedEntry = entry.failed === true;
    const allDone = hasChildren && allChildrenUndone(entry);
    const dimmed = isUndoneEntry || allDone;
    const failedCount = hasChildren ? countFailed(entry) : 0;

    const rows: React.ReactElement[] = [];

    const isHighlighted = highlightedId === entry.id;
    rows.push(
      <tr
        key={entry.id}
        data-activity-id={entry.id}
        className={`transition-all group cursor-pointer hover:bg-gray-50 ${dimmed ? 'opacity-50' : ''} ${isFailedEntry ? 'bg-red-50/40' : ''} ${isHighlighted ? 'ring-2 ring-inset ring-gh-blue bg-blue-50/60 animate-pulse-once' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('[data-expand-btn]')) return;
          setSelectedEvent(entry);
        }}
      >
        <td className="px-3 py-3 whitespace-nowrap text-center" style={{ paddingLeft: `${12 + depth * 24}px` }}>
          <div className="flex items-center gap-2">
            {depth > 0 && <span className="text-gray-300 text-xs select-none"><i className="fa-solid fa-turn-up fa-rotate-90"></i></span>}
            {hasChildren ? (
              <button data-expand-btn onClick={(e) => { e.stopPropagation(); toggleExpanded(entry.id); }} className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 transition-colors text-gray-500">
                <i className={`fa-solid fa-chevron-${isExpanded ? 'down' : 'right'} text-[10px]`}></i>
              </button>
            ) : <span className="w-5 inline-block" />}
            {isFailedEntry
              ? <i className="fa-solid fa-circle-exclamation text-base text-red-500" title="Failed"></i>
              : entry.source === "github"
                ? <i className="fa-brands fa-github text-base text-gh-textBase" title="Native GitHub Event"></i>
                : <i className="fa-solid fa-shield-halved text-base text-gh-blue" title="Control Hub App Event"></i>}
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${isFailedEntry ? 'bg-red-50 text-red-700 border-red-200/60' : cfg.colorClass} ${isUndoneEntry ? 'line-through' : ''}`}>
              <i className={isFailedEntry ? 'fa-solid fa-xmark text-[10px]' : cfg.iconClass}></i>
              {isFailedEntry ? `${cfg.label} (Failed)` : cfg.label}
            </span>
            {isUndoneEntry && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200 font-medium">Undone</span>}
            {entry.action === "conflict.pending" && !entry.conflictResolution && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 font-semibold animate-pulse">On Hold</span>
            )}
            {entry.conflictResolution === "override" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 font-medium">Overridden</span>
            )}
            {entry.conflictResolution === "skip" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200 font-medium">Skipped</span>
            )}
            {hasChildren && !isExpanded && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200 font-medium">
                  {countAllChildren(entry)} sub-action{countAllChildren(entry) !== 1 ? 's' : ''}
                </span>
                {failedCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 border border-red-200 font-medium">
                    {failedCount} failed
                  </span>
                )}
              </div>
            )}
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex items-center gap-2">
            <UserAvatar login={entry.actor} size={24} />
            <span className="text-sm font-medium text-gh-textBase">{entry.actor}</span>
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${entry.repo === '*' ? 'bg-gray-600 text-white border-gray-700' : 'bg-gray-100 text-gray-700 border-gray-200'}`}>
            {entry.repo === '*' ? '* (Global)' : entry.repo}
          </span>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <span className="font-mono text-xs text-gh-textBase bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200/50">
            {entry.action.includes('branch') && <i className="fa-solid fa-code-branch text-[10px] text-gray-400 mr-1"></i>}
            {entry.target}
          </span>
        </td>
        <td className="px-4 py-3 whitespace-nowrap hidden lg:table-cell">
          <span className={`text-sm truncate block max-w-xs ${isFailedEntry ? 'text-red-600' : 'text-gh-muted'}`} title={entry.details}>{entry.details || "\u2014"}</span>
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-right">
          <div className="flex items-center justify-end gap-2">
            <span className="text-sm text-gh-muted" title={entry.timestamp}>{formatTimestamp(entry.timestamp)}</span>
            {isFailedEntry && <span className="w-2 h-2 rounded-full bg-red-500" title="Failed - click to manage"></span>}
            {!isFailedEntry && (canUndo(entry) || canRedo(entry)) && (
              <span className={`w-2 h-2 rounded-full ${isUndoneEntry || allDone ? 'bg-orange-400' : 'bg-green-400'}`} title="Click to manage"></span>
            )}
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
  const popupCfg = popupEntry ? (ACTION_CONFIG[popupEntry.action as ActivityAction] || { label: popupEntry.action, colorClass: "bg-gray-50", iconClass: "fa-solid fa-circle" }) : null;
  const popupChildCount = popupEntry ? countAllChildren(popupEntry) : 0;
  const popupFailedCount = popupEntry ? countFailed(popupEntry) : 0;
  const popupIsTracker = popupEntry ? isUndoRedoTracker(popupEntry) : false;
  const popupOriginal = popupIsTracker && popupEntry?.linkedActivityId
    ? findActivityById(data?.entries || [], popupEntry.linkedActivityId)
    : undefined;
  const popupOriginalCfg = popupOriginal ? (ACTION_CONFIG[popupOriginal.action as ActivityAction] || { label: popupOriginal.action, colorClass: "bg-gray-50", iconClass: "fa-solid fa-circle" }) : null;
  const popupIsOverriddenConflict = popupEntry?.action === "conflict.pending" && popupEntry.conflictResolution === "override" && !popupEntry.undone;
  const popupIsSkippedConflict = popupEntry?.action === "conflict.pending" && popupEntry.conflictResolution === "skip" && !popupEntry.undone;
  const popupCanUndo = popupEntry ? (!popupIsOverriddenConflict && canUndo(popupEntry)) : false;
  const popupCanRedo = popupEntry ? canRedo(popupEntry) : false;
  const popupCanRetry = popupEntry ? canRetry(popupEntry) : false;

  return (
    <div className="bg-gh-bg text-gh-text font-sans antialiased min-h-screen flex flex-col pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-8 animate-fade-in">
        <header className="flex flex-col mb-6 space-y-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gh-textBase">Activity Log</h1>
            <p className="text-sm text-gh-muted mt-1">Global audit trail of all organization events and security changes.</p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-gh-border shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <i className="fa-solid fa-filter text-gh-muted text-sm"></i>
              <span className="text-sm font-semibold text-gh-textBase">Advanced Filters</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Source</label>
                <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as any)} className="w-full text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none">
                  <option value="all">All Sources</option>
                  <option value="app">Control Hub App</option>
                  {orgConfig?.features?.auditLogs && <option value="github">Native GitHub</option>}
                </select>
                {!orgConfig?.features?.auditLogs && <span className="text-[10px] text-orange-600 flex items-center gap-1 mt-1"><i className="ph-fill ph-warning-circle"></i>Native GitHub events require Enterprise Audit Logs.</span>}
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Repository</label>
                <input type="text" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} placeholder="e.g. web-platform" className="w-full text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Target (Branch/PR)</label>
                <input type="text" value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)} placeholder="e.g. main or 42" className="w-full text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Search Details</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none text-gray-400"><i className="fa-solid fa-magnifying-glass text-[11px]"></i></div>
                  <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="User, action, details..." className="w-full pl-7 pr-3 py-1.5 text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue outline-none" />
                </div>
              </div>
            </div>
            {(sourceFilter !== 'all' || repoFilter || targetFilter || search) && (
              <div className="mt-3 flex justify-end">
                <button onClick={() => { setSourceFilter('all'); setRepoFilter(''); setTargetFilter(''); setSearch(''); }} className="text-[11px] font-medium text-gh-muted hover:text-gh-blue">Clear Filters</button>
              </div>
            )}
          </div>
        </header>

        {isLoading && <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div></div>}
        {error && <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md mb-6"><p className="text-red-700">Failed to load activity: {(error as Error).message}</p></div>}

        {!isLoading && !error && (
          <div className="bg-white rounded-lg border border-gh-border shadow-subtle overflow-hidden relative">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-gray-50 border-b border-gh-border">
                  <tr>
                    <th className="px-3 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider w-32">Source</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider w-52">Action</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider">User</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider">Repository</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider">Target</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider hidden lg:table-cell">Details</th>
                    <th className="px-4 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gh-border">
                  {paginatedEntries.map((entry) => renderRow(entry, 0)).flat()}
                  {paginatedEntries.length === 0 && <tr><td colSpan={7} className="px-6 py-8 text-center text-gh-muted">No activity found</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 border-t border-gh-border bg-gray-50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs text-gh-muted">
                  Showing <strong>{pageStart + 1}</strong>–<strong>{Math.min(pageStart + perPage, totalTopLevel)}</strong> of <strong>{totalTopLevel}</strong> events
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-gh-muted">Per page:</span>
                  <select
                    value={perPage}
                    onChange={(e) => setPerPage(Number(e.target.value))}
                    className="text-xs bg-white border border-gh-border rounded px-1.5 py-0.5 outline-none focus:border-gh-blue"
                  >
                    {[25, 50, 100, 200].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={safePage <= 1}
                  className="px-2 py-1 text-xs font-medium text-gh-muted border border-gh-border rounded bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                  title="First page"
                ><i className="fa-solid fa-angles-left text-[10px]"></i></button>
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="px-3 py-1 text-xs font-medium text-gh-muted border border-gh-border rounded bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                >Previous</button>
                {(() => {
                  const pages: number[] = [];
                  const start = Math.max(1, safePage - 2);
                  const end = Math.min(totalPages, safePage + 2);
                  for (let i = start; i <= end; i++) pages.push(i);
                  return pages.map((p) => (
                    <button
                      key={p}
                      onClick={() => setCurrentPage(p)}
                      className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors ${p === safePage ? 'bg-gh-blue text-white border-gh-blue' : 'text-gh-muted border-gh-border bg-white hover:bg-gray-100'}`}
                    >{p}</button>
                  ));
                })()}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="px-3 py-1 text-xs font-medium text-gh-muted border border-gh-border rounded bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                >Next</button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={safePage >= totalPages}
                  className="px-2 py-1 text-xs font-medium text-gh-muted border border-gh-border rounded bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                  title="Last page"
                ><i className="fa-solid fa-angles-right text-[10px]"></i></button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* EVENT DETAIL / UNDO-REDO-RETRY POPUP */}
      {popupEntry && popupCfg && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setSelectedEvent(null)}></div>
          <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-lg relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gh-border flex justify-between items-start rounded-t-xl">
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${popupEntry.failed ? 'bg-red-50 text-red-600 border-red-200' : popupCfg.colorClass}`}>
                  <i className={popupEntry.failed ? 'fa-solid fa-circle-exclamation text-sm' : popupCfg.iconClass.replace('text-[10px]', 'text-sm')}></i>
                </div>
                <div>
                  <h3 className="text-base font-bold text-gh-textBase">{popupEntry.failed ? `${popupCfg.label} (Failed)` : popupCfg.label}</h3>
                  <p className="text-xs text-gh-muted mt-0.5">{formatTimestamp(popupEntry.timestamp)} &middot; {new Date(popupEntry.timestamp).toLocaleString()}</p>
                </div>
              </div>
              <button onClick={() => setSelectedEvent(null)} className="text-gray-400 hover:text-gray-600 transition-colors mt-1">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-4 overflow-y-auto space-y-4">
              {/* Failed banner */}
              {popupEntry.failed && (
                <div className="px-3 py-2.5 bg-red-50 rounded-lg border border-red-200">
                  <div className="flex items-start gap-2">
                    <i className="fa-solid fa-circle-exclamation text-red-500 text-sm mt-0.5"></i>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-red-700">This action failed</p>
                      {popupEntry.errorMessage && (
                        <pre className="mt-1.5 text-xs text-red-600 bg-red-100/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono border border-red-200/50">{popupEntry.errorMessage}</pre>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Parent has failed children banner */}
              {!popupEntry.failed && popupFailedCount > 0 && (
                <div className="px-3 py-2 bg-orange-50 rounded-lg border border-orange-200 flex items-center gap-2">
                  <i className="fa-solid fa-triangle-exclamation text-orange-500 text-sm"></i>
                  <span className="text-sm text-orange-700 font-medium">{popupFailedCount} sub-action{popupFailedCount !== 1 ? 's' : ''} failed</span>
                </div>
              )}

              {/* Undone banner */}
              {popupEntry.undone && (
                <div className="flex items-center gap-2 px-3 py-2 bg-orange-50 rounded-lg border border-orange-200">
                  <i className="fa-solid fa-rotate-left text-orange-500 text-sm"></i>
                  <span className="text-sm text-orange-700 font-medium">This action has been undone</span>
                  {popupEntry.undoneAt && <span className="text-xs text-orange-500 ml-auto">{formatTimestamp(popupEntry.undoneAt)}</span>}
                </div>
              )}

              {/* Original action card for undo/redo tracker entries */}
              {popupIsTracker && popupOriginal && popupOriginalCfg && (
                <div className="border border-gh-border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-3 py-2 border-b border-gh-border flex items-center gap-2">
                    <i className="fa-solid fa-link text-gray-400 text-[10px]"></i>
                    <span className="text-xs font-semibold text-gh-muted uppercase tracking-wider">Original Action</span>
                  </div>
                  <div className="px-4 py-3 space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${popupOriginal.undone ? 'line-through opacity-60' : ''} ${popupOriginalCfg.colorClass}`}>
                        <i className={popupOriginalCfg.iconClass}></i>
                        {popupOriginalCfg.label}
                      </span>
                      {popupOriginal.undone && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-600 border border-orange-200 font-medium">Undone</span>}
                      {!popupOriginal.undone && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 border border-green-200 font-medium">Active</span>}
                    </div>
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                      <span className="text-gh-muted text-xs">Repo</span>
                      <span className="font-mono text-xs text-gh-textBase">{popupOriginal.repo === '*' ? '* (Global)' : popupOriginal.repo}</span>
                      <span className="text-gh-muted text-xs">Target</span>
                      <span className="font-mono text-xs text-gh-textBase">{popupOriginal.target}</span>
                      {popupOriginal.details && (
                        <>
                          <span className="text-gh-muted text-xs">Details</span>
                          <span className="text-xs text-gh-textBase break-words">{popupOriginal.details}</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t border-gh-border/50">
                      <button
                        onClick={() => navigateToActivity(popupOriginal.id)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-gh-border text-gh-textBase bg-white hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                      >
                        <i className="fa-solid fa-location-arrow text-[10px] text-gray-400"></i>
                        Go to Original Event
                      </button>
                      {canRedo(popupOriginal) && (
                        <button
                          onClick={() => handleRedoFromPopup(popupOriginal)}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                        >
                          <i className="fa-solid fa-rotate-right text-[10px]"></i>
                          Redo
                        </button>
                      )}
                      {canUndo(popupOriginal) && (
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
                <div className="px-3 py-2.5 bg-gray-50 rounded-lg border border-gh-border flex items-center gap-2">
                  <i className="fa-solid fa-link-slash text-gray-400 text-sm"></i>
                  <span className="text-sm text-gh-muted">Original event is not in the current view. It may be on another page or nested in a template run.</span>
                </div>
              )}

              {/* Details grid */}
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <span className="text-gh-muted font-medium">User</span>
                <div className="flex items-center gap-2">
                  <UserAvatar login={popupEntry.actor} size={20} />
                  <span className="font-medium text-gh-textBase">{popupEntry.actor}</span>
                </div>
                <span className="text-gh-muted font-medium">Repository</span>
                <span className="font-mono text-xs bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 w-fit">{popupEntry.repo === '*' ? '* (Global)' : popupEntry.repo}</span>
                <span className="text-gh-muted font-medium">Target</span>
                <span className="font-mono text-xs bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 w-fit">{popupEntry.target}</span>
                {popupEntry.details && (
                  <>
                    <span className="text-gh-muted font-medium">Details</span>
                    <span className="text-gh-textBase break-words">{popupEntry.details}</span>
                  </>
                )}
                <span className="text-gh-muted font-medium">Source</span>
                <span className="text-gh-textBase">{popupEntry.source === 'github' ? 'Native GitHub Event' : popupEntry.source === 'audit' ? 'Audit Log' : 'Control Hub App'}</span>
              </div>

              {/* Children summary */}
              {popupEntry.children && popupEntry.children.length > 0 && (
                <div className="border border-gh-border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-3 py-2 border-b border-gh-border text-xs font-semibold text-gh-muted uppercase tracking-wider">
                    Sub-actions ({popupChildCount})
                    {popupFailedCount > 0 && <span className="ml-2 text-red-500 normal-case">&middot; {popupFailedCount} failed</span>}
                  </div>
                  <div className="divide-y divide-gh-border max-h-48 overflow-y-auto">
                    {popupEntry.children.map(child => {
                      const childCfg = ACTION_CONFIG[child.action as ActivityAction] || { label: child.action, colorClass: "bg-gray-50", iconClass: "fa-solid fa-circle" };
                      const childFailed = child.failed;
                      const childFailedCount = countFailed(child);
                      return (
                        <div
                          key={child.id}
                          className={`px-3 py-2 flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 transition-colors ${child.undone ? 'opacity-50' : ''} ${childFailed ? 'bg-red-50/30' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setSelectedEvent(child); }}
                        >
                          {childFailed
                            ? <i className="fa-solid fa-circle-exclamation text-red-500 text-[11px]"></i>
                            : child.undone
                              ? <i className="fa-solid fa-rotate-left text-orange-400 text-[11px]"></i>
                              : child.action === "conflict.pending" && !child.conflictResolution
                                ? <i className="fa-solid fa-pause text-amber-500 text-[11px]"></i>
                                : <i className="fa-solid fa-check-circle text-green-500 text-[11px]"></i>}
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${childFailed ? 'bg-red-50 text-red-700 border-red-200' : childCfg.colorClass} ${child.undone ? 'line-through' : ''}`}>
                            <i className={childFailed ? 'fa-solid fa-xmark text-[9px]' : childCfg.iconClass}></i>
                            {childCfg.label}
                          </span>
                          <span className="font-mono text-xs text-gray-500">{child.repo !== '*' && child.repo !== popupEntry.repo ? child.repo : ''}</span>
                          <span className="font-mono text-xs text-gh-textBase">{child.target}</span>
                          {childFailed && child.errorMessage && (
                            <span className="text-[10px] text-red-500 ml-auto truncate max-w-[120px]" title={child.errorMessage}>{child.errorMessage}</span>
                          )}
                          {!childFailed && childFailedCount > 0 && (
                            <span className="text-[10px] text-red-500 ml-auto">{childFailedCount} failed</span>
                          )}
                          {child.undone && !childFailed && <span className="text-[10px] text-orange-500 ml-auto">undone</span>}
                          {child.action === "conflict.pending" && !child.conflictResolution && !childFailed && (
                            <span className="flex items-center gap-1.5 ml-auto shrink-0">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 font-semibold">On Hold</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleResolveConflictFromPopup(child, "skip"); }}
                                disabled={isBusy}
                                className="text-[10px] px-2 py-0.5 rounded border border-gh-border text-gh-textSecondary bg-white hover:bg-gray-50 disabled:opacity-50 font-medium"
                              >Skip</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleResolveConflictFromPopup(child, "override"); }}
                                disabled={isBusy}
                                className="text-[10px] px-2 py-0.5 rounded border border-transparent text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 font-medium"
                              >Override</button>
                            </span>
                          )}
                          {child.conflictResolution === "override" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 font-medium ml-auto">Overridden</span>
                          )}
                          {child.conflictResolution === "skip" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200 font-medium ml-auto">Skipped</span>
                          )}
                          {child.children && child.children.length > 0 && !childFailed && childFailedCount === 0 && (
                            <span className="text-[10px] text-gray-400 ml-auto">+{countAllChildren(child)} sub</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Conflict details + resolve buttons */}
              {popupEntry.conflictPayload && (
                <div className="border border-amber-200 rounded-lg overflow-hidden">
                  <div className="bg-amber-50 px-3 py-2 border-b border-amber-200 flex items-center gap-2">
                    <i className="fa-solid fa-triangle-exclamation text-amber-600 text-xs"></i>
                    <span className="text-xs font-semibold text-amber-800">
                      {popupEntry.conflictResolution
                        ? `Resolved: ${popupEntry.conflictResolution === "override" ? "Overridden" : "Skipped"}`
                        : "Conflict — Awaiting Resolution"}
                    </span>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${popupEntry.conflictPayload.type === "ruleset" ? "bg-blue-50 text-blue-700 border border-blue-200/60" : "bg-purple-50 text-purple-700 border border-purple-200/60"}`}>
                        {popupEntry.conflictPayload.type}
                      </span>
                      <span className="text-sm font-medium text-gh-textBase">{popupEntry.conflictPayload.name}</span>
                      <span className="text-xs text-gh-muted">in {popupEntry.conflictPayload.repo}</span>
                    </div>
                    <button
                      className="text-[11px] font-medium text-gh-blue hover:text-gh-blueHover mt-0.5 flex items-center gap-1"
                      onClick={() => setConflictDiffOpenId(prev => prev === popupEntry.id ? null : popupEntry.id)}
                    >
                      <i className={`fa-solid fa-chevron-${conflictDiffOpenId === popupEntry.id ? 'down' : 'right'} text-[8px]`}></i>
                      {conflictDiffOpenId === popupEntry.id ? "Hide" : "View"} {popupEntry.conflictPayload.differences.length} difference{popupEntry.conflictPayload.differences.length !== 1 ? "s" : ""}
                    </button>
                    {conflictDiffOpenId === popupEntry.id && (() => {
                      const rows = buildConflictComparison(popupEntry.conflictPayload.type, popupEntry.conflictPayload.existingConfig, popupEntry.conflictPayload.templateConfig);
                      return (
                        <div className="mt-2 border border-gh-border rounded-md overflow-hidden text-xs">
                          <table className="w-full">
                            <thead>
                              <tr className="bg-gray-50 border-b border-gh-border">
                                <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-gh-muted uppercase tracking-wider">Setting</th>
                                <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-red-500 uppercase tracking-wider">Existing</th>
                                <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-green-600 uppercase tracking-wider">Template</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gh-border">
                              {rows.map((r, ri) => (
                                <tr key={ri} className="hover:bg-amber-50/30">
                                  <td className="px-3 py-1.5 font-medium text-gh-textBase">{r.label}</td>
                                  <td className="px-3 py-1.5 text-red-600 bg-red-50/30 font-mono">{r.existing}</td>
                                  <td className="px-3 py-1.5 text-green-700 bg-green-50/30 font-mono">{r.template}</td>
                                </tr>
                              ))}
                              {rows.length === 0 && (
                                <tr><td colSpan={3} className="px-3 py-2 text-gh-muted text-center">No structured differences found</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                    {!popupEntry.conflictResolution && (
                      <div className="flex items-center gap-2 pt-2">
                        <button
                          onClick={() => handleResolveConflictFromPopup(popupEntry, "skip")}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-gh-border text-gh-textSecondary bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          Skip
                        </button>
                        <button
                          onClick={() => handleResolveConflictFromPopup(popupEntry, "override")}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
                        >
                          {resolveConflictMutation.isPending ? "Resolving..." : "Override"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Diff viewer */}
              {popupEntry.diff && (
                <div>
                  <h4 className="text-sm font-semibold text-gh-textBase mb-2 border-b pb-2">Changes Made</h4>
                  <div className="space-y-3">
                    {Object.entries(popupEntry.diff).map(([key, changes]: [string, any]) => (
                      <div key={key} className="border border-gh-border rounded-md overflow-hidden">
                        <div className="bg-gray-50 px-3 py-1.5 border-b border-gh-border text-xs font-mono font-semibold text-gray-600 uppercase tracking-wider">{key}</div>
                        <DiffViewer oldValue={changes.old} newValue={changes.new} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer with undo/redo/retry */}
            <div className="bg-gray-50 px-6 py-3 flex items-center justify-between gap-3 border-t border-gh-border rounded-b-xl shrink-0">
              <div className="text-xs text-gh-muted">
                {!popupCanUndo && !popupCanRedo && !popupCanRetry && !popupIsOverriddenConflict && !popupIsSkippedConflict && 'No actions available'}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setSelectedEvent(null)} className="px-4 py-2 border border-gh-border shadow-sm text-sm font-medium rounded-md text-gh-textBase bg-white hover:bg-gray-50">
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
          <div className={`flex items-center gap-3 px-5 py-3 rounded-lg shadow-lg border ${snack.severity === "success" ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}>
            <i className={`fa-solid ${snack.severity === "success" ? "fa-check-circle" : "fa-exclamation-circle"} text-lg`}></i>
            <span className="text-sm font-medium">{snack.msg}</span>
            <button onClick={() => setSnack(null)} className="ml-2 text-gray-400 hover:text-gray-600"><i className="fa-solid fa-xmark"></i></button>
          </div>
        </div>
      )}
    </div>
  );
}
