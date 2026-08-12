import { apiGet } from "./client";

export type OrgRole = "owner" | "member" | "outside_collaborator" | "unknown";

export interface AccessPath {
  via: "org_owner" | "team" | "direct";
  team?: string;
  teamName?: string;
  role: string;
}

export interface RepoAccess {
  repo: string;
  role: string;
  paths: AccessPath[];
  archived?: boolean;
  visibility?: string;
}

export interface Person {
  login: string;
  orgRole: OrgRole;
  avatarUrl?: string;
  teams: { slug: string; name: string }[];
  repoCount: number;
  adminCount: number;
  directCount: number;
  outside: boolean;
}

export interface AccessMapSummary {
  people: Person[];
  org: {
    defaultRepositoryPermission: string;
    memberCount?: number;
    twoFactorRequirementEnabled?: boolean | null;
  };
  repoCount: number;
  /** True when the graph predates people being collected — an empty map, not an empty org. */
  stale: boolean;
}

export interface UserAccess {
  login: string;
  orgRole: OrgRole;
  avatarUrl?: string;
  teams: { slug: string; name: string }[];
  repos: RepoAccess[];
  unknown?: boolean;
}

export interface RepoAccessDetail {
  repo: string;
  archived?: boolean;
  visibility?: string;
  people: (RepoAccess & { login: string; orgRole: OrgRole; outside: boolean })[];
  teams: { slug: string; name: string; permission: string; memberCount: number }[];
}

export const fetchAccessSummary = () => apiGet<AccessMapSummary>("/access/summary");
export const fetchUserAccess = (login: string) =>
  apiGet<UserAccess>(`/access/user/${encodeURIComponent(login)}`);
export const fetchRepoAccess = (repo: string) =>
  apiGet<RepoAccessDetail>(`/access/repo/${encodeURIComponent(repo)}`);
export const fetchAccessRepos = () => apiGet<string[]>("/access/repos");
