import { useQuery } from "@tanstack/react-query";
import { fetchGraphNode, fetchBlastRadius, fetchUserImpact, fetchBlastRadiusRanking, fetchSecurityQuery } from "../api/graph";

export function useGraphNode(id: string | null) {
  return useQuery({
    queryKey: ["graph", "node", id],
    queryFn: () => fetchGraphNode(id!),
    enabled: !!id,
  });
}

export function useBlastRadius(repo: string | null) {
  return useQuery({
    queryKey: ["graph", "blast-radius", repo],
    queryFn: () => fetchBlastRadius(repo!),
    enabled: !!repo,
  });
}

export function useBlastRadiusRanking() {
  return useQuery({
    queryKey: ["graph", "blast-radius-ranking"],
    queryFn: fetchBlastRadiusRanking,
  });
}

export function useUserImpact(user: string | null) {
  return useQuery({
    queryKey: ["graph", "user-impact", user],
    queryFn: () => fetchUserImpact(user!),
    enabled: !!user,
  });
}

export function useSecurityQuery(q: string | null, param?: string, advanced?: any) {
  return useQuery({
    queryKey: ["graph", "security-query", q, param, advanced],
    queryFn: () => fetchSecurityQuery(q!, param, advanced),
    enabled: !!q,
  });
}
