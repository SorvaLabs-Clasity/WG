import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import UserAvatar from "../components/UserAvatar";
import { useAuth } from "../App";
import { Page, PageHeader, StatusSlab, SlabPercent, SearchInput, Sheet, Empty, Spinner, TYPE, enter } from "../design";
import { useGraphNode } from "../hooks/useGraph";
import { useRepos, useRepoDetails } from "../hooks/useRepos";
import type { Repo, RepoDetails } from "../types/Repo";

// ── formatting helpers ────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(kb: number | undefined): string {
  if (!kb) return "0 KB";
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * A language's monogram, not its colour.
 *
 * The old version painted GitHub's language palette onto every row, eighteen
 * saturated hues on one page, none of which meant anything a reader could act
 * on. The printed page spends colour only on state, so a language is set as
 * two letters in a ruled box instead, which is just as recognisable down a
 * column and does not compete with the one crimson finding beside it.
 */
const LANGUAGE_HUES: Record<string, string> = {};

/**
 * Where a language sits on the ink ramp.
 *
 * A stacked language bar genuinely needs its segments told apart, so this keeps
 * a stable per-name value — but as a *tint of the page's own ink* rather than
 * as a hue. Printed charts have been set this way for a century, it survives
 * both editions without a second palette, and it leaves the four coloured inks
 * free to go on meaning something.
 */
function languageHue(name: string | null | undefined): string {
  if (!name) return "rgb(var(--ink-4))";
  if (LANGUAGE_HUES[name]) return LANGUAGE_HUES[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 1000;
  // Five steps, evenly spaced, so neighbouring segments never read as one.
  const step = h % 5;
  return `color-mix(in oklab, rgb(var(--ink)) ${88 - step * 17}%, rgb(var(--paper)))`;
}

type SortKey = "pushed" | "name" | "size";

// ── page ──────────────────────────────────────────────────────────────

export default function KnowledgeGraphPage() {
  const { user } = useAuth();
  const { data: repos, isLoading } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [visibility, setVisibility] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("pushed");

  const languages = useMemo(() => {
    const set = new Set<string>();
    repos?.forEach(r => { if (r.language) set.add(r.language); });
    return [...set].sort();
  }, [repos]);

  const orgStats = useMemo(() => ({
    total: repos?.length ?? 0,
    languages: languages.length,
    archived: repos?.filter(r => r.archived).length ?? 0,
    private: repos?.filter(r => r.private).length ?? 0,
  }), [repos, languages]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = search.trim().toLowerCase();
    const list = repos.filter(r => {
      if (!showArchived && r.archived) return false;
      if (language !== "all" && r.language !== language) return false;
      if (visibility === "private" && !r.private) return false;
      if (visibility === "public" && r.private) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);
    });
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "name": return a.name.localeCompare(b.name);
        case "size": return (b.size ?? 0) - (a.size ?? 0);
        default: {
          const at = new Date(a.pushed_at ?? a.updated_at ?? 0).getTime();
          const bt = new Date(b.pushed_at ?? b.updated_at ?? 0).getTime();
          return bt - at;
        }
      }
    });
  }, [repos, search, language, visibility, showArchived, sortKey]);

  const selectCls = "field-line text-[12.5px] !w-auto min-w-[9rem] flex-1 pr-4";

  return (
    <Page user={user}>
      <PageHeader
        title="Repositories"
        subtitle="Every repository in the organization, and everything worth knowing about each one."
      />

      <StatusSlab
        intent="info"
        eyebrow="Organization"
        metrics={[
          { value: orgStats.total, label: "repositories", emphasis: true },
          { value: orgStats.languages, label: "languages" },
          { value: orgStats.archived, label: "archived" },
        ]}
        aside={<SlabPercent value={orgStats.total ? Math.round((orgStats.private / orgStats.total) * 100) : 0} label="private" />}
        footer={<>{orgStats.private} private · {orgStats.total - orgStats.private} public</>}
      />

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_460px] gap-8 items-start">
          {/* Browser */}
          <div className="bg-paper border-t-2 border-ink">
            <div className="px-5 py-4 border-b border-rule space-y-4">
              <div className="flex items-baseline gap-2.5 border-b border-rule-strong focus-within:border-ink transition-colors">
                <i className="ph-bold ph-magnifying-glass text-ink-3 text-sm" aria-hidden="true"></i>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search repositories…"
                  className="w-full bg-transparent border-0 px-0 py-2 text-[14px] text-ink placeholder:text-ink-4 focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap items-baseline gap-5">
                <select value={language} onChange={e => setLanguage(e.target.value)} className={selectCls}>
                  <option value="all">All languages</option>
                  {languages.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
                <select value={visibility} onChange={e => setVisibility(e.target.value)} className={selectCls}>
                  <option value="all">All visibility</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
                <select value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)} className={selectCls}>
                  <option value="pushed">Recently pushed</option>
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                </select>
                <label className="caps flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="accent-ink w-3.5 h-3.5" />
                  Show archived
                </label>
                <span className="ml-auto figure text-[0.8125rem] text-ink-3">{filtered.length} shown</span>
              </div>
            </div>

            <div className="max-h-[calc(100vh-300px)] overflow-y-auto divide-y divide-rule">
              {isLoading ? (
                <Spinner label="Reading the repositories" />
              ) : filtered.length === 0 ? (
                <p className="standfirst p-12 text-center text-[14px]">
                  No repositories match those filters.
                </p>
              ) : filtered.map(r => (
                <RepoRow key={r.name} repo={r} selected={selectedRepo === r.name} onSelect={() => setSelectedRepo(r.name)} />
              ))}
            </div>
          </div>

          {/* Panel */}
          {selectedRepo ? (
            <RepoPanel repo={selectedRepo} onClose={() => setSelectedRepo(null)} />
          ) : (
            <div className="bg-white dark:bg-paper rounded-2xl border border-slate-100 dark:border-rule shadow-sm p-10 text-center sticky top-20">
              <i className="ph-fill ph-cards-three text-4xl text-slate-300 dark:text-slate-600 mb-3 block"></i>
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Select a repository</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Its languages, activity, people, branches, workflows and settings appear here.
              </p>
            </div>
          )}
        </div>
    </Page>
  );
}

