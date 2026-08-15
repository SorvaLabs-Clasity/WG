import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../App";
import { apiGet } from "../api/client";
import { Page, Empty, Spinner } from "../design";
import UserAvatar from "../components/UserAvatar";

type Kind = "repo" | "path" | "library";

interface Expert {
  login: string;
  score: number;
  commits: number;
  reviews: number;
  comments: number;
  lastActive: string | null;
  daysSinceActive: number | null;
}

interface Answer {
  subject: { kind: Kind; name: string };
  experts: Expert[];
  repos?: string[];
  degraded: string[];
}

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";

/**
 * What each mode asks and what it costs, said where it is chosen.
 *
 * The cost matters to whoever is typing: a library lookup is a code search,
 * which draws on a much smaller rate budget than everything else in this app.
 */
const MODES: Record<Kind, { label: string; hint: string; placeholder: string }> = {
  repo: {
    label: "Repository",
    hint: "Commits, review comments and discussion across the whole repository.",
    placeholder: "payments-api",
  },
  path: {
    label: "File or folder",
    hint: "Commits touching that path only. Reviews are not counted here — they "
      + "belong to the pull request, not to one file, and attributing them would "
      + "rank people who never opened it.",
    placeholder: "src/billing/charge.ts",
  },
  library: {
    label: "Library",
    hint: "Finds the manifests naming it across the organization and reads their "
      + "history, so it ranks whoever added, bumped or removed the dependency. "
      + "Uses code search, which has its own smaller rate limit.",
    placeholder: "react-router",
  },
};

