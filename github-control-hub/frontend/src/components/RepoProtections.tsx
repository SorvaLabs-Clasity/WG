import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRepoRulesets } from "../api/branches";
import { useAllBranchProtections } from "../hooks/useBranches";

export default function RepoProtections({ repo }: { repo: string }) {
  const { data: rulesets, isLoading: rulesetsLoading } = useQuery({
    queryKey: ["rulesets", repo],
    queryFn: () => fetchRepoRulesets(repo),
  });

  const { data: classicProtections, isLoading: classicLoading } = useAllBranchProtections(repo);

  if (rulesetsLoading || classicLoading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gh-border p-6 flex justify-center items-center h-48">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Rulesets Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gh-border overflow-hidden">
        <div className="px-5 py-4 border-b border-gh-border bg-gray-50/50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gh-textBase flex items-center gap-2">
            <i className="fa-solid fa-layer-group text-gh-blue"></i>
            Repository Rulesets
          </h3>
          <span className="bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200">
            {rulesets?.length || 0}
          </span>
        </div>
        <div className="p-0">
          {rulesets && rulesets.length > 0 ? (
            <ul className="divide-y divide-gh-border">
              {rulesets.map((rs: any) => (
                <li key={rs.id} className="px-5 py-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-gh-textBase text-sm">{rs.name}</span>
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                      rs.enforcement === 'active' ? 'bg-green-50 text-green-700 border border-green-200' : 
                      rs.enforcement === 'evaluate' ? 'bg-yellow-50 text-yellow-700 border border-yellow-200' : 
                      'bg-gray-100 text-gray-600 border border-gray-200'
                    }`}>
                      {rs.enforcement === 'active' && <i className="fa-solid fa-check-circle text-[10px]"></i>}
                      {rs.enforcement}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="text-xs text-gh-textBase font-mono flex items-center gap-2 flex-wrap">
                      <span className="text-gh-muted text-[11px] uppercase font-sans font-semibold tracking-wider">Target:</span>
                      {rs.conditions?.ref_name?.include?.map((inc: string) => (
                        <span key={inc} className="bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded">
                          {inc.replace('refs/heads/', '')}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center">
              <i className="fa-solid fa-layer-group text-gray-300 text-3xl mb-3"></i>
              <p className="text-sm text-gh-muted">No rulesets configured</p>
            </div>
          )}
        </div>
      </div>

      {/* Classic Protections Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gh-border overflow-hidden">
        <div className="px-5 py-4 border-b border-gh-border bg-gray-50/50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gh-textBase flex items-center gap-2">
            <i className="fa-solid fa-shield-halved text-gh-blue"></i>
            Classic Protections
          </h3>
          <span className="bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200">
            {Object.keys(classicProtections || {}).length}
          </span>
        </div>
        <div className="p-0">
          {classicProtections && Object.keys(classicProtections).length > 0 ? (
            <ul className="divide-y divide-gh-border">
              {Object.entries(classicProtections).map(([branch, protection]: [string, any]) => (
                <li key={branch} className="px-5 py-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-semibold text-gh-textBase text-sm">
                      <i className="fa-solid fa-code-branch text-gh-muted mr-1.5 text-[10px]"></i>
                      {branch}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                      <i className="fa-solid fa-check-circle text-[10px]"></i> Active
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 mt-2">
                    {protection.required_pull_request_reviews && (
                      <div className="text-xs text-gh-muted flex items-center gap-2">
                        <i className="fa-solid fa-users text-[10px]"></i>
                        Requires {protection.required_pull_request_reviews.required_approving_review_count} PR approvals
                      </div>
                    )}
                    {protection.required_status_checks && (
                      <div className="text-xs text-gh-muted flex items-center gap-2">
                        <i className="fa-solid fa-list-check text-[10px]"></i>
                        Status checks required
                      </div>
                    )}
                    {protection.enforce_admins?.enabled && (
                      <div className="text-xs text-gh-muted flex items-center gap-2">
                        <i className="fa-solid fa-user-shield text-[10px]"></i>
                        Enforced for admins
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center">
              <i className="fa-solid fa-shield-halved text-gray-300 text-3xl mb-3"></i>
              <p className="text-sm text-gh-muted">No classic protections</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
