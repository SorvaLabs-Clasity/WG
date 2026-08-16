import { apiGet } from "./client";

export interface AwsResource {
  service: string;
  name: string;
  arn?: string;
  region?: string;
  detail?: Record<string, unknown>;
  /** AWS console link. Null when it cannot be built truthfully. */
  url?: string | null;
}

export interface InventoryAnswer {
  total: number;
  matched: number;
  resources: AwsResource[];
  services: Array<{ service: string; ok: boolean; count: number; error: string | null }>;
  unreadable: Array<{ service: string; error: string }>;
  readAt: string | null;
}

export type RiskLevel = "high" | "medium" | "low" | "unknown";

export interface SourceRef {
  repo: string;
  path: string;
  url: string;
  kind: "terraform" | "cloudformation" | "cdk" | "kubernetes" | "ci" | "config" | "code" | "docs";
  term: string;
}

export interface Relationship {
  from: { service: string; name: string; arn?: string; region?: string };
  fromUrl?: string | null;
  to: { service: string; name: string };
  kind: string;
  detail: string;
}

export interface ResourceExpert {
  login: string;
  score: number;
  commits: number;
  lastActive: string | null;
  daysSinceActive: number | null;
  files: Array<{ repo: string; path: string; kind: SourceRef["kind"] }>;
}

export interface ResourceExperts {
  experts: ResourceExpert[];
  filesRead: Array<{ repo: string; path: string; kind: SourceRef["kind"] }>;
  filesSkipped: number;
  degraded: Array<{ repo: string; path: string; error: string }>;
}

export interface DriftReport {
  findings: Array<{ kind: "extra" | "missing"; rule: string; detail: string }>;
  comparable: boolean;
  notes: string[];
  declaredIn: { repo: string; path: string } | null;
}

export interface BlastRadius {
  target: AwsResource;
  relationships: Relationship[];
  sourceRefs: SourceRef[];
  repos: string[];
  managedBy: string[];
  risk: RiskLevel;
  findings: string[];
  unread: Array<{ source: string; error: string }>;
  /** Null when nothing in source names it — there is no history to read. */
  experts: ResourceExperts | null;
  /** Only for resource kinds whose declared shape can be compared. */
  drift: DriftReport | null;
  targetUrl?: string | null;
}

export function fetchInventory(q: string, refresh = false): Promise<InventoryAnswer> {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (refresh) p.set("refresh", "true");
  return apiGet<InventoryAnswer>(`/resources?${p}`);
}

export function fetchBlastRadius(service: string, name: string): Promise<BlastRadius> {
  const p = new URLSearchParams({ service, name });
  return apiGet<BlastRadius>(`/resources/blast?${p}`);
}

export interface CostAnswer {
  mode: "resource" | "tag" | "service";
  period: { start: string; end: string };
  rows: Array<{ key: string; amount: number; currency: string }>;
  total: number;
  currency: string;
  notes: string[];
  readAt: string;
  ownership: Array<{
    service: string;
    amount: number;
    repos: string[];
    unreferenced: string[];
  }> | null;
  unreadableServices: Array<{ service: string; error: string }>;
}

/**
 * Spend for the current month.
 *
 * Each call is a Cost Explorer request, which AWS charges a cent for — so this
 * is never called on a render or a timer, only when somebody opens the view.
 */
export function fetchCost(refresh = false): Promise<CostAnswer> {
  return apiGet<CostAnswer>(`/resources/cost${refresh ? "?refresh=true" : ""}`);
}
