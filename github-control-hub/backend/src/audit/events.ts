/**
 * Which enterprise audit log events are worth keeping, and what they mean.
 *
 * GitHub streams everything. Most of it is `git.clone` and `git.fetch` — one
 * line per CI job, thousands a day, and nobody has ever opened an audit trail
 * to read them. Indexing all of it is affordable but makes the result
 * unreadable, which is the same failure the activity feed had before it was
 * split: signal buried under volume.
 *
 * So the raw JSON stays in S3 — complete, cheap, and searchable by date if a
 * question ever needs it — and only consequential events are indexed.
 *
 * "Consequential" means: it changed who can do what, what is exposed, or what
 * protects a repository. Those are the events an auditor asks about and the
 * ones nobody can reconstruct afterwards from the code.
 */

/**
 * Exact event names and prefixes to keep.
 *
 * Overridable with AUDIT_EVENT_ALLOWLIST (comma-separated) so the filter can be
 * widened without a code change — you cannot know your own volume until
 * streaming has run for a few days, and the answer should not require a
 * rewrite.
 */
const DEFAULT_ALLOW = [
  // Who is in the organization, and with what power.
  "org.add_member", "org.remove_member", "org.update_member",
  "org.invite_member", "org.cancel_invitation",
  "org.update_default_repository_permission",
  "org.update_member_repository_creation_permission",
  "org.disable_two_factor_requirement", "org.enable_two_factor_requirement",

  // Teams — the usual route to repository access.
  "team.add_member", "team.remove_member",
  "team.add_repository", "team.remove_repository",
  "team.change_parent_team", "team.destroy",

  // Repositories appearing, disappearing, or changing who can see them.
  "repo.create", "repo.destroy", "repo.transfer",
  "repo.archived", "repo.unarchived",
  "repo.access",                    // public <-> private
  "repo.add_member", "repo.remove_member", "repo.update_member",

  // The controls this app exists to watch.
  "protected_branch.",              // create, destroy, and every update_*
  "repository_ruleset.",
  "repository_vulnerability_alert.",

  // Credentials and third-party access.
  "personal_access_token.",
  "oauth_application.",
  "org.oauth_app_access_approved", "org.oauth_app_access_denied",
  "org.oauth_app_access_requested",
  "integration_installation.",
  "hook.create", "hook.destroy", "hook.config_changed",

  // Findings that mean something leaked.
  "secret_scanning_alert.",
];

export function allowList(): string[] {
  const override = process.env.AUDIT_EVENT_ALLOWLIST;
  if (!override) return DEFAULT_ALLOW;
  const parsed = override.split(",").map(s => s.trim()).filter(Boolean);
  // An empty or whitespace override means somebody meant to configure this and
  // did not. Falling back is safer than indexing nothing and calling it quiet.
  return parsed.length > 0 ? parsed : DEFAULT_ALLOW;
}

/** True when this event is worth indexing. Prefix entries end with a dot. */
export function isConsequential(action: string, allow = allowList()): boolean {
  if (!action) return false;
  return allow.some(entry => entry.endsWith(".") ? action.startsWith(entry) : action === entry);
}

/** One event as GitHub streams it. Only the fields that are always present. */
export interface RawAuditEvent {
  action?: string;
  actor?: string;
  created_at?: number | string;
  repo?: string;
  repository?: string;
  org?: string;
  user?: string;
  team?: string;
  business?: string;
  [k: string]: unknown;
}

export interface IndexedAuditEvent {
  action: string;
  actor: string;
  repo: string;
  target: string;
  timestamp: string;
  details: string;
}

/**
 * GitHub sends created_at as epoch milliseconds, and occasionally as a string.
 * A row whose timestamp cannot be read would sort to the wrong end of the feed
 * and expire on the wrong schedule, so an unreadable one falls back to now
 * rather than to zero.
 */
export function toTimestamp(created: number | string | undefined): string {
  if (typeof created === "number" && Number.isFinite(created)) {
    // Seconds vs milliseconds: anything below this is not a plausible recent
    // date in milliseconds, so treat it as seconds.
    const ms = created < 1e11 ? created * 1000 : created;
    return new Date(ms).toISOString();
  }
  if (typeof created === "string") {
    const d = new Date(created);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/** First non-empty string among the named fields, including inside arrays. */
function firstOf(e: RawAuditEvent, fields: string[]): string {
  for (const f of fields) {
    const v = e[f];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v.length && typeof v[0] === "string") return v[0];
  }
  return "";
}

/**
 * The repository an event concerns.
 *
 * Not always in `repo`. An integration event names it in
 * `repositories_removed_names` or `repositories_added_names` instead, so
 * reading only `repo` left the column blank on exactly the events where
 * knowing the repository matters most.
 */
export function repoOf(e: RawAuditEvent): string {
  return firstOf(e, ["repo", "repository", "repositories_removed_names", "repositories_added_names"]);
}

/**
 * A readable one-line summary. The raw event stays in S3 for the full detail.
 *
 * Beyond actor and action, this picks up the one field that identifies what the
 * event was actually about — the app for an integration change, the team, the
 * user being added. Without it, two integration events on the same repository
 * by the same person read identically while describing different applications.
 */
export function describe(e: RawAuditEvent): string {
  const action = String(e.action ?? "");
  const who = String(e.actor ?? "unknown");
  const on = repoOf(e) || firstOf(e, ["team", "user", "org"]);

  const parts = [`${who} — ${action}`];
  if (on) parts.push(`on ${on}`);

  // GitHub uses `integration` for the app's display name on installation
  // events, and `name` alongside it. Either identifies which app changed.
  const app = firstOf(e, ["integration", "application", "oauth_application"]);
  if (app) parts.push(`(${app})`);

  // An arrow means "changed to". Most events carry `visibility` as context
  // rather than as a change — repo.destroy reports what the repository was
  // when it was deleted, and rendering that as "→ private" reads as though
  // deleting it made it private.
  const changesVisibility = action === "repo.access" || action.includes("visibility");
  const visibility = firstOf(e, ["visibility"]);
  if (visibility && changesVisibility) parts.push(`→ ${visibility}`);
  else if (visibility) parts.push(`[${visibility}]`);

  const permission = firstOf(e, ["permission"]);
  if (permission) parts.push(`→ ${permission}`);

  return parts.join(" ");
}

export function normalise(e: RawAuditEvent): IndexedAuditEvent {
  const action = String(e.action ?? "");
  return {
    action,
    actor: String(e.actor ?? "unknown"),
    // Repository-scoped events name a repo; organization-scoped ones do not,
    // and an empty string is how the rest of the activity feed says "no repo".
    repo: repoOf(e),
    // The audit action goes in target, because every one of these rows carries
    // the same `action` of "audit.event" in the activity feed — this is what
    // tells them apart in the UI.
    target: action,
    timestamp: toTimestamp(e.created_at),
    details: describe(e),
  };
}

/**
 * Parse one streamed object.
 *
 * GitHub writes newline-delimited JSON, gzipped. One malformed line must not
 * discard the rest of the file — a partial batch is worth more than none, and
 * dropping the whole object because of one bad line loses events silently.
 */
export function parseNdjson(body: string): { events: RawAuditEvent[]; skipped: number } {
  const events: RawAuditEvent[] = [];
  let skipped = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") events.push(parsed as RawAuditEvent);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}
