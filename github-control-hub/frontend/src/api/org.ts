import { apiGet } from "./client";
import { OrgConfig } from "../types/Org";

export async function fetchOrgConfig(): Promise<OrgConfig> {
  return apiGet<OrgConfig>("/org/config");
}
