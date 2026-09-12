/**
 * The switch for detailed GitHub logging, and the kinds under it.
 *
 * Lives at the top of the Organization stream because that is where its output
 * lands. The panel is for admins; everyone else sees the rows it produces and
 * the view filter, and never a control they cannot use.
 *
 * The one sentence that matters is under the toggle: turning this off keeps
 * everything already collected. The setting governs what is written from now
 * on, never what is shown, so nobody hesitates to turn it off for fear of
 * losing history.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchDetailedLogging, updateDetailedLogging } from "../api/activity";
import { usePermissions } from "../hooks/usePermissions";

export default function DetailedLoggingPanel() {
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["detailed-logging"],
    queryFn: fetchDetailedLogging,
    enabled: isAdmin,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: updateDetailedLogging,
    onSuccess: (fresh) => queryClient.setQueryData(["detailed-logging"], fresh),
  });

  if (!isAdmin || !data) return null;

  const { settings, kinds } = data;
  const disabled = new Set(settings.disabledKinds);
  const activeCount = kinds.length - settings.disabledKinds.length;

  const toggleKind = (id: string) => {
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    save.mutate({ enabled: settings.enabled, disabledKinds: [...next] });
  };

  return (
    <div className="bg-white dark:bg-paper rounded-lg border border-rule dark:border-rule shadow-subtle mb-4">
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <i className="fa-solid fa-list-check text-gh-muted dark:text-slate-400"></i>
          <div className="min-w-0">
            <div className="display text-[1rem] text-ink dark:text-slate-200">
              Detailed GitHub logging
            </div>
            <div className="text-xs text-gh-muted dark:text-slate-400 truncate">
              {settings.enabled
                ? `Recording ${activeCount} of ${kinds.length} kinds. Branches, tags, pushes and pull requests.`
                : "Off. Only structure and access changes are being recorded."}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {settings.enabled && (
            <button onClick={() => setOpen(!open)}
              className="textlink caps">
              {open ? "Hide kinds" : "Choose kinds"}
            </button>
          )}
          {/* The switch itself. Disabled while a save is in flight so two rapid
              clicks cannot race each other into the wrong final state. */}
          <button
            role="switch"
            aria-checked={settings.enabled}
            disabled={save.isPending}
            onClick={() => save.mutate({ enabled: !settings.enabled, disabledKinds: settings.disabledKinds })}
            className={`relative inline-flex h-5 w-9 items-center border border-rule-strong transition-colors ${
              settings.enabled ? "bg-ink" : "bg-paper-2"} ${
              save.isPending ? "opacity-60" : ""}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform transition-colors transition-transform ${settings.enabled ? "translate-x-[18px] bg-paper" : "translate-x-0.5 bg-ink-3"}`} />
          </button>
        </div>
      </div>

      {settings.enabled && open && (
        <div className="border-t border-rule dark:border-rule px-4 py-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {kinds.map(k => (
              <label key={k.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!disabled.has(k.id)}
                  disabled={save.isPending}
                  onChange={() => toggleKind(k.id)}
                  className="field-line text-[13.5px] mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-gh-textBase dark:text-slate-200">{k.label}</span>
                  <span className="block text-xs text-gh-muted dark:text-slate-400">{k.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-gh-muted dark:text-slate-400">
            Turning this off, or unchecking a kind, stops new rows from being
            collected. Everything already recorded stays in the feed for its
            full 13-month retention.
          </p>
        </div>
      )}
    </div>
  );
}
