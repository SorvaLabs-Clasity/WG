import { useState } from "react";
import { useUsage } from "../hooks/useBilling";
import { usePermissions } from "../hooks/usePermissions";
import { useAuth } from "../App";
import { useTableControls } from "../hooks/useTableControls";
import {
  Page, PageHeader, StatusSlab, Sheet, Block, Empty, Spinner, Segmented,
  SearchInput, Pager, TYPE, RefreshButton,
} from "../design";

const MONTH_OPTIONS: [string, string][] = [["3", "3 months"], ["6", "6 months"], ["12", "12 months"]];

/** "2026-08" → "Aug 2026". */
function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default function BillingPage() {
  const { user } = useAuth();
  const [months, setMonths] = useState("6");
  const { data, isLoading, isFetching, error, refetch } = useUsage(Number(months));
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isControlHubAdmin ?? false;

  const table = useTableControls(data?.byRepo ?? [], {
    searchText: r => `${r.repo} ${r.products.join(" ")}`,
    columns: [
      { key: "quantity", label: "Usage", value: r => r.quantity },
      { key: "repo", label: "Repository", value: r => r.repo },
      { key: "gross", label: "Value", value: r => r.gross },
    ],
    initialSortKey: "quantity",
    initialSortDir: "desc",
    perPage: 25,
  });

  if (isLoading) return <Page user={user}><Spinner /></Page>;

  // The server gates this; the page explains rather than showing a broken
  // screen. Anyone can reach the URL — only admins get numbers.
  if (error || !data) {
    const forbidden = (error as any)?.status === 403 || /admin/i.test(String((error as any)?.message ?? ""));
    return (
      <Page user={user}>
        <Empty
          title={forbidden ? "Billing is admin-only" : "Could not load billing"}
          body={forbidden
            ? "Spend tells you what a team costs to run and which projects are expensive. It is limited to the Control Hub admin team and organization owners."
            : String((error as any)?.message ?? "GitHub did not return usage data.")}
        />
      </Page>
    );
  }

  const { totals, months: series, byProduct } = data;
  const peak = Math.max(1, ...series.map(m => m.quantity));
  // Gross is what the usage would cost at list price; net is what is actually
  // billed after the included allowance. They differ for most organisations,
  // and showing only one of them misleads in opposite directions.
  const covered = totals.gross - totals.net;

  return (
    <Page user={user}>
      <PageHeader
        title="Usage & spend"
        subtitle={`Actions, packages and storage across the organization, attributed by repository`}
        actions={<RefreshButton onRefresh={() => refetch()} busy={isFetching} />}
      />

      {data.empty ? (
        <Empty
          title="No usage recorded"
          body="GitHub has reported no billable usage for this period. That is different from zero cost — it means there is nothing to attribute yet."
        />
      ) : (
        <>
          <div className="mb-6">
            <StatusSlab
              intent={totals.net > 0 ? "warn" : "good"}
              eyebrow={`Last ${months} months`}
              metrics={[
                { value: totals.quantity, label: byProduct[0]?.unitType?.toLowerCase() ?? "units", emphasis: true },
                { value: totals.repos, label: "repositories" },
              ]}
              footer={
                <span>
                  {totals.net === 0
                    ? <>Nothing billed — {money(covered)} of list price covered by your included allowance.</>
                    : <>{money(totals.net)} billed, after {money(covered)} of allowance.</>}
                </span>
              }
            />
          </div>

          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <Segmented value={months} onChange={setMonths} options={MONTH_OPTIONS} />
            <SearchInput value={table.search} onChange={table.setSearch} placeholder="Search repositories…" />
          </div>

          <Sheet>
            <Block title="By month">
              {series.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">No monthly breakdown available.</p>
              ) : (
                <div className="space-y-2">
                  {series.map(m => (
                    <div key={m.month} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-sm text-slate-500 dark:text-slate-400">{monthLabel(m.month)}</span>
                      <div className="flex-1 h-6 rounded-md bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div className="h-full bg-blue-500/70 dark:bg-blue-500/50 rounded-md transition-all"
                          style={{ width: `${Math.max(2, (m.quantity / peak) * 100)}%` }} />
                      </div>
                      <span className="w-28 shrink-0 text-right text-sm tabular-nums text-slate-700 dark:text-slate-300">
                        {m.quantity} {series[0] && byProduct[0]?.unitType?.toLowerCase()}
                      </span>
                    </div>
                  ))}
                  {/* A month with no usage returns no rows, so gaps in this list
                      are real quiet months rather than missing data. */}
                  <p className="text-xs text-slate-400 dark:text-slate-500 pt-1">
                    Months with no recorded usage are omitted.
                  </p>
                </div>
              )}
            </Block>

            {byProduct.length > 1 && (
              <Block title="By product">
                <div className="grid gap-2 sm:grid-cols-2">
                  {byProduct.map(p => (
                    <div key={p.product} className="flex items-baseline justify-between gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.04]">
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{p.product}</span>
                      <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
                        {p.quantity} {p.unitType.toLowerCase()} · {money(p.gross)}
                      </span>
                    </div>
                  ))}
                </div>
              </Block>
            )}

            <Block title="By repository">
              {table.visible.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Nothing in {table.totalCount} repositories matches "{table.search.trim()}".
                </p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {table.visible.map(r => (
                    <div key={r.repo} className="flex items-center gap-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className={`${TYPE.heading} truncate ${r.unattributed ? "text-slate-400 dark:text-slate-500 italic" : "text-slate-900 dark:text-white"}`}>
                          {r.repo}
                        </p>
                        <p className="text-xs text-slate-400 dark:text-slate-500">{r.products.join(", ")}</p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-slate-700 dark:text-slate-300">
                        {r.quantity} {r.unitType.toLowerCase()}
                      </span>
                      <span className="shrink-0 w-20 text-right text-sm tabular-nums text-slate-500 dark:text-slate-400">
                        {money(r.gross)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <Pager
                page={table.page} totalPages={table.totalPages} onPage={table.setPage}
                matchCount={table.matchCount} totalCount={table.totalCount}
                filtered={table.filtered} noun="repositories"
              />
              {/* Named rather than hidden: usage GitHub could not attribute is
                  real spend, and dropping it would make these figures disagree
                  with the bill. */}
              {data.byRepo.some(r => r.unattributed) && (
                <p className="text-xs text-slate-400 dark:text-slate-500 pt-3">
                  Usage GitHub did not attribute to a repository is listed in italics. It is included in the totals above.
                </p>
              )}
            </Block>
          </Sheet>
        </>
      )}
    </Page>
  );
}
