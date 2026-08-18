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

/**
 * When the access graph was last rebuilt, and whether the last try worked.
 *
 * Both timestamps matter and neither implies the other: a successful build four
 * hours ago with a failed attempt ten minutes ago is a real state, and showing
 * only one of them hides half of it.
 */
export interface GraphAggregation {
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  edgeCount?: number;
}

export async function fetchGraphAggregation(): Promise<{ aggregation: GraphAggregation | null }> {
  if (DEMO_MODE) return { aggregation: { lastSuccessAt: new Date().toISOString(), edgeCount: 100 } };
  return apiGet<{ aggregation: GraphAggregation | null }>("/graph/aggregate/status");
}

export async function triggerGraphAggregation(): Promise<{ aggregation: GraphAggregation | null }> {
  if (DEMO_MODE) return { aggregation: { lastSuccessAt: new Date().toISOString(), edgeCount: 100 } };
  return apiPost<{ aggregation: GraphAggregation | null }>("/graph/aggregate", {});
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

export interface QueryFreshness {
  batched: boolean;
  checked: number;
  oldestAt: string | null;
  newestAt: string | null;
}

/** How stale the stored answers are. Reads the cache; asks GitHub nothing. */
export async function fetchQueryFreshness(q: string): Promise<QueryFreshness> {
  if (DEMO_MODE) return { batched: false, checked: 0, oldestAt: null, newestAt: null };
  return apiGet<QueryFreshness>(`/graph/query/${encodeURIComponent(q)}/freshness`);
}

export interface RefreshAllResult {
  complete: boolean;
  batches: number;
  covered: number;
  total: number;
  budget: "search" | "core";
  message: string;
}

export async function refreshQueryNow(q: string): Promise<RefreshAllResult> {
  return apiPost<RefreshAllResult>(`/graph/query/${encodeURIComponent(q)}/refresh-all`, {});
}
