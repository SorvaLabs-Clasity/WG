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

// ── preset-chain resolution, for the tree ───────────────────────────────

/**
 * One grant or revoke, already placed at a layer a tree can rank against
 * whatever it is editing. Mirrors `backend/src/permissions/presets.ts` and
 * `evaluate.ts` closely enough to show the same origin an administrator would
 * see from the server — team-layer rules are out of scope here on purpose,
 * because nothing in the Admin tab edits a team entry.
 */
export interface FlatRule {
  node: string;
  effect: "grant" | "revoke";
  layer: number;
  /** Shown beside a leaf: "From preset Engineer". Never used to decide anything. */
  origin: string;
}

const MAX_INHERIT_DEPTH = 4;

/**
 * A preset and everything it inherits, flattened to one rule per node — the
 * most-derived preset in the chain wins at each node, same as the backend.
 * An unknown id, a cycle or an over-deep chain resolve to nothing rather than
 * throwing: the file is somebody's data, and `fileProblems` on the server is
 * what actually refuses it.
 */
export function resolvePresetChain(
  presets: Record<string, Preset>, id: string, layer: number,
): FlatRule[] {
  const chain: string[] = [];
  let cursor: string | undefined = id;
  const seen = new Set<string>();

  while (cursor) {
    if (seen.has(cursor)) return [];
    if (chain.length >= MAX_INHERIT_DEPTH + 1) return [];
    const preset: Preset | undefined = presets[cursor];
    if (!preset) break;
    seen.add(cursor);
    chain.push(cursor);
    cursor = preset.inherits;
  }
  if (chain.length === 0) return [];

  const byNode = new Map<string, { rule: FlatRule; sublayer: number }>();
  const deepestFirst = [...chain].reverse();
  deepestFirst.forEach((presetId, index) => {
    const preset = presets[presetId];
    if (!preset) return;
    const origin = `From preset ${preset.name}`;
    const entries: { node: string; effect: "grant" | "revoke" }[] = [
      ...(preset.grant ?? []).map(node => ({ node, effect: "grant" as const })),
      ...(preset.revoke ?? []).map(node => ({ node, effect: "revoke" as const })),
    ];
    for (const e of entries) {
      const existing = byNode.get(e.node);
      const wins = !existing || index > existing.sublayer
        || (index === existing.sublayer && e.effect === "revoke");
      if (wins) byNode.set(e.node, { rule: { node: e.node, effect: e.effect, layer, origin }, sublayer: index });
    }
  });
  return [...byNode.values()].map(v => v.rule);
}
