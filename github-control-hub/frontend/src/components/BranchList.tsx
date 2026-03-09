import { useState, useMemo } from "react";
import {
  useBranches,
  useCreateBranch,
  useDeleteBranch,
  useProtectBranch,
} from "../hooks/useBranches";
import BranchRow from "./BranchRow";
import ProtectBranchModal from "./ProtectBranchModal";
import type { BranchRule } from "../types/Template";

interface BranchListProps {
  repo: string;
  defaultBranch: string;
}

export default function BranchList({ repo, defaultBranch }: BranchListProps) {
  const { data: branches, isLoading, error } = useBranches(repo);
  const createMutation = useCreateBranch(repo);
  const deleteMutation = useDeleteBranch(repo);
  const protectMutation = useProtectBranch(repo);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [protectDialogOpen, setProtectDialogOpen] = useState(false);
  const [protectTarget, setProtectTarget] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState(defaultBranch);
  const [search, setSearch] = useState("");

  const [actionTarget, setActionTarget] = useState<string | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  const filtered = useMemo(() => {
    if (!branches) return [];
    if (!search) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()));
  }, [branches, search]);

  const handleCreate = () => {
    createMutation.mutate(
      { branchName: newBranch, baseBranch },
      {
        onSuccess: () => {
          setSnack({ msg: `Branch "${newBranch}" created`, severity: "success" });
          setDialogOpen(false);
          setNewBranch("");
          setBaseBranch(defaultBranch);
        },
        onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
      }
    );
  };

  const handleDelete = (branch: string) => {
    if (!confirm(`Delete branch "${branch}"? This cannot be undone.`)) return;
    setActionTarget(branch);
    deleteMutation.mutate(branch, {
      onSuccess: () => {
        setSnack({ msg: `Branch "${branch}" deleted`, severity: "success" });
        setActionTarget(null);
      },
      onError: (err) => {
        setSnack({ msg: (err as Error).message, severity: "error" });
        setActionTarget(null);
      },
    });
  };

  const handleProtectClick = (branch: string) => {
    setProtectTarget(branch);
    setProtectDialogOpen(true);
  };

  const handleProtect = (rules: NonNullable<BranchRule["protection"]>) => {
    if (!protectTarget) return;
    const branch = protectTarget;
    setActionTarget(branch);
    protectMutation.mutate(
      { branch, protection: rules },
      {
        onSuccess: () => {
          setSnack({ msg: `Protection applied to "${branch}"`, severity: "success" });
          setActionTarget(null);
          setProtectDialogOpen(false);
          setProtectTarget(null);
        },
        onError: (err) => {
          setSnack({ msg: (err as Error).message, severity: "error" });
          setActionTarget(null);
        },
      }
    );
  };

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
        <p className="text-red-700">Failed to load branches: {(error as Error).message}</p>
      </div>
    );
  }

  return (
    <>
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <h2 className="text-lg font-bold text-gh-textBase flex items-center gap-2">
          <i className="ph ph-git-branch text-gh-textMuted text-xl"></i>
          Branches 
          <span className="bg-black/5 text-gh-textMuted font-normal px-2 py-0.5 rounded-full text-sm ml-1">
            {branches?.length ?? 0}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          <div className="relative hidden sm:block">
            <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <input 
              type="text" 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a branch..." 
              className="pl-9 pr-4 py-1.5 text-sm bg-white border border-gh-border rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-gh-blue/20 focus:border-gh-blue transition-all shadow-sm" 
            />
          </div>
          <button 
            onClick={() => setDialogOpen(true)}
            className="bg-gh-blue hover:bg-gh-blueHover text-white px-3.5 py-1.5 rounded-md flex items-center gap-2 text-sm font-medium transition-all shadow-subtle active:scale-[0.98]"
          >
            <i className="ph-bold ph-plus text-base"></i>
            Create Branch
          </button>
        </div>
      </div>

      {/* Branches Table Container */}
      <div className="bg-white hairline-border rounded-lg shadow-subtle overflow-hidden relative">
        {(deleteMutation.isPending || protectMutation.isPending) && (
          <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-10 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/50 border-b border-gh-border">
                <th className="py-3 px-5 text-xs font-semibold uppercase tracking-wider text-gh-textMuted">Branch</th>
                <th className="py-3 px-5 text-xs font-semibold uppercase tracking-wider text-gh-textMuted w-40">Status</th>
                <th className="py-3 px-5 text-xs font-semibold uppercase tracking-wider text-gh-textMuted w-32">SHA</th>
                <th className="py-3 px-5 text-xs font-semibold uppercase tracking-wider text-gh-textMuted text-right w-28">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gh-border">
              {filtered.map((branch) => (
                <BranchRow
                  key={branch.name}
                  branch={branch}
                  defaultBranch={defaultBranch}
                  onDelete={handleDelete}
                  onProtect={handleProtectClick}
                  isDeleting={deleteMutation.isPending && actionTarget === branch.name}
                  isProtecting={protectMutation.isPending && actionTarget === branch.name}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-gh-textMuted">
                    No branches found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="bg-gray-50/30 border-t border-gh-border px-5 py-3 flex items-center justify-between text-xs text-gh-textMuted">
          <span>Showing {filtered.length} of {branches?.length ?? 0} branches</span>
          <div className="flex items-center gap-2 pointer-events-none opacity-50">
            <button className="px-2 py-1 hairline-border rounded bg-white">Previous</button>
            <button className="px-2 py-1 hairline-border rounded bg-white">Next</button>
          </div>
        </div>
      </div>

      {/* CREATE BRANCH MODAL */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={() => setDialogOpen(false)}></div>
          <div className="bg-white rounded-[12px] shadow-modal border border-black/10 w-full max-w-[480px] relative z-10 animate-slide-up overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between bg-white pt-5">
              <h3 className="text-lg font-bold text-gray-900 tracking-tight shrink-0">Create New Branch</h3>
              <button 
                onClick={() => setDialogOpen(false)}
                className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-black/5 transition-colors absolute right-4 top-4"
              >
                <i className="ph ph-x text-lg"></i>
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-[13px] font-semibold text-gh-textBase mb-1.5 flex items-center gap-1.5">
                  Branch Name
                  <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <i className="ph ph-git-branch text-gray-400 text-lg"></i>
                  </div>
                  <input 
                    type="text" 
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    autoFocus
                    placeholder="feature/my-new-branch" 
                    className="block w-full pl-9 pr-3 py-2.5 text-[14px] leading-tight text-gh-textBase bg-white border border-gh-border rounded-[6px] shadow-sm outline-none focus:ring-[3px] focus:ring-gh-blue/20 focus:border-gh-blue transition-all placeholder:text-gray-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-gh-textBase mb-1.5">
                  Base Branch
                </label>
                <div className="relative">
                  <input 
                    type="text" 
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    className="block w-full pl-3 pr-10 py-2.5 text-[14px] leading-tight text-gh-textBase bg-gray-50 border border-gh-border rounded-[6px] shadow-sm outline-none focus:ring-[3px] focus:ring-gh-blue/20 focus:border-gh-blue transition-all"
                  />
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                    <i className="ph-bold ph-caret-down text-gray-400 text-sm"></i>
                  </div>
                </div>
                <p className="mt-2 text-[12px] text-gh-textMuted">
                  New commits will be added to the history of this branch.
                </p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gh-border bg-gray-50/50 flex items-center justify-end gap-3 rounded-b-[12px]">
              <button 
                onClick={() => setDialogOpen(false)}
                className="px-4 py-2 text-[13px] font-semibold text-gh-textBase bg-white border border-gh-border hover:bg-gray-50 rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreate}
                disabled={!newBranch || !baseBranch || createMutation.isPending}
                className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-blue hover:bg-gh-blueHover rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gh-blue/30 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createMutation.isPending ? "Creating..." : "Create branch"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ProtectBranchModal
        isOpen={protectDialogOpen}
        onClose={() => {
          setProtectDialogOpen(false);
          setProtectTarget(null);
        }}
        branch={protectTarget || ""}
        onSave={handleProtect}
        isSaving={protectMutation.isPending}
      />

      {/* Snackbar (Simple inline implementation using absolute pos, or keep MUI if possible... I will build a tailwind one to stay pure to design) */}
      {snack && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-slide-up">
          <div className={`px-4 py-3 rounded-lg shadow-modal flex items-center gap-3 text-sm font-medium text-white ${
            snack.severity === 'success' ? 'bg-[#1a7f37]' : 'bg-[#cf222e]'
          }`}>
            <i className={`ph-fill ${snack.severity === 'success' ? 'ph-check-circle' : 'ph-warning-circle'} text-lg`}></i>
            {snack.msg}
            <button onClick={() => setSnack(null)} className="ml-2 text-white/70 hover:text-white">
              <i className="ph ph-x"></i>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
