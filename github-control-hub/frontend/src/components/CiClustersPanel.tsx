import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { Empty, Spinner } from "../design";

interface Cluster {
  shared: string;
  key: { step: string | null; label: string | null; workflow: string | null };
  repos: string[];
  failures: number;
  firstAt: string;
  lastAt: string;
  examples: string[];
}

interface Clusters {
  windowHours: number;
  clusters: Cluster[];
  failuresInWindow: number;
}

const cardClass =
  "bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "?";
}

/**
 * Failures that look like one problem.
 *
 * Thirteen repositories failing is almost never thirteen problems, and the cost
 * of not noticing is thirteen people debugging the same cause separately. This
 * only ever groups across repositories: one repository failing repeatedly is
 * that repository's own business and its owner already knows.
 */
export default function CiClustersPanel({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean } = {}) {
  const { data, isLoading, error } = useQuery<Clusters>({
    queryKey: ["ci-clusters"],
    queryFn: () => apiGet<Clusters>("/ci/clusters"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const clusters = data?.clusters ?? [];

  // Somewhere it is one section among many, an empty state is worth showing.
  // Somewhere it is wedged above an unrelated feed, a daily "no failures" card
  // is just something to scroll past, so it disappears instead.
  if (hideWhenEmpty && (isLoading || error || clusters.length === 0)) return null;

  if (isLoading) return <Spinner />;
  if (error) {
    return <Empty title="Could not read CI failures" body={(error as Error).message} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Correlated CI failures</h3>
        <p className="text-sm text-gray-600 dark:text-slate-400 max-w-3xl mt-1">
          Failures from the last {data?.windowHours ?? 2} hours that share a cause — the same step,
          the same runner, or the same workflow — across more than one repository. Built from
          webhook deliveries, so it costs no GitHub requests and nothing had to be polled.
        </p>
      </div>

      {clusters.length === 0 ? (
        // The distinction that makes this readable: no clusters with forty
        // failures means everything is failing separately, which is a different
        // situation from nothing failing.
        <Empty
          title={data?.failuresInWindow ? "Nothing correlated" : "No failures"}
          body={data?.failuresInWindow
            ? `${data.failuresInWindow} job${data.failuresInWindow === 1 ? "" : "s"} failed in this `
              + `window, but no two repositories failed the same way — so these look like separate `
              + `problems rather than one.`
            : "No CI jobs have failed in this window."} />
      ) : (
        <ul className="grid gap-3">
          {clusters.map((c, i) => (
            <li key={i} className={cardClass}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="font-bold text-gray-900 dark:text-white">{c.shared}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                    {when(c.firstAt)} – {when(c.lastAt)}
                    {c.key.label && <> · runner <code className="px-1 rounded bg-black/5 dark:bg-white/10">{c.key.label}</code></>}
                    {c.key.workflow && <> · workflow <code className="px-1 rounded bg-black/5 dark:bg-white/10">{c.key.workflow}</code></>}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-black uppercase tracking-wide px-2 py-1 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                  {c.repos.length} repos
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {c.repos.map(r => (
                  <span key={r}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700/70 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600">
                    {r}
                  </span>
                ))}
              </div>

              {c.examples.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {c.examples.map((u, j) => (
                    <a key={u} href={u} target="_blank" rel="noopener noreferrer"
                      className="text-xs font-semibold text-gh-blue hover:underline">
                      open failure {j + 1} ↗
                    </a>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
