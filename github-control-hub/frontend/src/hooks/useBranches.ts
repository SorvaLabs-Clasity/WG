import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchBranches, createBranch, deleteBranch, renameBranch, protectBranch, fetchRepoRulesets, fetchBranchProtection, fetchAllBranchProtections, deleteBranchProtection, deleteRepoRuleset, importRepoRuleset } from "../api/branches";

export function useBranches(repo: string) {
  return useQuery({
    queryKey: ["branches", repo],
    queryFn: () => fetchBranches(repo),
    enabled: !!repo,
    staleTime: 15_000,
  });
}

export function useRepoRulesets(repo: string) {
  return useQuery({
    queryKey: ["rulesets", repo],
    queryFn: () => fetchRepoRulesets(repo),
    enabled: !!repo,
    staleTime: 30_000,
  });
}

export function useBranchProtection(repo: string, branch: string) {
  return useQuery({
    queryKey: ["protection", repo, branch],
    queryFn: () => fetchBranchProtection(repo, branch),
    enabled: !!repo && !!branch,
    staleTime: 30_000,
  });
}

export function useAllBranchProtections(repo: string) {
  return useQuery({
    queryKey: ["all-protections", repo],
    queryFn: () => fetchAllBranchProtections(repo),
    enabled: !!repo,
    staleTime: 30_000,
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

export function useRenameBranch(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branch, newName }: { branch: string; newName: string }) =>
      renameBranch(repo, branch, newName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useProtectBranch(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branch, protection }: { branch: string, protection: import("../types/Protection").BranchProtection }) => protectBranch(repo, branch, protection),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
      qc.invalidateQueries({ queryKey: ["protection", repo] });
      qc.invalidateQueries({ queryKey: ["all-protections", repo] });
    },
  });
}

export function useDeleteBranchProtection(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => deleteBranchProtection(repo, branch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
      qc.invalidateQueries({ queryKey: ["protection", repo] });
      qc.invalidateQueries({ queryKey: ["all-protections", repo] });
    },
  });
}

export function useImportRepoRuleset(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rulesetJson: any) => importRepoRuleset(repo, rulesetJson),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rulesets", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useDeleteRepoRuleset(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rulesetId: number) => deleteRepoRuleset(repo, rulesetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rulesets", repo] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
