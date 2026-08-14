import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRenovate, setRenovateBot, CLOSED_RETENTION_MONTHS, type RenovatePr } from "../api/renovate";
import { usePermissions } from "../hooks/usePermissions";
import { useTableControls } from "../hooks/useTableControls";
import { SearchInput, Pager, Segmented, Empty, Spinner, Pill } from "../design";

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";

/**
 * Renovate's pull requests.
 *
 * Deliberately read-only. Every row links out to GitHub, and there is no merge
 * control anywhere — merging is GitHub's job, where GitHub authorises the
 * person doing it against the repository.
 */
export default function RenovatePanel() {
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["renovate"],
    queryFn: fetchRenovate,
    staleTime: 120_000,
  });

  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const [botDraft, setBotDraft] = useState("");
  const [saveError, setSaveError] = useState("");

  const saveBot = useMutation({
    mutationFn: (bot: string) => setRenovateBot(bot),
    onSuccess: () => { setSaveError(""); qc.invalidateQueries({ queryKey: ["renovate"] }); },
    onError: (e: any) => setSaveError(e?.message || "Could not save that."),
  });

  const rows = useMemo(() => {
    const all = data?.prs ?? [];
    if (filter === "all") return all;
    return all.filter(p => p.state === filter);
  }, [data, filter]);

  const table = useTableControls<RenovatePr>(rows, {
    searchText: (p: RenovatePr) => `${p.repo} ${p.title} #${p.number}`,
    columns: [
      { key: "age", label: "Age", value: (p: RenovatePr) => -p.ageDays },
      { key: "repo", label: "Repository", value: (p: RenovatePr) => p.repo },
      { key: "updated", label: "Updated", value: (p: RenovatePr) => -new Date(p.updatedAt).getTime() },
    ],
    perPage: 25,
  });

  if (isLoading) return <Spinner />;

  if (error) {
    return <Empty title="Could not read Renovate pull requests" body={(error as Error).message} />;
  }

  // Not configured is a normal state, not a failure — most orgs run no Renovate.
  if (!data?.configured) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Renovate</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-400 max-w-2xl">
          Self-hosted Renovate raises pull requests as a bot account. There is no Renovate API to
          ask, so that account name is the only way to find them. Name it and this fills in.
        </p>
        {isAdmin ? (
          <div className="mt-4 flex gap-2 max-w-md">
            <input value={botDraft} onChange={e => setBotDraft(e.target.value)}
              placeholder="e.g. trx-renovate" className={inputClass} />
            <button onClick={() => saveBot.mutate(botDraft)}
              disabled={!botDraft.trim() || saveBot.isPending}
              className="shrink-0 px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-50">
              Save
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            An organisation admin has to set the bot account.
          </p>
        )}
        {saveError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{saveError}</p>}
      </div>
    );
  }

  if (data.unknownBot) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Renovate</h3>
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          GitHub does not recognise the account{" "}
          <code className="px-1 rounded bg-black/5 dark:bg-white/10">{data.bot}</code> — it either
          does not exist, or this app cannot see it. Check the spelling of the bot account.
        </p>
      </div>
    );
  }

  const openCount = (data.prs ?? []).filter(p => p.state === "open").length;
  const closedCount = (data.prs ?? []).length - openCount;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">
            Renovate pull requests
          </h3>
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Raised by <code className="px-1 rounded bg-black/5 dark:bg-white/10">{data.bot}</code>.
            Closed ones drop off {CLOSED_RETENTION_MONTHS} months after they close.
          </p>
        </div>
        <Segmented value={filter} onChange={setFilter} options={[
          ["open", `Open ${openCount}`],
          ["closed", `Closed ${closedCount}`],
          ["all", `All ${openCount + closedCount}`],
        ]} />
      </div>

      {data.truncated && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          GitHub stops paging search results at 1,000, so this list is partial. The counts above are
          a floor, not a total.
        </div>
      )}

      <SearchInput value={table.search} onChange={table.setSearch} placeholder="Search repository or title…" />

      {table.visible.length === 0 ? (
        <Empty title={filter === "open" ? "Nothing waiting" : "Nothing here"}
          body={filter === "open"
            ? "Renovate has no open pull requests — everything it raised has been dealt with."
            : `No ${filter === "closed" ? "closed" : ""} pull requests match.`} />
      ) : (
        <div className="grid gap-2">
          {table.visible.map(pr => (
            // The whole row is the link out. This app never merges.
            <a key={pr.id} href={pr.url} target="_blank" rel="noopener noreferrer"
              className="block bg-white dark:bg-slate-900 rounded-[10px] border border-gh-border dark:border-slate-700 px-4 py-3 hover:border-gh-blue transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gh-textBase dark:text-slate-100">{pr.repo}</span>
                    <span className="text-xs text-gray-400 dark:text-slate-500">#{pr.number}</span>
                    {pr.state === "open" && pr.draft && <Pill intent="neutral">draft</Pill>}
                    {pr.state === "open" && !pr.draft && <Pill intent="warn">open</Pill>}
                    {pr.state === "closed" && pr.merged && <Pill intent="good">merged</Pill>}
                    {pr.state === "closed" && !pr.merged && <Pill intent="neutral">closed</Pill>}
                  </div>
                  <p className="mt-1 text-sm text-gray-600 dark:text-slate-300 truncate">{pr.title}</p>
                </div>
                <div className="shrink-0 text-right text-xs text-gray-500 dark:text-slate-400">
                  {pr.state === "open"
                    ? <>open {pr.ageDays} day{pr.ageDays === 1 ? "" : "s"}</>
                    : <>closed {new Date(pr.closedAt ?? "").toLocaleDateString()}</>}
                  <div className="mt-0.5 text-gh-blue">open on GitHub →</div>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}

      <Pager page={table.page} totalPages={table.totalPages} onPage={table.setPage}
        matchCount={table.matchCount} totalCount={table.totalCount}
        filtered={table.filtered} noun="pull requests" />
    </div>
  );
}
