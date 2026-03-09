import type { Branch } from "../types/Branch";

interface BranchRowProps {
  branch: Branch;
  defaultBranch: string;
  onDelete: (branch: string) => void;
  onProtect: (branch: string) => void;
  isDeleting: boolean;
  isProtecting: boolean;
}

export default function BranchRow({
  branch,
  defaultBranch,
  onDelete,
  onProtect,
}: BranchRowProps) {
  const isDefault = branch.name === defaultBranch;

  return (
    <tr className="table-row-hover transition-colors group">
      <td className="py-3.5 px-5">
        <div className="flex items-center">
          <i className="ph ph-git-commit text-gh-textMuted mr-2"></i>
          <span className="font-medium text-gh-textBase text-sm">{branch.name}</span>
          {isDefault && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-gh-blue/30 bg-blue-50 text-gh-blue text-[10px] font-semibold uppercase tracking-wide ml-3">
              Default
            </span>
          )}
        </div>
      </td>
      <td className="py-3.5 px-5">
        {branch.protected ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-green-200 bg-green-50 text-green-700 shadow-sm">
            <i className="ph-fill ph-shield-check text-green-600"></i> Protected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200 bg-white text-gray-600 shadow-sm">
            Unprotected
          </span>
        )}
      </td>
      <td className="py-3.5 px-5">
        <code className="text-[13px] text-gh-textMuted bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded font-mono">
          {branch.sha.slice(0, 7)}
        </code>
      </td>
      <td className="py-3.5 px-5">
        <div className="flex items-center justify-end gap-1.5 w-full">
          {!branch.protected && (
            <div className="relative group/btn flex items-center justify-center">
              <button 
                onClick={() => onProtect(branch.name)}
                className="p-1.5 rounded-md hover:bg-blue-50 text-gh-textMuted hover:text-gh-blue transition-colors" 
              >
                <i className="ph ph-shield-plus text-lg"></i>
              </button>
              <div className="absolute bottom-full mb-2 hidden group-hover/btn:block bg-gh-nav text-white text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap tooltip-arrow z-10 shadow-lg -translate-x-1/2 left-1/2">
                Apply protection
              </div>
            </div>
          )}
          {!isDefault && (
            <div className="relative group/btn flex items-center justify-center">
              <button 
                onClick={() => onDelete(branch.name)}
                className="p-1.5 rounded-md hover:bg-red-50 text-gh-textMuted hover:text-red-600 transition-colors" 
              >
                <i className="ph ph-trash text-lg"></i>
              </button>
              <div className="absolute bottom-full mb-2 hidden group-hover/btn:block bg-gh-nav text-white text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap tooltip-arrow z-10 shadow-lg -translate-x-1/2 left-1/2">
                Delete branch
              </div>
            </div>
          )}
          {isDefault && (
            <button className="p-1.5 rounded-md hover:bg-gray-200 hover:text-gh-textBase transition-colors opacity-50 cursor-not-allowed">
              <i className="ph ph-gear text-lg"></i>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
