import { useState, useMemo } from "react";
import { useRepos } from "../hooks/useRepos";
import RepoCard from "./RepoCard";

export default function RepoList() {
  const { data: repos, isLoading, error } = useRepos();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!repos) return [];
    if (!search) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q)
    );
  }, [repos, search]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md">
        <p className="text-red-700">Failed to load repositories: {(error as Error).message}</p>
      </div>
    );
  }

  return (
    <>
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold text-gray-900">Repositories</h1>
          <span className="text-sm font-medium px-2.5 py-0.5 rounded-full bg-gray-200 text-gray-600">
            {filtered.length}
          </span>
        </div>

        <div className="relative group w-full md:w-80">
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <i className="ph ph-magnifying-glass text-gray-400 group-focus-within:text-gh-blue transition-colors"></i>
          </div>
          <input 
            type="text" 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block w-full p-2 pl-10 text-sm text-gray-900 border border-gray-300 rounded-md bg-white focus:ring-2 focus:ring-gh-blue/20 focus:border-gh-blue outline-none transition-all placeholder-gray-400 shadow-sm" 
            placeholder="Search repositories..." 
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-2">
            <kbd className="inline-flex items-center border border-gray-200 rounded px-1.5 text-[10px] font-sans font-medium text-gray-400">/</kbd>
          </div>
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gh-border border-dashed">
          <p className="text-gh-muted">No repositories found matching "{search}"</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((repo) => (
            <RepoCard key={repo.name} repo={repo} />
          ))}
        </div>
      )}
    </>
  );
}