// ── list row ──────────────────────────────────────────────────────────

function RepoRow({ repo, selected, onSelect }: { repo: Repo; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-5 py-4 transition-colors border-l-[3px] ${
        selected ? "bg-ink/[0.05] border-ink" : "border-transparent hover:bg-ink/[0.035]"}`}
    >
      <div className="flex items-start gap-3.5">
        {/* Language swatch, sized to anchor the row rather than punctuate it. */}
        <span className="w-9 h-9 shrink-0 grid place-items-center border border-rule-strong caps caps-tight text-ink mt-0.5"
          title={repo.language ?? "No language"}>
          {(repo.language ?? repo.name).slice(0, 2).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="display text-[1.125rem] text-ink truncate">{repo.name}</span>
            {repo.private && <i className="ph-fill ph-lock-simple text-xs text-slate-400 dark:text-slate-500 shrink-0" title="Private"></i>}
            {repo.fork && <i className="ph-bold ph-git-fork text-xs text-slate-400 dark:text-slate-500 shrink-0" title="Fork"></i>}
            {repo.archived && (
              <span className="caps px-1.5 py-0.5 bg-slate-200 shrink-0">
                archived
              </span>
            )}
          </div>

          {repo.description && (
            <p className="standfirst text-[13px] line-clamp-2 mt-1.5">{repo.description}</p>
          )}

          <div className="dateline mt-2">
            {repo.language && <span>{repo.language}</span>}
            <span>{formatSize(repo.size)}</span>
            <span className="ml-auto shrink-0 before:content-none">{relativeTime(repo.pushed_at ?? repo.updated_at)}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

// ── detail panel ──────────────────────────────────────────────────────

function RepoPanel({ repo, onClose }: { repo: string; onClose: () => void }) {
  const { data, isLoading, error } = useRepoDetails(repo);
  // Teams and collaborators come free from the already-aggregated graph edges.
  const { data: nodeData } = useGraphNode(`REPO#${repo}`);

  const people = useMemo(() => {
    // These are GitHub's *collaborators*, which is a question about who can
    // reach the repository and not about who has worked on it. The distinction
    // was invisible here: an organization owner holds admin on every repository
    // in the organization without ever having touched one, and this listed them
    // beside somebody deliberately given write access, in the same shape, under
    // a heading that reads as "people who worked on this". Commits are answered
    // by "Top contributors" below, and by the Who knows tab.
    const collaborators: { name: string; role: string; source?: string }[] = [];
    const teams: { name: string; permission?: string }[] = [];
    nodeData?.edges.forEach(e => {
      if (e.target.startsWith("USER#")) {
        collaborators.push({
          name: e.target.replace("USER#", ""),
          role: e.metadata?.role || "read",
          // `direct`, `team` or `org_owner`. Stored on every collaborator edge
          // and, until now, thrown away before anyone could see it.
          source: e.metadata?.source,
        });
      }
      else if (e.target.startsWith("TEAM#")) teams.push({ name: e.target.replace("TEAM#", ""), permission: e.metadata?.permission });
    });
    const order: Record<string, number> = { admin: 0, maintain: 1, write: 2, triage: 3, read: 4 };
    // Blanket access sorts last whatever its role. An org owner outranks
    // everybody on paper and tells you the least about this repository, so
    // leading with them buries the people the access was actually granted to.
    const bySource: Record<string, number> = { direct: 0, team: 1, org_owner: 2 };
    collaborators.sort((a, b) =>
      (bySource[a.source ?? ""] ?? 1) - (bySource[b.source ?? ""] ?? 1)
      || (order[a.role] ?? 5) - (order[b.role] ?? 5)
      || a.name.localeCompare(b.name));
    teams.sort((a, b) => a.name.localeCompare(b.name));
    // Counted for the tile: people granted access to *this* repository, rather
    // than everyone who can open it by virtue of running the organization.
    const specific = collaborators.filter(c => c.source !== "org_owner").length;
    return { collaborators, teams, specific };
  }, [nodeData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-paper rounded-2xl border border-slate-100 dark:border-rule shadow-sm p-10 flex justify-center sticky top-20">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 dark:border-rule border-t-slate-600 dark:border-t-slate-300"></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white dark:bg-paper rounded-2xl border border-slate-100 dark:border-rule shadow-sm p-8 text-center sticky top-20">
        <i className="ph-fill ph-warning-circle text-3xl text-slate-300 dark:text-slate-600 mb-2 block"></i>
        <p className="text-sm text-slate-600 dark:text-slate-300">Couldn't load details for {repo}</p>
        <button onClick={onClose} className="textlink caps !text-indigo mt-3">Close</button>
      </div>
    );
  }

  const tiles = [
    { label: "Branches", value: data.branches?.length ?? "-" },
    // Was `collaborators.length`, which counted every organization owner on
    // every repository and so read the same on all of them.
    { label: "With access", value: people.specific || people.collaborators.length || data.contributorCount || "-" },
    { label: "Open PRs", value: data.openPullRequests?.count ?? "-" },
    { label: "Teams", value: people.teams.length },
    { label: "Commits 30d", value: data.commitsLast30Days ?? "-" },
  ];

  return (
    <div className="bg-paper border border-rule animate-scale-in flex flex-col max-h-[calc(100vh-160px)] sticky top-[7rem]">
      {/* Header */}
      <span className="block h-[3px] w-full bg-ink" aria-hidden="true" />
      <div className="px-5 py-4 border-b border-rule">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-3 min-w-0">
            {/* The same monogram the list rows carry, so the panel and the row
                it was opened from are recognisably the same thing. */}
            <div className="w-10 h-10 flex items-center justify-center shrink-0 border border-rule-strong caps caps-tight text-ink">
              {(data.languages?.[0]?.name ?? data.name).slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h3 className="display text-[1.1875rem] text-ink truncate" title={data.name}>{data.name}</h3>
              <div className="flex items-center flex-wrap gap-1.5 mt-1">
                <Pill>{data.visibility}</Pill>
                {data.languages?.[0] && <Pill>{data.languages[0].name}</Pill>}
                {data.license && <Pill>{data.license}</Pill>}
                <Pill>{formatSize(data.size_kb)}</Pill>
                {data.archived && <Pill tone="muted">archived</Pill>}
                {data.fork && <Pill tone="muted">fork</Pill>}
                {data.is_template && <Pill tone="muted">template</Pill>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="textlink caps shrink-0">Close</button>
        </div>

        {data.description && <p className="standfirst text-[12.5px] mb-3">{data.description}</p>}
        {data.topics.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {data.topics.map(t => (
              <span key={t} className="font-mono text-[11px] px-1.5 py-0.5 bg-paper-2 text-ink-2 border border-rule">#{t}</span>
            ))}
          </div>
        )}

        {/* Readings side by side, divided by column rules, the way a results
            table is set — not five boxed tiles pretending to be five cards. */}
        <div className="grid grid-cols-3 border-t border-rule pt-3">
          {tiles.map((t, i) => (
            <div key={t.label} className={`py-1 ${i % 3 === 0 ? "" : "pl-3 border-l border-rule"}`}>
              <div className="figure text-[1.375rem] text-ink">{t.value}</div>
              <div className="caps caps-tight mt-1.5">{t.label}</div>
            </div>
          ))}
        </div>

        <a href={data.html_url} target="_blank" rel="noreferrer" className="textlink caps mt-4 inline-block">
          Open on GitHub →
        </a>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-rule">
        <Section label="Overview" icon="ph-info" color="slate" count={0} defaultOpen>
          <Facts rows={[
            ["Default branch", data.default_branch],
            ["Created", formatDate(data.created_at)],
            ["Last push", `${formatDate(data.pushed_at)} (${relativeTime(data.pushed_at)})`],
            ["Last update", `${formatDate(data.updated_at)} (${relativeTime(data.updated_at)})`],
            ["Stars / forks / watchers", `${data.stargazers_count} / ${data.forks_count} / ${data.watchers_count}`],
          ]} />
        </Section>

        {data.languages && data.languages.length > 0 && (
          <Section label="Languages" icon="ph-code" color="blue" count={data.languages.length} defaultOpen>
            <div className="flex h-[6px] overflow-hidden mb-4 border border-rule">
              {data.languages.map(l => (
                <div key={l.name} style={{ width: `${l.percent}%`, backgroundColor: languageHue(l.name) }} title={`${l.name} ${l.percent}%`} />
              ))}
            </div>
            {data.languages.map(l => (
              <div key={l.name} className="flex items-center justify-between py-1">
                <span className="flex items-center gap-2.5 text-[13.5px] text-ink">
                  <span className="w-2.5 h-2.5 shrink-0" style={{ backgroundColor: languageHue(l.name) }}></span>
                  {l.name}
                </span>
                <span className="figure text-[0.8125rem] text-ink-2">{l.percent}%</span>
              </div>
            ))}
          </Section>
        )}

        <Section label="Activity" icon="ph-pulse" color="emerald" count={0} defaultOpen>
          <Facts rows={[
            ["Commits (30d)", data.commitsLast30Days ?? "-"],
            ["Open pull requests", data.openPullRequests?.count ?? "-"],
            ["Oldest open PR", data.openPullRequests?.oldest
              ? `#${data.openPullRequests.oldest.number}, ${relativeTime(data.openPullRequests.oldest.createdAt)}`
              : "none"],
            ["Latest release", data.latestRelease
              ? `${data.latestRelease.tag} (${relativeTime(data.latestRelease.publishedAt)})`
              : "none"],
            ["Total releases", data.releaseCount ?? "-"],
          ]} />
          {data.openPullRequests?.oldest && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 truncate" title={data.openPullRequests.oldest.title}>
              “{data.openPullRequests.oldest.title}”: {data.openPullRequests.oldest.author ?? "unknown"}
            </p>
          )}
        </Section>

        {people.collaborators.length > 0 && (
          /* "People with access", not "Collaborators", the list answers who
             can reach this repository, and the old heading was read as who
             worked on it. */
          <Section label="People with access" icon="ph-key" color="violet" count={people.collaborators.length} defaultOpen={people.collaborators.length <= 8}>
            {people.collaborators.map(c => (
              <div key={c.name} className="flex items-center justify-between py-1.5 gap-2">
                <span className="text-sm text-slate-700 dark:text-slate-300 truncate">{c.name}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <Pill tone="muted">{c.role}</Pill>
                  {/* How they got it. Without this an organization-wide grant
                      is indistinguishable from access somebody chose to give
                      for this repository in particular. */}
                  {c.source === "org_owner" && <Pill tone="muted">org owner</Pill>}
                  {c.source === "team" && <Pill tone="muted">via team</Pill>}
                  {c.source === "direct" && <Pill tone="muted">direct</Pill>}
                </span>
              </div>
            ))}
            <p className="pt-2 text-xs text-slate-500 dark:text-slate-400">
              Who can reach this repository. Not who has worked on it. Organization
              owners hold admin on every repository whether or not they have ever
              opened this one. For commits, see Top contributors below.
            </p>
          </Section>
        )}

        {people.teams.length > 0 && (
          <Section label="Teams" icon="ph-users-three" color="purple" count={people.teams.length} defaultOpen={people.teams.length <= 8}>
            {people.teams.map(t => (
              <div key={t.name} className="flex items-center justify-between py-1.5">
                <span className="text-sm text-slate-700 dark:text-slate-300">{t.name}</span>
                {t.permission && <Pill tone="muted">{t.permission}</Pill>}
              </div>
            ))}
          </Section>
        )}

        <WhoKnows repo={repo} />

        {data.contributors && data.contributors.length > 0 && (
          <Section label="Top contributors" icon="ph-trophy" color="amber" count={data.contributorCount ?? data.contributors.length} defaultOpen={false}>
            {data.contributors.map(c => (
              <div key={c.login} className="flex items-center justify-between py-1.5">
                <span className="text-sm text-slate-700 dark:text-slate-300">{c.login}</span>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{c.contributions} commits</span>
              </div>
            ))}
          </Section>
        )}

        {data.branches && data.branches.length > 0 && (
          <Section label="Branches" icon="ph-git-branch" color="blue" count={data.branches.length} defaultOpen={data.branches.length <= 8}>
            {data.branches.map(b => (
              <div key={b.name} className="flex items-center justify-between py-1.5 gap-2">
                <span className="text-sm text-slate-700 dark:text-slate-300 font-mono truncate">{b.name}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {b.isDefault && <Pill tone="muted">default</Pill>}
                  {b.protected && <Pill tone="good">protected</Pill>}
                </span>
              </div>
            ))}
          </Section>
        )}

        {data.workflows && data.workflows.length > 0 && (
          <Section label="Workflows" icon="ph-gear-six" color="teal" count={data.workflows.length} defaultOpen={false}>
            {data.workflows.map(w => (
              <div key={w.path} className="flex items-center justify-between py-1.5 gap-2">
                <span className="min-w-0">
                  <span className="text-sm text-slate-700 dark:text-slate-300 block truncate">{w.name}</span>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono block truncate">{w.path}</span>
                </span>
                <Pill tone={w.state === "active" ? "good" : "muted"}>{w.state}</Pill>
              </div>
            ))}
          </Section>
        )}

        {data.environments && data.environments.length > 0 && (
          <Section label="Environments" icon="ph-cloud" color="cyan" count={data.environments.length} defaultOpen={false}>
            {data.environments.map(e => (
              <div key={e} className="py-1.5 text-sm text-slate-700 dark:text-slate-300 font-mono">{e}</div>
            ))}
          </Section>
        )}

        <Section label="Repo hygiene" icon="ph-checks" color="indigo" count={0} defaultOpen={false}>
          {([
            ["README", data.hygiene.hasReadme],
            ["LICENSE", data.hygiene.hasLicense],
            ["CODEOWNERS", data.hygiene.hasCodeowners],
            ["Description", data.hygiene.hasDescription],
            ["Topics", data.hygiene.hasTopics],
          ] as [string, boolean][]).map(([label, present]) => (
            <div key={label} className="flex items-center justify-between py-1.5">
              <span className="text-sm text-slate-700 dark:text-slate-300">{label}</span>
              <i className={present
                ? "ph-fill ph-check-circle text-emerald-500"
                : "ph-fill ph-minus-circle text-slate-300 dark:text-slate-600"}></i>
            </div>
          ))}
        </Section>

        <Section label="Merge settings" icon="ph-git-merge" color="rose" count={0} defaultOpen={false}>
          <Facts rows={[
            ["Squash merge", yesNo(data.mergeSettings.allowSquashMerge)],
            ["Merge commit", yesNo(data.mergeSettings.allowMergeCommit)],
            ["Rebase merge", yesNo(data.mergeSettings.allowRebaseMerge)],
            ["Auto-merge", yesNo(data.mergeSettings.allowAutoMerge)],
            ["Delete branch on merge", yesNo(data.mergeSettings.deleteBranchOnMerge)],
          ]} />
        </Section>
      </div>
    </div>
  );
}

function yesNo(v: boolean | null): string {
  return v === null ? "-" : v ? "Enabled" : "Disabled";
}

// ── small building blocks ─────────────────────────────────────────────

function Pill({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "muted" | "good" }) {
  const cls = tone === "good"
    ? "bg-forest-wash text-forest border-forest-edge"
    : tone === "muted"
      ? "bg-paper-2 text-ink-3 border-rule"
      : "bg-paper-2 text-ink-2 border-rule";
  return <span className={`caps caps-tight px-1.5 py-0.5 border shrink-0 ${cls}`}>{children}</span>;
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-rule border-t border-rule">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="caps shrink-0">{k}</dt>
          <dd className="text-[13px] text-ink text-right font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Who to ask about this repository, in the panel rather than in its own tab.
 *
 * The scoring already exists and is already reachable, from a separate screen
 * you have to think to go to, which makes it something people use during an
 * incident and never otherwise. The question "who do I ask about this" arrives
 * while you are looking at the repository, so the answer belongs here.
 *
 * Collapsed by default and only fetched when opened. It reads GitHub live,
 * three requests for commits, review comments and issue comments, and paying
 * that on every repository somebody clicks would make the panel slow for a
 * question most opens do not have.
 */
function WhoKnows({ repo }: { repo: string }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching, error } = useQuery<{
    experts: { login: string; score: number; commits: number; reviews: number; daysSinceActive: number | null }[];
    degraded: string[];
    sampled?: boolean;
  }>({
    queryKey: ["expertise", "repo", repo],
    queryFn: () => apiGet(`/expertise/repo/${encodeURIComponent(repo)}`),
    enabled: open,
    staleTime: 300_000,
    retry: false,
  });

  return (
    <div className="border-t border-slate-100 dark:border-rule">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 py-2.5 text-left"
      >
        <i className={`ph-fill ph-users-three text-violet-500 text-base`}></i>
        <span className="text-[13px] font-bold text-slate-700 dark:text-slate-200">Who knows this</span>
        <i className={`ph-bold ph-caret-down ml-auto text-[11px] text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}></i>
      </button>

      {open && (
        <div className="pb-3">
          {isFetching && <div className="py-3 text-[12.5px] text-slate-400">Reading commits and reviews…</div>}

          {!!error && (
            <p className="py-2 text-[12.5px] text-amber-700 dark:text-amber-500">
              {(error as Error)?.message ?? "Could not work out who knows this."}
            </p>
          )}

          {data && !isFetching && data.experts.length === 0 && (
            <p className="py-2 text-[12.5px] text-slate-500 dark:text-slate-400">
              Nobody has committed, reviewed or commented here recently enough to rank.
            </p>
          )}

          {data && !isFetching && data.experts.map((e) => (
            <div key={e.login} className="flex items-center gap-2.5 py-1.5">
              <UserAvatar login={e.login} size={20} />
              <span className="text-sm text-slate-700 dark:text-slate-300 truncate">{e.login}</span>
              <span className="ml-auto flex items-center gap-2 shrink-0">
                {/* Recency is the point of the scoring, so it is on the row.
                    Somebody who owned this two years ago is a worse answer than
                    somebody with four commits last week. */}
                {e.daysSinceActive !== null && (
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                    {e.daysSinceActive === 0 ? "today" : `${e.daysSinceActive}d ago`}
                  </span>
                )}
                <span className="w-10 h-1.5  bg-slate-200 dark:bg-paper-3 overflow-hidden">
                  <span className="block h-full bg-violet-500" style={{ width: `${e.score}%` }} />
                </span>
              </span>
            </div>
          ))}

          {/* One page from GitHub, so a hundred means "at least a hundred". */}
          {data?.sampled && (
            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              Based on the most recent page of activity, so this is a sample rather than a full count.
            </p>
          )}
          {(data?.degraded?.length ?? 0) > 0 && (
            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">
              Could not read: {data!.degraded.join(", ")}. The ranking is from what was readable.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, icon, color, count, defaultOpen, children }: {
  label: string; icon: string; color: string; count: number; defaultOpen: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const MAX_VISIBLE = 15;
  const [showAll, setShowAll] = useState(false);

  const childArray = Array.isArray(children) ? children.flat() : [children];
  const collapsible = count > 0 && childArray.length > MAX_VISIBLE;
  const visible = collapsible && !showAll ? childArray.slice(0, MAX_VISIBLE) : childArray;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-baseline justify-between gap-4 border-t border-rule hover:bg-ink/[0.035] transition-colors"
      >
        <span className="flex items-baseline gap-2.5">
          <i className={`ph-bold ${icon} text-[13px] text-ink-3`} aria-hidden="true"></i>
          <span className="caps text-ink">{label}</span>
        </span>
        <span className="flex items-baseline gap-3">
          {count > 0 && <span className="figure text-[0.875rem] text-ink-3">{count}</span>}
          <span aria-hidden="true" className="text-[8px] text-ink-3">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="px-5 pb-3">
          <div>{visible}</div>
          {collapsible && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="textlink caps !text-indigo mt-2"
            >
              {showAll ? "Show less" : `Show all ${count} (${count - MAX_VISIBLE} more)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
