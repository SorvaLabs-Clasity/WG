/**
 * "4 hours ago", down to a minute, below that, "just now".
 *
 * Shared rather than copied. Two screens report how old their data is, and a
 * dashboard that says "12 minutes ago" beside a page that says "12m" reads as
 * two different systems. Returns null for anything unparseable, so a caller
 * renders nothing rather than "NaN minutes ago".
 */
export function ago(iso?: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
