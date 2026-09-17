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
  /** What this person holds per account, keyed by account id. */
  accounts?: Record<string, AccountEntry>;
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
  /**
   * AWS accounts declared for this organization. Declaring one adds an
   * `aws.account.<id>` branch to the tree; it does not give the app
   * credentials for that account, which is a separate problem.
   */
  awsAccounts?: AwsAccountEntry[];
}

export interface AccountEntry {
  presets?: string[];
  grant?: string[];
  revoke?: string[];
}

export interface AwsAccountEntry {
  accountId: string;
  name: string;
  note?: string;
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
  /**
   * The configured AWS accounts. The vocabulary carries one branch per
   * account, and these are the names to render them under — a tree of
   * twelve-digit numbers is how somebody grants remediation in the wrong one.
   */
  accounts?: Array<{ accountId: string; name: string }>;
  /** Which of those the app can actually reach today, as opposed to merely declared. */
  liveAccountIds?: string[];
  /** Set when the account list could not be read; the branches are simply absent. */
  accountsFailed?: string | null;
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
  /**
   * Every rule from the layers **beneath** this person's own entry — their
   * teams and their presets — at the depth each was actually written.
   *
   * Not derived from `explanations`. `explanations` says which rule won
   * overall, which is a different question: a leaf this person's own `revoke`
   * suppresses reads there as "not granted", exactly like a leaf nothing
   * grants, and dropping the `set on this person` entries from it therefore
   * loses the revoke rather than stepping beneath it. Flattening what is left
   * to leaf depth then inverts `decideLeaf`, which ranks depth above layer.
   * Both of those wrote entries the screen had not shown.
   */
  inherited: FlatRule[];
  /**
   * What those layers alone decide, leaf by leaf. The baseline every tree edit
   * is a difference from, computed by the server's own evaluator so the client
   * cannot disagree with it about what "already granted" means.
   */
  baseline: Record<string, boolean>;

  /**
   * True when this person's GitHub teams could not be read, so `baseline`
   * understates what they hold. Saving a permission edit against an
   * understated baseline deletes their own revokes — the tree must refuse
   * rather than diff against it.
   */
  teamsUnavailable?: boolean;

  /**
   * On the Control Hub admin team. They hold every permission by membership,
   * so an entry here would decide nothing — the screen says so instead of
   * accepting an edit that would quietly not apply.
   */
  exempt?: boolean;

  /** Per declared account: what the layers beneath this person decide there. */
  perAccount?: Record<string, { rules: FlatRule[]; baseline: Record<string, boolean> }>;
  /** Which account this install enforces, so the screen can say which tab is live. */
  installAccount?: string | null;
}

export interface OrgMember {
  login: string;
  avatarUrl: string | null;
  /** On the Control Hub admin team: holds everything, not configurable here. */
  exempt?: boolean;
}

/**
 * Everybody in the organization, so the People screen can offer them rather
 * than requiring their login to be typed exactly right from memory.
 */
export const fetchOrgMembers = () =>
  apiGet<{ members: OrgMember[] }>("/admin/org-members").then(r => r.members);

export const fetchPersonAccess = (login: string) =>
  apiGet<PersonAccess>(`/admin/person/${encodeURIComponent(login)}`);

// ── a preset's resolved chain ────────────────────────────────────────────

export interface PresetAccess {
  presetId: string;
  held: string[];
  explanations: Record<string, Explanation>;
  /** The chain's rules, at the depth they were written. As `PersonAccess.inherited`. */
  inherited: FlatRule[];
  /** What the chain alone decides. As `PersonAccess.baseline`. */
  baseline: Record<string, boolean>;
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
