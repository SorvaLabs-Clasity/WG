import type { ActivityAction } from "../types/Activity";
import { importantLabel } from "./importantEvents";

/**
 * What each action is called, and how it is drawn.
 *
 * Lived inside ActivityPage, which meant anything else wanting to name an
 * action invented its own answer. The Statistics view did exactly that,
 * stripping the prefix and title-casing the rest, and produced a list reading
 * "Create 49, Updated 40, Protect 34, Update 34, Apply 21, Apply repo 21",
 * words that are not the names of anything, with two different actions
 * collapsing onto the same one.
 *
 * One map, so a thing has one name wherever it is shown.
 */
export const ACTION_CONFIG: Record<
  ActivityAction,
  { label: string; colorClass: string; iconClass: string }
> = {
  "security.alert": { label: "Security Alert", colorClass: "bg-rose-50 text-rose-700 border-rose-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-shield-exclamation text-[10px]" },
  "repo.deleted": { label: "Repo Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-trash text-[10px]" },
  "repo.renamed": { label: "Repo Renamed", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800", iconClass: "fa-solid fa-pen text-[10px]" },
  "tag.create": { label: "Tag Created", colorClass: "bg-green-50 text-green-700 border-green-200/60 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800", iconClass: "fa-solid fa-tag text-[10px]" },
  "tag.delete": { label: "Tag Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-tag text-[10px]" },
  "branch.create": { label: "Branch Created", colorClass: "bg-green-50 text-green-700 border-green-200/60 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800", iconClass: "fa-solid fa-plus text-[10px]" },
  "branch.delete": { label: "Branch Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-trash text-[10px]" },
  "branch.rename": { label: "Branch Renamed", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800", iconClass: "fa-solid fa-pen text-[10px]" },
  "branch.protect": { label: "Branch Protected", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800", iconClass: "fa-solid fa-shield text-[10px]" },
  "template.apply": { label: "Template Applied", colorClass: "bg-sky-50 text-sky-700 border-sky-200/60 dark:bg-sky-950/50 dark:text-sky-400 dark:border-sky-800", iconClass: "fa-solid fa-play text-[10px]" },
  "template.apply.repo": { label: "Template \u2192 Repo", colorClass: "bg-sky-50 text-sky-700 border-sky-200/60 dark:bg-sky-950/50 dark:text-sky-400 dark:border-sky-800", iconClass: "fa-solid fa-cube text-[10px]" },
  "template.create": { label: "Template Created", colorClass: "bg-purple-50 text-purple-700 border-purple-200/60 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-800", iconClass: "fa-solid fa-gear text-[10px]" },
  "template.update": { label: "Template Updated", colorClass: "bg-orange-50 text-orange-700 border-orange-200/60 dark:bg-orange-950/50 dark:text-orange-400 dark:border-orange-800", iconClass: "fa-solid fa-pen text-[10px]" },
  "template.delete": { label: "Template Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-trash text-[10px]" },
  "exclusion.create": { label: "Exclusion List Created", colorClass: "bg-purple-50 text-purple-700 border-purple-200/60 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-800", iconClass: "fa-solid fa-ban text-[10px]" },
  "exclusion.update": { label: "Exclusion List Updated", colorClass: "bg-orange-50 text-orange-700 border-orange-200/60 dark:bg-orange-950/50 dark:text-orange-400 dark:border-orange-800", iconClass: "fa-solid fa-pen text-[10px]" },
  "exclusion.delete": { label: "Exclusion List Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-trash text-[10px]" },
  "branch.unprotect": { label: "Branch Unprotected", colorClass: "bg-orange-50 text-orange-700 border-orange-200/60 dark:bg-orange-950/50 dark:text-orange-400 dark:border-orange-800", iconClass: "fa-solid fa-shield-slash text-[10px]" },
  "repo.ruleset.create": { label: "Ruleset Created", colorClass: "bg-indigo-50 text-indigo-700 border-indigo-200/60 dark:bg-indigo-950/50 dark:text-indigo-400 dark:border-indigo-800", iconClass: "fa-solid fa-list-check text-[10px]" },
  "repo.ruleset.delete": { label: "Ruleset Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-trash text-[10px]" },
  "repo.ruleset.import": { label: "Ruleset Imported", colorClass: "bg-indigo-50 text-indigo-700 border-indigo-200/60 dark:bg-indigo-950/50 dark:text-indigo-400 dark:border-indigo-800", iconClass: "fa-solid fa-file-import text-[10px]" },
  "activity.undo": { label: "Action Undone", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800", iconClass: "fa-solid fa-rotate-left text-[10px]" },
  "activity.redo": { label: "Action Redone", colorClass: "bg-cyan-50 text-cyan-700 border-cyan-200/60 dark:bg-cyan-950/50 dark:text-cyan-400 dark:border-cyan-800", iconClass: "fa-solid fa-rotate-right text-[10px]" },
  "activity.retry": { label: "Action Retried", colorClass: "bg-violet-50 text-violet-700 border-violet-200/60 dark:bg-violet-950/50 dark:text-violet-400 dark:border-violet-800", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "conflict.pending": { label: "Conflict. On Hold", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800", iconClass: "fa-solid fa-pause text-[10px]" },
  "conflict.override": { label: "Conflict Overridden", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-arrow-right-arrow-left text-[10px]" },
  "conflict.skip": { label: "Conflict Skipped", colorClass: "bg-gray-50 text-gray-600 border-gray-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-forward text-[10px]" },
  "github.push": { label: "Code Pushed", colorClass: "bg-teal-50 text-teal-700 border-teal-200/60 dark:bg-teal-950/50 dark:text-teal-400 dark:border-teal-800", iconClass: "fa-solid fa-code-commit text-[10px]" },
  "github.pr_opened": { label: "PR Opened", colorClass: "bg-green-50 text-green-700 border-green-200/60 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800", iconClass: "fa-solid fa-code-pull-request text-[10px]" },
  "github.pr_merged": { label: "PR Merged", colorClass: "bg-purple-50 text-purple-700 border-purple-200/60 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-800", iconClass: "fa-solid fa-code-merge text-[10px]" },
  "github.pr_closed": { label: "PR Closed", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-code-pull-request text-[10px]" },
  "github.issue_opened": { label: "Issue Opened", colorClass: "bg-green-50 text-green-700 border-green-200/60 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800", iconClass: "fa-regular fa-circle-dot text-[10px]" },
  "repo.created": { label: "Repo Created", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800", iconClass: "fa-solid fa-repo text-[10px]" },
  "repo.publicized": { label: "Repo Made Public", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800", iconClass: "fa-solid fa-globe text-[10px]" },
  "github.branch_protection_edited": { label: "Protection Changed", colorClass: "bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800", iconClass: "fa-solid fa-shield-halved text-[10px]" },
  "github.ruleset_edited": { label: "Ruleset Changed", colorClass: "bg-indigo-50 text-indigo-700 border-indigo-200/60 dark:bg-indigo-950/50 dark:text-indigo-400 dark:border-indigo-800", iconClass: "fa-solid fa-list-check text-[10px]" },
  "config.import": { label: "Configuration Imported", colorClass: "bg-sky-50 text-sky-700 border-sky-200/60 dark:bg-sky-950/50 dark:text-sky-400 dark:border-sky-800", iconClass: "fa-solid fa-file-import text-[10px]" },
  "scanner.create": { label: "Scanner Created", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800", iconClass: "fa-solid fa-radar text-[10px]" },
  "scanner.update": { label: "Scanner Updated", colorClass: "bg-yellow-50 text-yellow-700 border-yellow-200/60 dark:bg-yellow-950/50 dark:text-yellow-400 dark:border-yellow-800", iconClass: "fa-solid fa-radar text-[10px]" },
  "scanner.delete": { label: "Scanner Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-radar text-[10px]" },
  "widget.create": { label: "Widget Created", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "widget.update": { label: "Widget Updated", colorClass: "bg-yellow-50 text-yellow-700 border-yellow-200/60 dark:bg-yellow-950/50 dark:text-yellow-400 dark:border-yellow-800", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "widget.delete": { label: "Widget Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "dependabot.enable": { label: "Dependabot Enabled", colorClass: "bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800", iconClass: "fa-solid fa-bug text-[10px]" },
  "dependabot.disable": { label: "Dependabot Disabled", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-bug-slash text-[10px]" },
  // Every enterprise audit row carries this one action; the specific event
  // (protected_branch.destroy, org.add_member, …) is in `target`, which is what
  // distinguishes them. One label here covers all of them by design.
  "sync.graph": { label: "Access Graph Synced", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.compliance": { label: "Scores Recalculated", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.query": { label: "Check Re-run", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.access": { label: "Access Map Refreshed", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.scanner": { label: "Scanner Run", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-magnifying-glass text-[10px]" },
  "sync.reminders": { label: "Reminders Sent", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-bell text-[10px]" },
  "sync.alarms": { label: "Alarms Evaluated", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-bell text-[10px]" },
  "config.updated": { label: "Setting Changed", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-gear text-[10px]" },
  "aws.guardrail.create": { label: "Guardrail Created", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800", iconClass: "fa-solid fa-plus text-[10px]" },
  "aws.guardrail.update": { label: "Guardrail Updated", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800", iconClass: "fa-solid fa-pen text-[10px]" },
  "aws.guardrail.delete": { label: "Guardrail Deleted", colorClass: "bg-red-50 text-red-700 border-red-200/60 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800", iconClass: "fa-solid fa-trash text-[10px]" },
  "aws.guardrail.run": { label: "Guardrails Run", colorClass: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800", iconClass: "fa-solid fa-play text-[10px]" },
  "aws.guardrail.preview": { label: "Guardrails Previewed", colorClass: "bg-slate-50 text-slate-700 border-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700", iconClass: "fa-solid fa-eye text-[10px]" },
};


/**
 * The name for an action, however it is spelled in the data.
 *
 * Security rows all share one action and are named by the event they recorded,
 * exactly as the feed names them. An action with no entry falls back to its own
 * id rather than to a guess: an id is at least searchable.
 */
export function actionLabel(action: string, importantKind?: string): string {
  if (action === "security.alert") return importantLabel(importantKind);
  return ACTION_CONFIG[action as ActivityAction]?.label ?? action;
}
