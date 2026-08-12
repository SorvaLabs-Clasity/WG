import { useQuery } from "@tanstack/react-query";
import { fetchWebhookHealth } from "../api/webhookHealth";

export function useWebhookHealth() {
  return useQuery({
    queryKey: ["webhook-health"],
    queryFn: fetchWebhookHealth,
    staleTime: 60_000,
  });
}
