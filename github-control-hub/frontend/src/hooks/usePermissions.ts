import { useQuery } from "@tanstack/react-query";
import { fetchUserPermissions } from "../api/auth";
import { DEMO_MODE } from "../api/client";

/**
 * Whether the signed-in user may change org-wide Control Hub settings.
 *
 * Only gates settings with no GitHub equivalent — currently auto-apply on new
 * repositories. Repo actions need no check here: they run with the user's own
 * token and GitHub refuses them directly.
 */
export function usePermissions() {
  return useQuery({
    queryKey: ["permissions"],
    queryFn: async () => {
      if (DEMO_MODE) return { login: "demo-user", isControlHubAdmin: true, adminTeam: "control-hub-admins", isAwsAdmin: true, awsAdminTeam: "aws-guardrail-admins" };
      return fetchUserPermissions();
    },
    staleTime: 5 * 60_000,
  });
}
