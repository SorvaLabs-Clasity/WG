import { apiGet, DEMO_MODE } from "./client";
import { OrgConfig } from "../types/Org";

export async function fetchOrgConfig(): Promise<OrgConfig> {
  return apiGet<OrgConfig>("/org/config");
}

export interface OrgActors {
  roles: Array<{ id: number; name: string; description: string }>;
  teams: Array<{ id: number; name: string; slug: string }>;
  apps: Array<{ id: number; name: string; slug: string }>;
}

export async function fetchOrgActors(): Promise<OrgActors> {
  if (DEMO_MODE) {
    return {
      roles: [
        { id: 5, name: "Admin", description: "Full access to the repository" },
        { id: 1, name: "Maintain", description: "Manage repository without access to sensitive or destructive actions" },
        { id: 2, name: "Write", description: "Read and write access to code, issues, and pull requests" },
      ],
      teams: [
        { id: 101, name: "Engineering", slug: "engineering" },
        { id: 102, name: "DevOps", slug: "devops" },
        { id: 103, name: "Security", slug: "security" },
      ],
      apps: [
        { id: 201, name: "dependabot", slug: "dependabot" },
        { id: 202, name: "github-actions", slug: "github-actions" },
      ],
    };
  }
  return apiGet<OrgActors>("/org/actors");
}