function ago(days: number | null): string {
  if (days === null) return "unknown";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

export default function ExpertisePage() {
  const { user } = useAuth();
  const [kind, setKind] = useState<Kind>("repo");
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [library, setLibrary] = useState("");

  // Held separately from the inputs so typing does not re-query on every
  // keystroke. Each lookup is real GitHub requests, and a search-backed one at
  // that; it runs when asked and not before.
  const [asked, setAsked] = useState<{ kind: Kind; repo: string; path: string; library: string } | null>(null);

  const key = asked
    ? ["expertise", asked.kind, asked.repo, asked.path, asked.library]
    : ["expertise", "idle"];

  const { data, isFetching, error } = useQuery<Answer>({
    queryKey: key,
    enabled: !!asked,
    staleTime: 300_000,
    queryFn: () => {
      const a = asked!;
      if (a.kind === "repo") return apiGet<Answer>(`/expertise/repo/${encodeURIComponent(a.repo)}`);
      if (a.kind === "path") {
        return apiGet<Answer>(
          `/expertise/path/${encodeURIComponent(a.repo)}?path=${encodeURIComponent(a.path)}`);
      }
      return apiGet<Answer>(`/expertise/library/${encodeURIComponent(a.library)}`);
    },
  });

  const canAsk = kind === "library" ? library.trim() : kind === "path" ? repo.trim() && path.trim() : repo.trim();

  return (
    <Page user={user}>
      <header className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Who knows this?</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
          Ranks people by what they have actually touched — commits, reviews and discussion —
          weighted so recent work counts for more. For when something is broken and you need to
          know who to ask first.
        </p>
      </header>

      <div className="bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5">
        <div className="flex gap-1 mb-4">
          {(Object.keys(MODES) as Kind[]).map(k => (
            <button key={k} onClick={() => setKind(k)}
              className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${
                kind === k
                  ? "bg-gh-blue text-white"
                  : "text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5"}`}>
              {MODES[k].label}
            </button>
          ))}
        </div>

        <form className="grid gap-3 sm:grid-cols-[1fr_auto]"
          onSubmit={e => { e.preventDefault(); if (canAsk) setAsked({ kind, repo, path, library }); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {kind !== "library" && (
              <input value={repo} onChange={e => setRepo(e.target.value)}
                placeholder={MODES.repo.placeholder} className={inputClass} />
            )}
            {kind === "path" && (
              <input value={path} onChange={e => setPath(e.target.value)}
                placeholder={MODES.path.placeholder} className={inputClass} />
            )}
            {kind === "library" && (
              <input value={library} onChange={e => setLibrary(e.target.value)}
                placeholder={MODES.library.placeholder} className={inputClass} />
            )}
          </div>
          <button type="submit" disabled={!canAsk || isFetching}
            className="px-5 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-40 h-fit">
            {isFetching ? "Looking…" : "Ask"}
          </button>
        </form>

        <p className="mt-2 text-xs text-gray-500 dark:text-slate-400 max-w-3xl">{MODES[kind].hint}</p>
      </div>

      {error && (
        <div className="mt-5 rounded-md bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isFetching && <div className="mt-6"><Spinner /></div>}

      {data && !isFetching && (
        <div className="mt-6">
          {/* Said plainly rather than shown as an empty list. "Nobody" and
              "we could not look" are different answers and the difference
              matters at three in the morning. */}
          {data.experts.length === 0 ? (
            <Empty
              title="Nobody found"
              body={data.degraded.length
                ? `Could not read: ${data.degraded.join(", ")}. This may be a permissions or `
                  + `visibility problem rather than an empty history.`
                : "No commits, reviews or discussion match. Check the name is right — "
                  + "this searches only what your own account can see."} />
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
                <h2 className="text-base font-bold text-gray-900 dark:text-white">
                  {data.subject.name}
                </h2>
                {data.repos && data.repos.length > 0 && (
                  <span className="text-xs text-gray-500 dark:text-slate-400">
                    from {data.repos.length} repositor{data.repos.length === 1 ? "y" : "ies"}: {data.repos.join(", ")}
                  </span>
                )}
              </div>

              {data.degraded.length > 0 && (
                <div className="mb-3 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  Partial answer — could not read {data.degraded.join(", ")}. The ranking below is
                  from the signals that did load.
                </div>
              )}

              <ul className="grid gap-2">
                {data.experts.map((e, i) => (
                  <li key={e.login}
                    className="relative overflow-hidden rounded-xl bg-slate-50 dark:bg-white/[0.05] border border-slate-200/70 dark:border-white/[0.08]">
                    <span className="absolute left-0 top-0 bottom-0 w-1 bg-gh-blue"
                      style={{ opacity: Math.max(0.15, e.score / 100) }} />
                    <div className="pl-4 pr-4 py-3 flex items-center gap-3 flex-wrap">
                      <span className="text-xs font-black tabular-nums text-slate-400 dark:text-slate-500 w-5">
                        {i + 1}
                      </span>
                      <UserAvatar login={e.login} size={28} />
                      <a href={`https://github.com/${e.login}`} target="_blank" rel="noopener noreferrer"
                        className="font-semibold text-gh-textBase dark:text-slate-200 hover:text-gh-blue">
                        {e.login}
                      </a>
                      <span className="text-xs text-gray-500 dark:text-slate-400">
                        {[
                          e.commits ? `${e.commits} commit${e.commits === 1 ? "" : "s"}` : null,
                          e.reviews ? `${e.reviews} review${e.reviews === 1 ? "" : "s"}` : null,
                          e.comments ? `${e.comments} comment${e.comments === 1 ? "" : "s"}` : null,
                        ].filter(Boolean).join(" · ")}
                      </span>
                      <span className="ml-auto flex items-center gap-3 shrink-0">
                        <span className="text-xs text-gray-500 dark:text-slate-400">
                          last {ago(e.daysSinceActive)}
                        </span>
                        <span className="text-sm font-black tabular-nums text-gh-textBase dark:text-slate-200 w-9 text-right">
                          {e.score}
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-xs text-gray-500 dark:text-slate-400 max-w-3xl">
                Scores are relative to the top person, not absolute. Contributions halve in weight
                every 90 days, so this ranks who is likely to remember rather than who has done the
                most over all time. Bot accounts are excluded.
              </p>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
