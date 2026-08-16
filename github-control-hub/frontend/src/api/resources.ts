import { apiGet } from "./client";

export interface AwsResource {
  service: string;
  name: string;
  arn?: string;
  region?: string;
  detail?: Record<string, unknown>;
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
  from: { service: string; name: string; arn?: string };
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
