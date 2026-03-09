import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchBranches, createBranch, deleteBranch, protectBranch } from "../api/branches";

export function useBranches(repo: string) {
  return useQuery({
    queryKey: ["branches", repo],
    queryFn: () => fetchBranches(repo),
    enabled: !!repo,
    staleTime: 15_000,
  });
}

export function useCreateBranch(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branchName, baseBranch }: { branchName: string; baseBranch: string }) =>
      createBranch(repo, branchName, baseBranch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useDeleteBranch(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => deleteBranch(repo, branch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useProtectBranch(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branch, protection }: { branch: string, protection: NonNullable<import("../types/Template").BranchRule["protection"]> }) => protectBranch(repo, branch, protection),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
