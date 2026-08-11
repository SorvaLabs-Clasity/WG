import { useState, useMemo } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useGraphNode } from "../hooks/useGraph";
import { useRepos, useRepoDetails } from "../hooks/useRepos";
import type { Repo, RepoDetails } from "../types/Repo";

// ── formatting helpers ────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
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
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(kb: number | undefined): string {
  if (!kb) return "0 KB";
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

/** Stable colour per language so the same language reads the same everywhere. */
const LANGUAGE_HUES: Record<string, string> = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", Go: "#00ADD8",
  Java: "#b07219", Ruby: "#701516", Rust: "#dea584", "C#": "#178600", C: "#555555",
  "C++": "#f34b7d", PHP: "#4F5D95", Swift: "#F05138", Kotlin: "#A97BFF",
  Shell: "#89e051", HTML: "#e34c26", CSS: "#563d7c", Vue: "#41b883", Dart: "#00B4AB",
};
function languageHue(name: string | null | undefined): string {
  if (!name) return "#94a3b8";
  if (LANGUAGE_HUES[name]) return LANGUAGE_HUES[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 55%)`;
}

type SortKey = "pushed" | "name" | "size" | "issues";

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
        case "issues": return (b.open_issues_count ?? 0) - (a.open_issues_count ?? 0);
        default: {
          const at = new Date(a.pushed_at ?? a.updated_at ?? 0).getTime();
          const bt = new Date(b.pushed_at ?? b.updated_at ?? 0).getTime();
          return bt - at;
        }
      }
    });
  }, [repos, search, language, visibility, showArchived, sortKey]);

  const selectCls = "text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <div className="min-h-screen pt-14 bg-slate-50 dark:bg-slate-950">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-[1600px] mx-auto px-6 py-6">
        {/* Header */}
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Repo Knowledge Center</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Browse every repository in the organization and inspect its full profile.
          </p>
        </div>

        {/* Org summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          {[
            { label: "Repositories", value: orgStats.total, icon: "ph-git-repository" },
            { label: "Languages", value: orgStats.languages, icon: "ph-code" },
            { label: "Private", value: orgStats.private, icon: "ph-lock-simple" },
            { label: "Archived", value: orgStats.archived, icon: "ph-archive" },
          ].map(s => (
            <div key={s.label} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700 px-4 py-3 flex items-center gap-3">
              <i className={`ph-fill ${s.icon} text-lg text-slate-400 dark:text-slate-500`}></i>
              <div>
                <div className="text-xl font-bold text-slate-900 dark:text-white font-mono leading-none">{s.value}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_460px] gap-5 items-start">
          {/* Browser */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 space-y-3">
              <div className="relative">
                <i className="ph-bold ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-sm"></i>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search repositories…"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
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
                  <option value="issues">Open issues</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
                  <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="rounded border-slate-300 dark:border-slate-600" />
                  Show archived
                </label>
                <span className="ml-auto text-xs text-slate-400 dark:text-slate-500 font-mono">{filtered.length} shown</span>
              </div>
            </div>

            <div className="max-h-[calc(100vh-330px)] overflow-y-auto divide-y divide-slate-50 dark:divide-slate-800">
              {isLoading ? (
                <div className="p-10 flex justify-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 dark:border-slate-700 border-t-slate-600 dark:border-t-slate-300"></div>
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-10 text-center text-slate-400 dark:text-slate-500">
                  <i className="ph-fill ph-magnifying-glass text-3xl mb-2 block"></i>
                  <p className="text-sm">No repositories match those filters.</p>
                </div>
              ) : filtered.map(r => (
                <RepoRow key={r.name} repo={r} selected={selectedRepo === r.name} onSelect={() => setSelectedRepo(r.name)} />
              ))}
            </div>
          </div>

          {/* Panel */}
          {selectedRepo ? (
            <RepoPanel repo={selectedRepo} onClose={() => setSelectedRepo(null)} />
          ) : (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-10 text-center sticky top-20">
              <i className="ph-fill ph-cards-three text-4xl text-slate-300 dark:text-slate-600 mb-3 block"></i>
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Select a repository</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Its languages, activity, people, branches, workflows and settings appear here.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── list row ──────────────────────────────────────────────────────────

function RepoRow({ repo, selected, onSelect }: { repo: Repo; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-5 py-3 transition-colors ${selected ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"}`}
    >
      <div className="flex items-start gap-3">
        <span className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: languageHue(repo.language) }} title={repo.language ?? "No language"}></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{repo.name}</span>
            {repo.private && <i className="ph-fill ph-lock-simple text-[11px] text-slate-400 dark:text-slate-500" title="Private"></i>}
            {repo.archived && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">Archived</span>}
            {repo.fork && <i className="ph-bold ph-git-fork text-[11px] text-slate-400 dark:text-slate-500" title="Fork"></i>}
          </div>
          {repo.description && (
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{repo.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 dark:text-slate-500 font-mono">
            {repo.language && <span>{repo.language}</span>}
            <span>{formatSize(repo.size)}</span>
            {!!repo.open_issues_count && <span>{repo.open_issues_count} issues</span>}
            <span>pushed {relativeTime(repo.pushed_at ?? repo.updated_at)}</span>
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
    const collaborators: { name: string; role: string }[] = [];
    const teams: { name: string; permission?: string }[] = [];
    nodeData?.edges.forEach(e => {
      if (e.target.startsWith("USER#")) collaborators.push({ name: e.target.replace("USER#", ""), role: e.metadata?.role || "read" });
      else if (e.target.startsWith("TEAM#")) teams.push({ name: e.target.replace("TEAM#", ""), permission: e.metadata?.permission });
    });
    const order: Record<string, number> = { admin: 0, maintain: 1, write: 2, triage: 3, read: 4 };
    collaborators.sort((a, b) => (order[a.role] ?? 5) - (order[b.role] ?? 5));
    teams.sort((a, b) => a.name.localeCompare(b.name));
    return { collaborators, teams };
  }, [nodeData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-10 flex justify-center sticky top-20">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 dark:border-slate-700 border-t-slate-600 dark:border-t-slate-300"></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-8 text-center sticky top-20">
        <i className="ph-fill ph-warning-circle text-3xl text-slate-300 dark:text-slate-600 mb-2 block"></i>
        <p className="text-sm text-slate-600 dark:text-slate-300">Couldn't load details for {repo}</p>
        <button onClick={onClose} className="mt-3 text-xs text-blue-600 dark:text-blue-400 font-medium">Close</button>
      </div>
    );
  }

  const tiles = [
    { label: "Branches", value: data.branches?.length ?? "—" },
    { label: "People", value: people.collaborators.length || data.contributorCount || "—" },
    { label: "Open PRs", value: data.openPullRequests?.count ?? "—" },
    { label: "Issues", value: data.open_issues_count },
    { label: "Teams", value: people.teams.length },
    { label: "Commits 30d", value: data.commitsLast30Days ?? "—" },
  ];

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden animate-scale-in flex flex-col max-h-[calc(100vh-160px)] sticky top-20">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-white dark:from-slate-800 dark:to-slate-900">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-sm text-white" style={{ backgroundColor: languageHue(data.languages?.[0]?.name) }}>
              <i className="ph-fill ph-git-repository text-lg"></i>
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 dark:text-white truncate" title={data.name}>{data.name}</h3>
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
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors p-1 -mr-1 shrink-0">
            <i className="ph-bold ph-x text-lg"></i>
          </button>
        </div>

        {data.description && <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{data.description}</p>}
        {data.topics.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {data.topics.map(t => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-900">#{t}</span>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {tiles.map(t => (
            <div key={t.label} className="bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700 px-2 py-2 text-center">
              <div className="text-base font-bold text-slate-900 dark:text-white font-mono leading-none">{t.value}</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium mt-1">{t.label}</div>
            </div>
          ))}
        </div>

        <a href={data.html_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium">
          <i className="ph-bold ph-arrow-square-out"></i> Open on GitHub
        </a>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700">
        <Section label="Overview" icon="ph-info" color="slate" count={0} defaultOpen>
          <Facts rows={[
            ["Default branch", data.default_branch],
            ["Created", formatDate(data.created_at)],
            ["Last push", `${formatDate(data.pushed_at)} (${relativeTime(data.pushed_at)})`],
            ["Last update", `${formatDate(data.updated_at)} (${relativeTime(data.updated_at)})`],
            ["Homepage", data.homepage ?? "—"],
            ["Stars / forks / watchers", `${data.stargazers_count} / ${data.forks_count} / ${data.watchers_count}`],
            ["Features", [
              data.features.issues && "issues", data.features.projects && "projects",
              data.features.wiki && "wiki", data.features.pages && "pages",
              data.features.discussions && "discussions",
            ].filter(Boolean).join(", ") || "none enabled"],
          ]} />
        </Section>

        {data.languages && data.languages.length > 0 && (
          <Section label="Languages" icon="ph-code" color="blue" count={data.languages.length} defaultOpen>
            <div className="flex h-2 rounded-full overflow-hidden mb-3">
              {data.languages.map(l => (
                <div key={l.name} style={{ width: `${l.percent}%`, backgroundColor: languageHue(l.name) }} title={`${l.name} ${l.percent}%`} />
              ))}
            </div>
            {data.languages.map(l => (
              <div key={l.name} className="flex items-center justify-between py-1">
                <span className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: languageHue(l.name) }}></span>
                  {l.name}
                </span>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{l.percent}%</span>
              </div>
            ))}
          </Section>
        )}

        <Section label="Activity" icon="ph-pulse" color="emerald" count={0} defaultOpen>
          <Facts rows={[
            ["Commits (30d)", data.commitsLast30Days ?? "—"],
            ["Open pull requests", data.openPullRequests?.count ?? "—"],
            ["Oldest open PR", data.openPullRequests?.oldest
              ? `#${data.openPullRequests.oldest.number} — ${relativeTime(data.openPullRequests.oldest.createdAt)}`
              : "none"],
            ["Open issues", data.open_issues_count],
            ["Latest release", data.latestRelease
              ? `${data.latestRelease.tag} (${relativeTime(data.latestRelease.publishedAt)})`
              : "none"],
            ["Total releases", data.releaseCount ?? "—"],
          ]} />
          {data.openPullRequests?.oldest && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 truncate" title={data.openPullRequests.oldest.title}>
              “{data.openPullRequests.oldest.title}” — {data.openPullRequests.oldest.author ?? "unknown"}
            </p>
          )}
        </Section>

        {people.collaborators.length > 0 && (
          <Section label="Collaborators" icon="ph-user" color="violet" count={people.collaborators.length} defaultOpen={people.collaborators.length <= 8}>
            {people.collaborators.map(c => (
              <div key={c.name} className="flex items-center justify-between py-1.5">
                <span className="text-sm text-slate-700 dark:text-slate-300">{c.name}</span>
                <Pill tone="muted">{c.role}</Pill>
              </div>
            ))}
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
  return v === null ? "—" : v ? "Enabled" : "Disabled";
}

// ── small building blocks ─────────────────────────────────────────────

function Pill({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "muted" | "good" }) {
  const cls = tone === "good"
    ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
    : tone === "muted"
      ? "bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"
      : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${cls}`}>{children}</span>;
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-50 dark:divide-slate-800">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-start justify-between gap-3 py-1.5">
          <dt className="text-sm text-slate-500 dark:text-slate-400 shrink-0">{k}</dt>
          <dd className="text-sm text-slate-700 dark:text-slate-300 text-right font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
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
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          <i className={`ph-fill ${icon} text-${color}-500`}></i>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          {count > 0 && (
            <span className="text-xs font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">{count}</span>
          )}
          <i className={`ph-bold ph-caret-${open ? "up" : "down"} text-xs text-slate-400 dark:text-slate-500`}></i>
        </div>
      </button>
      {open && (
        <div className="px-5 pb-3">
          <div>{visible}</div>
          {collapsible && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
            >
              {showAll ? "Show less" : `Show all ${count} (${count - MAX_VISIBLE} more)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
