import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Navbar from "../components/Navbar";
import BranchList from "../components/BranchList";
import { useAuth } from "../App";
import { apiGet } from "../api/client";
import type { Repo } from "../types/Repo";

export default function RepoPage() {
  const { repo } = useParams<{ repo: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: repos } = useQuery({
    queryKey: ["repos"],
    queryFn: () => apiGet<Repo[]>("/repos"),
    staleTime: 30_000,
  });

  const repoData = repos?.find((r) => r.name === repo);

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-6xl mx-auto px-6 py-8 animate-fade-in">
        
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-10">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => navigate("/")}
              className="w-9 h-9 flex items-center justify-center rounded-md border border-gh-border bg-white text-gh-textMuted hover:text-gh-textBase hover:bg-gray-50 shadow-sm transition-all active:scale-95" 
              title="Back to Repositories"
            >
              <i className="ph ph-arrow-left text-lg"></i>
            </button>
            <div className="flex items-baseline gap-3">
              {repoData ? (
                <>
                  <h1 className="text-3xl font-semibold tracking-tight text-gh-textBase">{repoData.name}</h1>
                  {repoData.private ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-orange-200 bg-orange-50 text-orange-700 shadow-sm">
                      <i className="ph-fill ph-lock-key mr-1.5 text-sm"></i> Private
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-gray-200 bg-white text-gray-700 shadow-sm">
                      <i className="ph ph-globe mr-1.5 text-sm"></i> Public
                    </span>
                  )}
                </>
              ) : (
                <div className="h-9 w-48 bg-gray-200 animate-pulse rounded"></div>
              )}
            </div>
          </div>
        </div>

        {repo && (
          <BranchList repo={repo} defaultBranch={repoData?.default_branch ?? "main"} />
        )}

      </main>
    </div>
  );
}
