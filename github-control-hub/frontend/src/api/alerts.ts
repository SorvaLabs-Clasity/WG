import { apiGet, apiPost } from "./client";
import { SecurityAlert } from "../types/Alert";
import { mockFetchAlerts } from "./mock";

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export interface AlertPage {
  alerts: SecurityAlert[];
  /** Pass back to reach older rows. Null when there are none. */
  cursor: string | null;
  /** True when this is everything in the window, with nothing behind it. */
  complete: boolean;
  /** The oldest timestamp the server looked at. */
  since: string;
  windowWeeks: number;
}

/**
 * One page of alerts, newest first.
 *
 * The server used to return the whole table on every poll. It now bounds the
 * read to a window and says whether that window fitted, so the page can state
 * what it is showing instead of drawing a truncated list as if it were
 * everything.
 */
export async function fetchAlerts(cursor?: string): Promise<AlertPage> {
  if (DEMO_MODE) {
    const alerts = await mockFetchAlerts();
    return { alerts, cursor: null, complete: true, since: "", windowWeeks: 12 };
  }
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiGet<AlertPage>(`/alerts${q}`);
}
