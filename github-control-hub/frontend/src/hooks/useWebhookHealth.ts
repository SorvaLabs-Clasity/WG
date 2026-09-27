import { useQuery } from "@tanstack/react-query";
import { useGithubAvailable } from "./useGithubAvailable";
import { fetchWebhookHealth } from "../api/webhookHealth";

export function useWebhookHealth() {
  const github = useGithubAvailable();
  return useQuery({
    enabled: github === true,
    queryKey: ["webhook-health"],
    queryFn: fetchWebhookHealth,
    staleTime: 60_000,
  });
}
