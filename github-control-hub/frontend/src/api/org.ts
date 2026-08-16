import { apiGet } from "./client";
import { OrgConfig } from "../types/Org";

export interface OrgMember {
  login: string;
  avatarUrl: string | null;
}

export async function fetchOrgConfig(): Promise<OrgConfig> {
  return apiGet<OrgConfig>("/org/config");
}

export async function fetchOrgMembers(): Promise<OrgMember[]> {
  return apiGet<OrgMember[]>("/org/members");
}
