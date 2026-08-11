import { apiGet, apiPost, DEMO_MODE } from "./client";
import { mockGetGraphNode, mockGetUserImpact, mockFetchSecurityQuery } from "./mock";

export interface GraphEdge {
  target: string;
  type: string;
  metadata?: any;
}

export interface GraphNodeResponse {
  node: string;
  edges: GraphEdge[];
}

export interface UserImpactResponse {
  user: string;
  teams: string[];
  repos: { repo: string; access: string; team?: string; permission: string }[];
  writeOrAdminReposCount: number;
  productionPipelinesReachable: number;
}

export async function fetchGraphMeta(): Promise<{ edgeCount: number }> {
  if (DEMO_MODE) return { edgeCount: 100 };
  return apiGet<{ edgeCount: number }>("/graph/meta");
}

export async function triggerGraphAggregation(): Promise<{ message: string }> {
  if (DEMO_MODE) return { message: "Demo mode" };
  return apiPost<{ message: string }>("/graph/aggregate", {});
}

export async function fetchGraphNode(id: string): Promise<GraphNodeResponse> {
  if (DEMO_MODE) return mockGetGraphNode(id);
  return apiGet<GraphNodeResponse>(`/graph/node/${encodeURIComponent(id)}`);
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
  status?: "pass" | "fail";
}

export async function fetchSecurityQuery(q: string, param?: string, advanced?: any): Promise<SecurityQueryResult[]> {
  if (DEMO_MODE) return mockFetchSecurityQuery(q, param, advanced);
  const url = new URL(window.location.origin + `/api/graph/query`);
  url.searchParams.append("q", q);
  if (param) url.searchParams.append("param", param);
  if (advanced) {
    for (const [key, value] of Object.entries(advanced)) {
      if (value !== undefined && value !== null && value !== false && value !== "" && value !== 0) {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return apiGet<SecurityQueryResult[]>(`/graph/query${url.search}`);
}
