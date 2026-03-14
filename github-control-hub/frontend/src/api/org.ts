import { apiGet, DEMO_MODE } from "./client";
import { OrgConfig } from "../types/Org";

export async function fetchOrgConfig(): Promise<OrgConfig> {
  return apiGet<OrgConfig>("/org/config");
}

export interface OrgActors {
  roles: Array<{ id: number; name: string; description: string; base_role?: string; has_write?: boolean }>;
  teams: Array<{ id: number; name: string; slug: string }>;
  apps: Array<{ id: number; name: string; slug: string }>;
}

export async function fetchOrgActors(): Promise<OrgActors> {
  if (DEMO_MODE) {
    return {
      roles: [
        { id: 5, name: "Admin", description: "Full access to the repository", base_role: "admin", has_write: true },
        { id: 1, name: "Maintain", description: "Manage repository without access to sensitive or destructive actions", base_role: "maintain", has_write: true },
        { id: 2, name: "Write", description: "Read and write access to code, issues, and pull requests", base_role: "write", has_write: true },
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
