import { useQuery } from "@tanstack/react-query";
import { usePermissionSet } from "./usePermissionSet";
import { useGithubAvailable } from "./useGithubAvailable";
import { fetchWebhookHealth } from "../api/webhookHealth";

export function useWebhookHealth() {
  const github = useGithubAvailable();
  const may = usePermissionSet().holds("org.webhookHealth.read");
  return useQuery({
    enabled: github === true && may,
    queryKey: ["webhook-health"],
    queryFn: fetchWebhookHealth,
    staleTime: 60_000,
  });
}
