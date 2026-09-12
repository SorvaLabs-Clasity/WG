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
  "security.alert": { label: "Security Alert", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-shield-exclamation text-[10px]" },
  "repo.deleted": { label: "Repo Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-trash text-[10px]" },
  "repo.renamed": { label: "Repo Renamed", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-pen text-[10px]" },
  "tag.create": { label: "Tag Created", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-tag text-[10px]" },
  "tag.delete": { label: "Tag Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-tag text-[10px]" },
  "branch.create": { label: "Branch Created", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-plus text-[10px]" },
  "branch.delete": { label: "Branch Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-trash text-[10px]" },
  "branch.rename": { label: "Branch Renamed", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-pen text-[10px]" },
  "branch.protect": { label: "Branch Protected", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-shield text-[10px]" },
  "template.apply": { label: "Template Applied", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-play text-[10px]" },
  "template.apply.repo": { label: "Template \u2192 Repo", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-cube text-[10px]" },
  "template.create": { label: "Template Created", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-gear text-[10px]" },
  "template.update": { label: "Template Updated", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-pen text-[10px]" },
  "template.delete": { label: "Template Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-trash text-[10px]" },
  "exclusion.create": { label: "Exclusion List Created", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-ban text-[10px]" },
  "exclusion.update": { label: "Exclusion List Updated", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-pen text-[10px]" },
  "exclusion.delete": { label: "Exclusion List Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-trash text-[10px]" },
  "branch.unprotect": { label: "Branch Unprotected", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-shield-slash text-[10px]" },
  "repo.ruleset.create": { label: "Ruleset Created", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-list-check text-[10px]" },
  "repo.ruleset.delete": { label: "Ruleset Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-trash text-[10px]" },
  "repo.ruleset.import": { label: "Ruleset Imported", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-file-import text-[10px]" },
  "activity.undo": { label: "Action Undone", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-rotate-left text-[10px]" },
  "activity.redo": { label: "Action Redone", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-rotate-right text-[10px]" },
  "activity.retry": { label: "Action Retried", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "conflict.pending": { label: "Conflict. On Hold", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-pause text-[10px]" },
  "conflict.override": { label: "Conflict Overridden", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-arrow-right-arrow-left text-[10px]" },
  "conflict.skip": { label: "Conflict Skipped", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-forward text-[10px]" },
  "github.push": { label: "Code Pushed", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-code-commit text-[10px]" },
  "github.pr_opened": { label: "PR Opened", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-code-pull-request text-[10px]" },
  "github.pr_merged": { label: "PR Merged", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-code-merge text-[10px]" },
  "github.pr_closed": { label: "PR Closed", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-code-pull-request text-[10px]" },
  "github.issue_opened": { label: "Issue Opened", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-regular fa-circle-dot text-[10px]" },
  "repo.created": { label: "Repo Created", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-repo text-[10px]" },
  "repo.publicized": { label: "Repo Made Public", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-globe text-[10px]" },
  "github.branch_protection_edited": { label: "Protection Changed", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-shield-halved text-[10px]" },
  "github.ruleset_edited": { label: "Ruleset Changed", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-list-check text-[10px]" },
  "config.import": { label: "Configuration Imported", colorClass: "bg-indigo-wash text-indigo border-indigo-edge", iconClass: "fa-solid fa-file-import text-[10px]" },
  "scanner.create": { label: "Scanner Created", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-radar text-[10px]" },
  "scanner.update": { label: "Scanner Updated", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-radar text-[10px]" },
  "scanner.delete": { label: "Scanner Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-radar text-[10px]" },
  "widget.create": { label: "Widget Created", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "widget.update": { label: "Widget Updated", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "widget.delete": { label: "Widget Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-chart-simple text-[10px]" },
  "dependabot.enable": { label: "Dependabot Enabled", colorClass: "bg-forest-wash text-forest border-forest-edge", iconClass: "fa-solid fa-bug text-[10px]" },
  "dependabot.disable": { label: "Dependabot Disabled", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-bug-slash text-[10px]" },
  // Every enterprise audit row carries this one action; the specific event
  // (protected_branch.destroy, org.add_member, …) is in `target`, which is what
  // distinguishes them. One label here covers all of them by design.
  "sync.graph": { label: "Access Graph Synced", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.compliance": { label: "Scores Recalculated", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.query": { label: "Check Re-run", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.access": { label: "Access Map Refreshed", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-arrows-rotate text-[10px]" },
  "sync.scanner": { label: "Scanner Run", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-magnifying-glass text-[10px]" },
  "sync.reminders": { label: "Reminders Sent", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-bell text-[10px]" },
  "sync.alarms": { label: "Alarms Evaluated", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-bell text-[10px]" },
  "config.updated": { label: "Setting Changed", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-gear text-[10px]" },
  "aws.guardrail.create": { label: "Guardrail Created", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-plus text-[10px]" },
  "aws.guardrail.update": { label: "Guardrail Updated", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-pen text-[10px]" },
  "aws.guardrail.delete": { label: "Guardrail Deleted", colorClass: "bg-crimson-wash text-crimson border-crimson-edge", iconClass: "fa-solid fa-trash text-[10px]" },
  "aws.guardrail.run": { label: "Guardrails Run", colorClass: "bg-ochre-wash text-ochre border-ochre-edge", iconClass: "fa-solid fa-play text-[10px]" },
  "aws.guardrail.preview": { label: "Guardrails Previewed", colorClass: "bg-paper-2 text-ink-2 border-rule", iconClass: "fa-solid fa-eye text-[10px]" },
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
