import { apiGet, apiPost, apiPut } from "./client";

/**
 * The Admin tab's client: typed wrappers over `/api/admin/*`, plus the pure
 * helpers that turn a `permissions.json` preset chain into rules a tree can
 * render. Follows the idiom in `./access.ts` — one function per route, the
 * response shape named rather than inferred.
 */

// ── the shapes in permissions.json (mirrors backend/src/permissions/types.ts) ──

export interface PermissionEntry {
  grant?: string[];
  revoke?: string[];
}

export interface Preset extends PermissionEntry {
  name: string;
  description?: string;
  /** Single parent. Resolved before this preset's own entries, and outranked by them. */
  inherits?: string;
}

export interface PersonEntry extends PermissionEntry {
  id?: number;
  presets?: string[];
  note?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface TeamEntry extends PermissionEntry {
  presets?: string[];
}

export interface PermissionsFile {
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  reviewedAt?: string;
  presets: Record<string, Preset>;
  teams: Record<string, TeamEntry>;
  /** Keyed by lower-cased GitHub login. */
  people: Record<string, PersonEntry>;
}

export function emptyFile(): PermissionsFile {
  return { version: 1, presets: {}, teams: {}, people: {} };
}

export interface FileProblem {
  where: string;
  what: string;
}

export interface LoadFailure {
  reason: "aws-only" | "no-token" | "unreachable" | "unparseable" | "invalid";
  detail: string;
  problems?: string[];
}

// ── the vocabulary ──────────────────────────────────────────────────────

export interface PermissionLeaf {
  key: string;
  label: string;
  addedIn: number;
}

export interface VocabularyResponse {
  permissions: PermissionLeaf[];
  version: number;
}

export const fetchVocabulary = () => apiGet<VocabularyResponse>("/admin/vocabulary");

// ── the file itself ──────────────────────────────────────────────────────

/**
 * Never both. A read failure comes back as 200 — the Admin tab's whole job is
 * to fix a broken file, so it must be able to render one that cannot be used.
 */
export interface AdminFile {
  file: PermissionsFile;
  sha: string | null;
  source: "github" | "absent" | "no-repo";
  unknownNodes: string[];
  problems: FileProblem[];
}

export type AdminFileResult = AdminFile | { failure: LoadFailure };

export function isAdminFileFailure(r: AdminFileResult): r is { failure: LoadFailure } {
  return (r as { failure?: LoadFailure }).failure !== undefined;
}

export const fetchAdminFile = () => apiGet<AdminFileResult>("/admin/file");

export type SaveFileResult =
  | { ok: true; sha: string }
  | { code: "conflict"; error: string }
  | { error: string; problems?: FileProblem[] };

/**
 * `apiPut` throws on a non-2xx response rather than returning it, so a caller
 * that wants to read a conflict or validation detail catches this rather than
 * branching on the return value.
 */
export const saveAdminFile = (file: PermissionsFile, sha: string | null, summary: string) =>
  apiPut<{ ok: true; sha: string }>("/admin/file", { file, sha, summary });

// ── one person ────────────────────────────────────────────────────────────

export interface Explanation {
  held: boolean;
  reason: "owner" | "inert" | "granted" | "revoked" | "not granted";
  /** "preset Engineer", "team platform", "set on this person". Null when nothing matched. */
  origin: string | null;
}

export interface PersonAccess {
  login: string;
  held: string[];
  explanations: Record<string, Explanation>;
}

export const fetchPersonAccess = (login: string) =>
  apiGet<PersonAccess>(`/admin/person/${encodeURIComponent(login)}`);

// ── a preset's resolved chain ────────────────────────────────────────────

export interface PresetAccess {
  presetId: string;
  held: string[];
  explanations: Record<string, Explanation>;
}

/**
 * What one preset's `inherits` chain grants, leaf by leaf — computed by the
 * server's own `resolvePreset`, not a client-side port of it.
 *
 * Resolves from the *stored* file, so it answers for a chain that has not
 * been saved yet too: the Presets editor calls this with whichever existing
 * preset `inherits` currently names, even while editing a preset (new or
 * existing) that has not been saved.
 */
export const fetchResolvedPreset = (id: string) =>
  apiGet<PresetAccess>(`/admin/preset/${encodeURIComponent(id)}/resolved`);

// ── audit ────────────────────────────────────────────────────────────────

export interface AuditEntry {
  sha: string;
  message: string;
  author: string;
  date: string | null;
}

export const fetchAudit = () => apiGet<AuditEntry[]>("/admin/audit");

// ── bootstrap, dry-run, migrate ─────────────────────────────────────────

export interface BootstrapResult {
  repoCreated: boolean;
  fileCreated: boolean;
  detail?: string;
  failure?: LoadFailure;
}

export const bootstrapAdmin = (createRepo: boolean) =>
  apiPost<BootstrapResult>("/admin/bootstrap", { createRepo });

export interface DryRunRow {
  login: string;
  /** Leaves this person holds today (under the `member` baseline) but would not under the file. */
  losing: string[];
  /** How many leaves this person would hold under the file. */
  keeping: number;
  isOrgOwner: boolean;
}

export const fetchDryRun = () => apiGet<DryRunRow[]>("/admin/dry-run");

export interface MigrateResult {
  ok: true;
  sha: string;
  people: number;
}

export const runMigration = () => apiPost<MigrateResult>("/admin/migrate", {});

// ── flattened rules, for the tree ────────────────────────────────────────

/**
 * One grant or revoke, already placed at a layer a tree can rank against
 * whatever it is editing.
 *
 * Built from an `Explanation` map today — `PersonAccess.explanations` for a
 * person, `PresetAccess.explanations` for a preset's `inherits` chain — never
 * hand-computed here. A preset's chain used to be walked client-side by a
 * `resolvePresetChain` that ported `resolvePreset` down to a duplicated
 * `MAX_INHERIT_DEPTH`; that drifted from the server the moment its tie rule or
 * depth cap changed, so it was replaced by `GET /admin/preset/:id/resolved`,
 * which asks the server's own `resolvePreset` instead of copying it.
 */
export interface FlatRule {
  node: string;
  effect: "grant" | "revoke";
  layer: number;
  /** Shown beside a leaf: "From preset Engineer". Never used to decide anything. */
  origin: string;
}
