import { useNavigate } from "react-router-dom";
import type { Repo } from "../types/Repo";

interface RepoCardProps {
  repo: Repo;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Unknown";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffHr = Math.floor(diffMs / 3600_000);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export default function RepoCard({ repo }: RepoCardProps) {
  const navigate = useNavigate();

  return (
    <article 
      onClick={() => navigate(`/repo/${repo.name}`)}
      className="repo-card group bg-white rounded-lg border border-gh-border p-5 cursor-pointer hover:border-gh-blue hover:-translate-y-[2px] hover:shadow-floating flex flex-col justify-between h-[180px] transition-all"
    >
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 overflow-hidden">
            {repo.private ? (
              <i className="ph ph-lock-key text-gray-500 text-lg flex-shrink-0"></i>
            ) : (
              <i className="ph ph-book-bookmark text-gray-500 text-lg flex-shrink-0"></i>
            )}
            <h3 className="font-bold text-gray-900 group-hover:text-gh-blue transition-colors truncate">
              {repo.name}
            </h3>
          </div>
          {repo.private ? (
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-[#d9b736] text-[#9a6700] bg-white flex-shrink-0">
              <i className="ph-fill ph-lock-key text-xs"></i> Private
            </span>
          ) : (
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200 text-gray-600 bg-white flex-shrink-0">
              <i className="ph ph-globe text-xs"></i> Public
            </span>
          )}
        </div>
        <p className="text-sm text-gh-textMuted line-clamp-2 leading-relaxed">
          {repo.description || "No description provided."}
        </p>
      </div>
      <div className="flex items-center gap-4 mt-4 text-xs font-medium">
        {repo.language ? (
          <span className="bg-gh-blue text-white px-2.5 py-1 rounded-full flex items-center gap-1 shadow-sm">
            {repo.language}
          </span>
        ) : (
          <span className="bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full flex items-center gap-1 shadow-sm border border-gray-200">
            Unknown
          </span>
        )}
        <span className="flex items-center gap-1.5 text-gray-500 truncate">
          <i className="ph ph-git-branch text-gray-400"></i> default: {repo.default_branch}
        </span>
        <span className="ml-auto text-gray-400 whitespace-nowrap hidden sm:block">
          Updated {timeAgo(repo.updated_at)}
        </span>
      </div>
    </article>
  );
}
