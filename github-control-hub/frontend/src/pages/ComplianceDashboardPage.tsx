import React, { useState } from "react";
import { useComplianceDashboard } from "../hooks/useCompliance";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";

export default function ComplianceDashboardPage() {
  const { data: scores, isLoading } = useComplianceDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const { user } = useAuth();

  if (isLoading) {
    return (
      <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-8 flex justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-gh-blue border-t-transparent rounded-full"></div>
        </div>
      </div>
    );
  }

  const filteredScores = (scores || []).filter((s) =>
    s.repo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const averageScore = scores && scores.length > 0 
    ? Math.round(scores.reduce((acc, curr) => acc + curr.score, 0) / scores.length) 
    : 0;

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-6xl mx-auto p-4 sm:p-8 animate-fade-in">
        <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold text-gh-textBase flex items-center gap-2">
            <i className="ph-fill ph-check-square-offset text-gh-textMuted"></i>
            Repo Compliance Dashboard
          </h1>
          <p className="text-gh-muted text-sm mt-1">
            Overview of repository security posture, required files, and external access.
          </p>
        </div>

        <div className="bg-white px-6 py-3 rounded-xl border border-gh-border shadow-sm flex items-center gap-4">
          <div>
            <p className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-1">Average Score</p>
            <div className="flex items-end gap-2">
              <span className={`text-3xl font-bold ${averageScore >= 90 ? 'text-green-600' : averageScore >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                {averageScore}
              </span>
              <span className="text-sm font-medium text-gh-muted mb-1">/ 100</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gh-border bg-gray-50 flex justify-between items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <input
              type="text"
              placeholder="Search repositories..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-colors"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 font-semibold text-gh-textMuted">Repository</th>
                <th className="px-6 py-3 font-semibold text-gh-textMuted">Score</th>
                <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Protections</th>
                <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Rulesets</th>
                <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Required Files</th>
                <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Outside Collabs</th>
                <th className="px-6 py-3 font-semibold text-gh-textMuted">Issues</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {filteredScores.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-gh-muted">
                    No repositories found matching your search.
                  </td>
                </tr>
              ) : (
                filteredScores.map((scoreInfo) => (
                  <tr key={scoreInfo.repo} className="hover:bg-gray-50 transition-colors group">
                    <td className="px-6 py-4 font-bold text-gh-textBase">
                      <div className="flex items-center gap-2">
                        <i className="ph ph-git-repository text-gh-muted"></i>
                        {scoreInfo.repo}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full ${scoreInfo.score >= 90 ? 'bg-green-500' : scoreInfo.score >= 70 ? 'bg-yellow-500' : 'bg-red-500'}`} 
                            style={{ width: `${scoreInfo.score}%` }}
                          />
                        </div>
                        <span className={`font-bold ${scoreInfo.score >= 90 ? 'text-green-600' : scoreInfo.score >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {scoreInfo.score}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      {scoreInfo.protectionsActive ? (
                        <i className="ph-fill ph-check-circle text-green-500 text-lg"></i>
                      ) : (
                        <i className="ph-fill ph-x-circle text-red-500 text-lg"></i>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {scoreInfo.rulesetsActive ? (
                        <i className="ph-fill ph-check-circle text-green-500 text-lg"></i>
                      ) : (
                        <i className="ph-fill ph-x-circle text-red-500 text-lg"></i>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {scoreInfo.hasRequiredFiles ? (
                        <i className="ph-fill ph-check-circle text-green-500 text-lg"></i>
                      ) : (
                        <i className="ph-fill ph-x-circle text-red-500 text-lg"></i>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {scoreInfo.outsideCollaborators === 0 ? (
                        <span className="inline-flex items-center justify-center bg-green-50 text-green-700 w-6 h-6 rounded-full text-xs font-bold">0</span>
                      ) : (
                        <span className="inline-flex items-center justify-center bg-red-50 text-red-700 w-6 h-6 rounded-full text-xs font-bold ring-2 ring-red-100">{scoreInfo.outsideCollaborators}</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {scoreInfo.issues.length === 0 ? (
                        <span className="text-xs text-green-600 font-medium bg-green-50 px-2 py-1 rounded border border-green-100">All compliant</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {scoreInfo.issues.map((issue, idx) => (
                            <span key={idx} className="text-xs text-red-600 flex items-start gap-1">
                              <i className="ph-fill ph-warning-circle mt-0.5 shrink-0"></i>
                              <span className="truncate max-w-[200px]" title={issue}>{issue}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      </main>
    </div>
  );
}
