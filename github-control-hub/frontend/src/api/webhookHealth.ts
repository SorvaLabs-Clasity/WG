import { apiGet } from "./client";

export interface WebhookHealth {
  status: "healthy" | "quiet" | "stale" | "unknown";
  lastEventAt: string | null;
  lastEventAction: string | null;
  ageHours: number | null;
}

export function fetchWebhookHealth(): Promise<WebhookHealth> {
  return apiGet<WebhookHealth>("/org/webhook-health");
}
