import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../App";
import { apiGet } from "../api/client";
import { Page, Empty, Spinner, SURFACE } from "../design";
import { useRepos } from "../hooks/useRepos";
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
  /** A page limit was hit, so every count below is a floor. */
  sampled?: boolean;
}

const labelClass = "caps block mb-1.5";

const inputClass = "field-line text-[13.5px]";

/**
 * What each mode asks and what it costs, said where it is chosen.
 *
 * The cost matters to whoever is typing: a library lookup is a code search,
 * which draws on a much smaller rate budget than everything else in this app.
 */
const MODES: Record<Kind, { label: string; icon: string; hint: string; placeholder: string }> = {
  repo: {
    label: "Repository",
    icon: "ph-git-branch",
    hint: "Commits, review comments and discussion across the whole repository.",
    placeholder: "payments-api",
  },
  path: {
    label: "File or folder",
    icon: "ph-file-code",
    hint: "Needs both boxes: a path only means something inside one repository, and "
      + "GitHub has no organization-wide search for who touched a file. A folder works "
      + "as well as a file. Commits only, reviews belong to the pull request, not to "
      + "one file, and attributing them here would rank people who never opened it.",
    placeholder: "src/billing/charge.ts",
  },
  library: {
    label: "Library",
    icon: "ph-package",
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

/**
 * Recency as a colour as well as a date.
 *
 * The ranking already decays with age, so somebody near the top who last
 * touched this two years ago is the top of a cold list rather than a good
 * answer. Reading that off the ranking alone takes a second look.
 */
function freshness(days: number | null): string {
  if (days === null) return "bg-rule-strong";
  if (days <= 30) return "bg-emerald-500";
  if (days <= 180) return "bg-amber-500";
  return "bg-rule-strong";
}

function Signals({ e, size = "sm", sampled }: { e: Expert; size?: "sm" | "lg"; sampled?: boolean }) {
  const items = [
    { n: e.commits, icon: "ph-git-commit", one: "commit", many: "commits" },
    { n: e.reviews, icon: "ph-check-square-offset", one: "review", many: "reviews" },
    { n: e.comments, icon: "ph-chat-circle", one: "comment", many: "comments" },
  ].filter(i => i.n > 0);

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {items.map(i => (
        <span key={i.icon} title={`${i.n} ${i.n === 1 ? i.one : i.many}`}
          className={`inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-ink/[0.07] text-slate-600 dark:text-slate-300 ${
            size === "lg" ? "px-2 py-1 text-xs" : "px-1.5 py-0.5 text-[11px]"}`}>
          <i className={`ph ${i.icon}`}></i>
          {/* A floor, not a total. GitHub returns one page of a hundred, so
              a repository with four thousand commits and one with a hundred and
              one both came back as "100". A number wrong in a way nobody could
              see. */}
          <span className="font-bold tabular-nums">{i.n}{sampled && i.n >= 100 ? "+" : ""}</span>
          <span className="font-medium opacity-70">{i.n === 1 ? i.one : i.many}</span>
        </span>
      ))}
    </span>
  );
}

export default function ExpertisePage() {
  const { user } = useAuth();
  const [kind, setKind] = useState<Kind>("repo");
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [library, setLibrary] = useState("");

  const { data: allRepos } = useRepos();

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
  const [top, ...rest] = data?.experts ?? [];

  /**
   * Built by a plain call, not rendered as a nested component.
   *
   * A component declared inside a render is a new type on every render, so React
   * unmounts and remounts it rather than updating it, which for a controlled
   * text box means the caret is lost after each character typed.
   */
  const repoInput = () => (
    <div>
      <label className={labelClass} htmlFor="wk-repo">Repository</label>
      <input id="wk-repo" value={repo} onChange={e => setRepo(e.target.value)}
        list="wk-repo-list" placeholder={MODES.repo.placeholder} className={inputClass} />
      {/* Suggestions, not a closed list: the answer for a repository the app
          cannot see is a 404 from GitHub, not a box that refuses to accept it. */}
      <datalist id="wk-repo-list">
        {(allRepos ?? []).map(r => <option key={r.full_name} value={r.name} />)}
      </datalist>
    </div>
  );

  return (
    <Page user={user}>
      <header className="mb-7 pb-3 border-b-2 border-ink">
        <h1 className="display text-[clamp(1.75rem,3vw,2.25rem)] text-ink">Who knows this?</h1>
        <p className="standfirst text-[14px] mt-2 max-w-[68ch]">
          Ranks people by what they have actually touched, commits, reviews and discussion -
          weighted so recent work counts for more. For when something is broken and you need to
          know who to ask first.
        </p>
      </header>

      <div className={SURFACE.sheet}>
        {/* The tabs sit on the card's edge rather than inside it, so the card
            reads as belonging to the mode rather than the mode being one more
            field in a form. */}
        <div className="flex border-b border-rule overflow-x-auto">
          {(Object.keys(MODES) as Kind[]).map((k, i) => (
            <button key={k} onClick={() => setKind(k)}
              className={`caps px-5 py-3 -mb-px whitespace-nowrap inline-flex items-center gap-2 border-b-2 transition-colors ${
                i > 0 ? "border-l border-l-rule" : ""} ${
                kind === k ? "text-ink border-b-ink" : "border-b-transparent hover:text-ink"}`}>
              <i className={`ph-bold ${MODES[k].icon} text-[13px]`}></i>
              {MODES[k].label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* Labelled, not just placeheld. Two unlabelled boxes side by side is
              a guess, and the placeholder. The only thing saying which is which
             , disappears the moment anyone types. */}
          <form className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
            onSubmit={e => { e.preventDefault(); if (canAsk) setAsked({ kind, repo, path, library }); }}>
            <div className={`grid gap-3 ${kind === "path" ? "sm:grid-cols-2" : ""}`}>
              {kind !== "library" && repoInput()}
              {kind === "path" && (
                <div>
                  <label className={labelClass} htmlFor="wk-path">File or folder inside it</label>
                  <input id="wk-path" value={path} onChange={e => setPath(e.target.value)}
                    placeholder={MODES.path.placeholder} className={inputClass} />
                </div>
              )}
              {kind === "library" && (
                <div>
                  <label className={labelClass} htmlFor="wk-lib">Package name</label>
                  <input id="wk-lib" value={library} onChange={e => setLibrary(e.target.value)}
                    placeholder={MODES.library.placeholder} className={inputClass} />
                </div>
              )}
            </div>
            <button type="submit" disabled={!canAsk || isFetching}
              title={canAsk ? "" : kind === "path"
                ? "Both a repository and a path are needed. A path only means something inside one repository"
                : "Fill this in first"}
              className="stamp h-fit">
              {isFetching ? "Looking…" : "Ask"}
            </button>
          </form>

          <p className="standfirst text-[12.5px] mt-4 max-w-[76ch]">{MODES[kind].hint}</p>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-xl bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
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
              title={data.repos?.length ? "Only automated accounts" : "Nobody found"}
              body={
                // Three different situations that all render as an empty list,
                // and telling somebody to check the spelling when the name was
                // right and the history is simply all bot-authored sends them
                // looking for a problem that is not there.
                data.repos?.length
                  ? `Found in ${data.repos.length} repositor${data.repos.length === 1 ? "y" : "ies"}, `
                    + `but every change to those files was made by an automated account. `
                    + `Bots are excluded from the ranking, so there is nobody here to ask.`
                  : data.degraded.length
                    ? `Could not read: ${data.degraded.join(", ")}. This may be a permissions or `
                      + `visibility problem rather than an empty history.`
                    : "No commits, reviews or discussion match. Check the name is right, "
                      + "this searches only what your own account can see."} />
          ) : (
            <>
              <div className="flex items-center gap-2.5 flex-wrap mb-4">
                <span className="caps inline-flex items-center gap-1.5 px-2 py-1 bg-slate-100">
                  <i className={`ph-bold ${MODES[data.subject.kind].icon}`}></i>
                  {MODES[data.subject.kind].label}
                </span>
                <h2 className="display text-[1.1875rem] text-ink break-all">
                  {data.subject.name}
                </h2>
                {data.repos && data.repos.length > 0 && (
                  <span className="text-xs text-slate-400 dark:text-slate-500"
                    title={data.repos.join(", ")}>
                    across {data.repos.length} repositor{data.repos.length === 1 ? "y" : "ies"}
                  </span>
                )}
              </div>

              {data.degraded.length > 0 && (
                <div className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
                  Partial answer. Could not read {data.degraded.join(", ")}. The ranking below is
                  from the signals that did load.
                </div>
              )}

              {/* The first name is the answer to the question that was asked, so
                  it is given the room to be read as one rather than being row
                  one of a table. */}
              <div className={`${SURFACE.sheet} relative overflow-hidden mb-3`}>
                <span className="absolute inset-y-0 left-0 bg-ink/[0.07] dark:bg-ink/[0.12]"
                  style={{ width: "100%" }} aria-hidden="true" />
                <div className="relative p-5 flex items-center gap-4 flex-wrap">
                  <div className="relative shrink-0">
                    <UserAvatar login={top.login} size={52} />
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-white dark:ring-rule ${freshness(top.daysSinceActive)}`}
                      title={`Last active ${ago(top.daysSinceActive)}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="caps mb-0.5">
                      Ask first
                    </p>
                    <a href={`https://github.com/${top.login}`} target="_blank" rel="noopener noreferrer"
                      className="text-xl font-semibold tracking-tight text-slate-900 dark:text-ink hover:text-gh-blue break-all">
                      {top.login}
                    </a>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <Signals e={top} size="lg" sampled={data.sampled} />
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        last {ago(top.daysSinceActive)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-3xl font-semibold tabular-nums text-slate-900 dark:text-ink leading-none">
                      {top.score}
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">score</p>
                  </div>
                </div>
              </div>

              {rest.length > 0 && (
                <ul className="grid gap-1.5">
                  {rest.map((e, i) => (
                    <li key={e.login}
                      className={`${SURFACE.inset} relative overflow-hidden rounded-xl`}>
                      {/* The bar is the score. A number alone makes 91 and 34
                          look like neighbours in a list; a width does not. */}
                      <span className="absolute inset-y-0 left-0 bg-ink/[0.10] dark:bg-ink/[0.16] transition-[width] duration-500"
                        style={{ width: `${Math.max(2, e.score)}%` }} aria-hidden="true" />
                      <div className="relative px-4 py-2.5 flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-semibold tabular-nums text-slate-400 dark:text-slate-500 w-4 shrink-0">
                          {i + 2}
                        </span>
                        <div className="relative shrink-0">
                          <UserAvatar login={e.login} size={26} />
                          <span className={`absolute -bottom-px -right-px w-2.5 h-2.5 rounded-full ring-2 ring-slate-50 dark:ring-rule ${freshness(e.daysSinceActive)}`}
                            title={`Last active ${ago(e.daysSinceActive)}`} />
                        </div>
                        <a href={`https://github.com/${e.login}`} target="_blank" rel="noopener noreferrer"
                          className="text-sm font-bold text-slate-800 dark:text-slate-100 hover:text-gh-blue truncate">
                          {e.login}
                        </a>
                        <Signals e={e} sampled={data.sampled} />
                        <span className="ml-auto flex items-center gap-3 shrink-0">
                          <span className="text-xs text-slate-400 dark:text-slate-500">
                            {ago(e.daysSinceActive)}
                          </span>
                          <span className="text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200 w-8 text-right">
                            {e.score}
                          </span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 flex items-start gap-2 text-xs text-slate-400 dark:text-slate-500 max-w-3xl">
                <i className="ph ph-info mt-0.5 shrink-0"></i>
                <p className="leading-relaxed">
                  {data.sampled && (
                    <><strong className="font-semibold text-slate-500 dark:text-slate-400">
                      Ranked from the most recent 100 commits</strong>, GitHub returns one page,
                    so the counts above are floors rather than totals.{" "}</>
                  )}
                  Scores are relative to the top person, not absolute. Contributions halve in weight
                  every 90 days, so this ranks who is likely to remember rather than who has done
                  the most over all time. The dot is recency -{" "}
                  <span className="inline-block w-2 h-2 bg-forest align-middle" /> within a
                  month,{" "}
                  <span className="inline-block w-2 h-2 bg-ochre align-middle" /> within six,{" "}
                  <span className="inline-block w-2 h-2 rounded-full bg-rule-strong align-middle" /> longer
                  ago. Bot accounts are excluded.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
