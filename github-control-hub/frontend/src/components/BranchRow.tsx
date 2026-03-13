import type { Branch } from "../types/Branch";

interface BranchRowProps {
  branch: Branch;
  defaultBranch: string;
  onDelete: (branch: string) => void;
  onRename: (branch: string) => void;
  isDeleting: boolean;
}

export default function BranchRow({
  branch,
  defaultBranch,
  onDelete,
  onRename,
}: BranchRowProps) {
  const isDefault = branch.name === defaultBranch;

  return (
    <tr className="table-row-hover transition-colors group">
      <td className="py-3.5 px-5">
        <div className="flex items-center">
          <i className="ph ph-git-commit text-gh-textMuted dark:text-slate-400 mr-2"></i>
          <span className="font-medium text-gh-textBase dark:text-slate-200 text-sm">{branch.name}</span>
          {isDefault && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-gh-blue/30 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 text-gh-blue text-[10px] font-semibold uppercase tracking-wide ml-3">
              Default
            </span>
          )}
        </div>
      </td>
      <td className="py-3.5 px-5">
        {branch.protected ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-400 shadow-sm">
            <i className="ph-fill ph-shield-check text-green-600"></i> Protected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-600 dark:text-slate-400 shadow-sm">
            Unprotected
          </span>
        )}
      </td>
      <td className="py-3.5 px-5">
        <code className="text-[13px] text-gh-textMuted dark:text-slate-400 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 px-1.5 py-0.5 rounded font-mono">
          {branch.sha.slice(0, 7)}
        </code>
      </td>
      <td className="py-3.5 px-5">
        <div className="flex items-center justify-end gap-1.5 w-full">
          {!isDefault && (
            <>
              <div className="relative group/btn flex items-center justify-center">
                <button 
                  onClick={() => onRename(branch.name)}
                  className="p-1.5 rounded-md hover:bg-blue-50 dark:hover:bg-blue-950/50 text-gh-textMuted dark:text-slate-400 hover:text-gh-blue transition-colors" 
                >
                  <i className="ph ph-pencil-simple text-lg"></i>
                </button>
                <div className="absolute bottom-full mb-2 hidden group-hover/btn:block bg-gh-nav text-white text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap tooltip-arrow z-10 shadow-lg -translate-x-1/2 left-1/2">
                  Rename branch
                </div>
              </div>
              <div className="relative group/btn flex items-center justify-center">
                <button 
                  onClick={() => onDelete(branch.name)}
                  className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/50 text-gh-textMuted dark:text-slate-400 hover:text-red-600 transition-colors" 
                >
                  <i className="ph ph-trash text-lg"></i>
                </button>
                <div className="absolute bottom-full mb-2 hidden group-hover/btn:block bg-gh-nav text-white text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap tooltip-arrow z-10 shadow-lg -translate-x-1/2 left-1/2">
                  Delete branch
                </div>
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
