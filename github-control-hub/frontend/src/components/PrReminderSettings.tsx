import { useState, useEffect, useMemo } from "react";
import UserAvatar from "./UserAvatar";
import PersonPicker from "./PersonPicker";
import { SURFACE } from "../design";
import { useOrgMembers } from "../hooks/useOrgConfig";

export interface Mutes {
  global: string[];
  byRepo: Record<string, string[]>;
}

const inputClass =
  "w-full px-3 py-2 text-sm bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 " +
  "rounded-lg text-slate-700 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 " +
  "focus:outline-none focus:ring-2 focus:ring-gh-blue/40 focus:border-gh-blue";

/**
 * A muted person, with the way to undo it attached.
 *
 * Which list it sits in is what gives it its scope, so the chip does not repeat
 * it — inside a repository's panel every chip is a repository mute, and
 * labelling each one would be noise.
 */
function MuteChip({ login, avatarUrl, onRemove, busy }: {
  login: string; avatarUrl?: string | null; onRemove: () => void; busy?: boolean;
}) {
  return (
    <span className="group inline-flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-full bg-slate-100 dark:bg-white/[0.07] border border-slate-200 dark:border-white/10">
      <UserAvatar login={login} avatarUrl={avatarUrl ?? undefined} size={20} />
      <span className="text-[13px] font-medium text-slate-700 dark:text-slate-200">{login}</span>
      <button onClick={onRemove} disabled={busy} aria-label={`Stop muting ${login}`}
        title={`Stop muting ${login}`}
        className="w-4 h-4 rounded-full flex items-center justify-center text-slate-400 hover:bg-rose-500 hover:text-white disabled:opacity-40 transition-colors">
        <i className="ph-bold ph-x text-[9px]"></i>
      </button>
    </span>
  );
}

function Nobody({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] text-slate-400 dark:text-slate-500 italic py-1">{children}</p>
  );
}

/**
 * Managing who never gets reminded, as a window rather than a panel on the page.
 *
 * Two scopes live here — everywhere, and per repository. The third, a single
 * pull request, stays on the pull request itself, where the context that
 * justifies it is visible.
 */
