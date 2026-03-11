import { apiGet, DEMO_MODE } from "./client";
import { mockGetGraphNode, mockGetBlastRadius, mockGetUserImpact, mockGetBlastRadiusRanking, mockFetchSecurityQuery } from "./mock";

export interface GraphEdge {
  target: string;
  type: string;
  metadata?: any;
}

export interface GraphNodeResponse {
  node: string;
  edges: GraphEdge[];
}

export interface BlastRadiusResponse {
  repo: string;
  workflows: string[];
  vulnerableDependencies: { name: string; severity: string }[];
  teamsWithAccess: { name: string; permission: string }[];
  directCollaborators: { name: string; role: string }[];
  riskScore: string;
}

export interface UserImpactResponse {
  user: string;
  teams: string[];
  repos: { repo: string; access: string; team?: string; permission: string }[];
  writeOrAdminReposCount: number;
  productionPipelinesReachable: number;
}

export interface BlastRadiusRankingItem {
  repo: string;
  score: number;
  riskLevel: string;
  workflowsCount: number;
  vulnerabilitiesCount: number;
  accessVectorsCount: number;
}

export async function fetchGraphNode(id: string): Promise<GraphNodeResponse> {
  if (DEMO_MODE) return mockGetGraphNode(id);
  return apiGet<GraphNodeResponse>(`/graph/node/${encodeURIComponent(id)}`);
}

export async function fetchBlastRadius(repo: string): Promise<BlastRadiusResponse> {
  if (DEMO_MODE) return mockGetBlastRadius(repo);
  return apiGet<BlastRadiusResponse>(`/graph/blast-radius/repo/${encodeURIComponent(repo)}`);
}

export async function fetchBlastRadiusRanking(): Promise<BlastRadiusRankingItem[]> {
  if (DEMO_MODE) return mockGetBlastRadiusRanking();
  return apiGet<BlastRadiusRankingItem[]>(`/graph/blast-radius/ranking`);
}

export async function fetchUserImpact(user: string): Promise<UserImpactResponse> {
  if (DEMO_MODE) return mockGetUserImpact(user);
  return apiGet<UserImpactResponse>(`/graph/user-impact/${encodeURIComponent(user)}`);
}

export interface SecurityQueryResult {
  repo?: string;
  user?: string;
  team?: string;
  reason: string;
  details?: string;
}

export async function fetchSecurityQuery(q: string, param?: string, advanced?: any): Promise<SecurityQueryResult[]> {
  if (DEMO_MODE) return mockFetchSecurityQuery(q, param, advanced);
  const url = new URL(window.location.origin + `/api/graph/query`); // The base doesn't matter here, just for URL object
  url.searchParams.append("q", q);
  if (param) url.searchParams.append("param", param);
  if (advanced) {
    if (advanced.protectionType) url.searchParams.append("protectionType", advanced.protectionType);
    if (advanced.requirePr) url.searchParams.append("requirePr", "true");
    if (advanced.requireStatusChecks) url.searchParams.append("requireStatusChecks", "true");
    if (advanced.enforceAdmins) url.searchParams.append("enforceAdmins", "true");
  }
  return apiGet<SecurityQueryResult[]>(`/graph/query${url.search}`);
}