export default function PrReminderSettings({
  open, onClose, mutes, repos, reposLoading, onMute, busy,
}: {
  open: boolean;
  onClose: () => void;
  mutes: Mutes;
  /** Every repository in the organization, as owner/name. */
  repos: string[];
  reposLoading?: boolean;
  onMute: (scope: "global" | "repo", target: string, muted: boolean, repo?: string) => void;
  busy?: boolean;
}) {
  const [tab, setTab] = useState<"global" | "repo">("global");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  // Only while the window is open. Nobody needs the member list to read the
  // queue, and it is a paged request per hundred people.
  const { data: members, isLoading: membersLoading } = useOrgMembers(open);
  const avatarOf = (login: string) =>
    (members ?? []).find(m => m.login.toLowerCase() === login.toLowerCase())?.avatarUrl ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /**
   * Every repository, plus any that only exist here.
   *
   * A repository can carry a mute and then be renamed, archived or removed from
   * the installation, which drops it out of the list. Merging the mute keys back
   * in keeps it reachable — otherwise the only way to lift that mute would be to
   * edit the record by hand.
   */
  const all = useMemo(() => {
    const merged = new Set([...repos, ...Object.keys(mutes.byRepo)]);
    const count = (r: string) => (mutes.byRepo[r] ?? []).length;
    return [...merged].sort((a, b) =>
      count(b) - count(a) || a.localeCompare(b));
  }, [repos, mutes.byRepo]);

  const q = search.trim().toLowerCase();
  const shown = q ? all.filter(r => r.toLowerCase().includes(q)) : all;

  const repoMuteCount = Object.values(mutes.byRepo).flat().length;
  const pickedMutes = picked ? mutes.byRepo[picked] ?? [] : [];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true"
      aria-label="Reminder mutes">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>

      <div className={`${SURFACE.sheet} ${SURFACE.raised} relative z-10 w-full max-w-3xl flex flex-col max-h-[85vh]`}
        style={{ animation: "slideUp 0.28s cubic-bezier(0.16,1,0.3,1) both" }}>

        <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-white/[0.09] shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <span className="mt-0.5 w-9 h-9 rounded-xl bg-slate-900 dark:bg-white/10 text-white flex items-center justify-center shrink-0">
                <i className="ph-bold ph-bell-slash text-base"></i>
              </span>
              <div className="min-w-0">
                <h3 className="text-lg font-black tracking-tight text-slate-900 dark:text-white">
                  Reminder mutes
                </h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Skip one person on stale pull request reminders. Nothing else about them changes,
                  and it can be lifted at any time.
                </p>
              </div>
            </div>
            <button onClick={onClose} aria-label="Close"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0">
              <i className="ph-bold ph-x"></i>
            </button>
          </div>

          {/* Counts on the tabs, so a mute set weeks ago in the pane you are not
              looking at is still visible from here. */}
          <div className="mt-4 flex p-1 rounded-xl bg-slate-100 dark:bg-white/[0.05] w-fit">
            {([["global", "Everywhere", mutes.global.length],
               ["repo", "By repository", repoMuteCount]] as const).map(([v, label, n]) => (
              <button key={v} onClick={() => setTab(v)}
                className={`px-4 py-1.5 text-[13px] font-bold rounded-lg transition-all inline-flex items-center gap-2 ${
                  tab === v ? "bg-white dark:bg-white/10 text-slate-900 dark:text-white shadow-sm"
                            : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}>
                {label}
                {n > 0 && (
                  <span className={`text-[11px] tabular-nums px-1.5 rounded-full ${
                    tab === v ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                              : "bg-slate-200 dark:bg-white/10 text-slate-500 dark:text-slate-400"}`}>
                    {n}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "global" ? (
            <div className="p-6 space-y-4">
              <p className="text-[13px] text-slate-500 dark:text-slate-400 max-w-lg">
                For someone on leave, or who has left. They are never named in any reminder, on any
                repository.
              </p>
              <div className="max-w-md">
                <PersonPicker members={members ?? []} loading={membersLoading}
                  exclude={mutes.global} disabled={busy}
                  placeholder="Search people in the organization…"
                  onPick={l => onMute("global", l, true)} />
              </div>
              {mutes.global.length === 0 ? (
                <Nobody>Nobody is muted everywhere.</Nobody>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {mutes.global.map(l => (
                    <MuteChip key={l} login={l} avatarUrl={avatarOf(l)} busy={busy}
                      onRemove={() => onMute("global", l, false)} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="grid sm:grid-cols-[minmax(0,17rem)_1fr] min-h-[22rem]">
              {/* Every repository, not only the ones with a pull request open
                  today. A mute set now is meant to still be there the first time
                  that repository gets one. */}
              <div className="border-b sm:border-b-0 sm:border-r border-slate-200 dark:border-white/[0.09] flex flex-col min-h-0">
                <div className="p-3 border-b border-slate-200 dark:border-white/[0.09] shrink-0">
                  <div className="relative">
                    <i className="ph-bold ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                    <input value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Search repositories…" className={inputClass + " pl-8 py-1.5 text-[13px]"} />
                  </div>
                </div>
                <div className="overflow-y-auto max-h-[26rem] p-2">
                  {reposLoading && all.length === 0 ? (
                    <p className="text-[13px] text-slate-400 dark:text-slate-500 px-2 py-2">Loading repositories…</p>
                  ) : shown.length === 0 ? (
                    <p className="text-[13px] text-slate-400 dark:text-slate-500 px-2 py-2">
                      {q ? "No repository matches." : "No repositories visible to you."}
                    </p>
                  ) : shown.map(r => {
                    const n = (mutes.byRepo[r] ?? []).length;
                    const on = picked === r;
                    return (
                      <button key={r} onClick={() => setPicked(r)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
                          on ? "bg-gh-blue text-white"
                             : "hover:bg-slate-100 dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300"}`}>
                        <span className="text-[13px] truncate flex-1 min-w-0">
                          {/* Owner dimmed, because every row shares it and the
                              part that differs is the part being scanned for. */}
                          <span className={on ? "opacity-70" : "text-slate-400 dark:text-slate-500"}>
                            {r.split("/")[0]}/
                          </span>
                          <span className="font-medium">{r.split("/").slice(1).join("/")}</span>
                        </span>
                        {n > 0 && (
                          <span className={`text-[11px] font-bold tabular-nums px-1.5 rounded-full shrink-0 ${
                            on ? "bg-white/25" : "bg-slate-900 dark:bg-white text-white dark:text-slate-900"}`}>
                            {n}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="p-5">
                {!picked ? (
                  <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10">
                    <i className="ph ph-arrow-left text-2xl text-slate-300 dark:text-slate-600 mb-3"></i>
                    <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                      Pick a repository
                    </p>
                    <p className="text-[13px] text-slate-400 dark:text-slate-500 mt-1 max-w-xs">
                      For someone who keeps being asked to review a repository they do not work on.
                      A repository with no open pull requests can still be set up now.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <code className="text-[13px] font-semibold text-slate-900 dark:text-white break-all">
                        {picked}
                      </code>
                      {!repos.includes(picked) && (
                        // Otherwise a mute on a repository that has since gone
                        // reads as a repository nobody can find.
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                          Not in your visible repositories — renamed, archived or removed from the
                          installation.
                        </p>
                      )}
                    </div>
                    <PersonPicker members={members ?? []} loading={membersLoading}
                      exclude={pickedMutes} disabled={busy}
                      placeholder="Search people in the organization…"
                      onPick={l => onMute("repo", l, true, picked)} />
                    {pickedMutes.length === 0 ? (
                      <Nobody>Nobody is muted on this repository.</Nobody>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {pickedMutes.map(l => (
                          <MuteChip key={l} login={l} avatarUrl={avatarOf(l)} busy={busy}
                            onRemove={() => onMute("repo", l, false, picked)} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-white/[0.09] flex items-center justify-between gap-3 shrink-0">
          <p className="text-[12px] text-slate-400 dark:text-slate-500">
            Saved as you go. A pull request whose every candidate is muted posts nothing at all.
          </p>
          <button onClick={onClose}
            className="px-4 py-2 text-[13px] font-bold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
