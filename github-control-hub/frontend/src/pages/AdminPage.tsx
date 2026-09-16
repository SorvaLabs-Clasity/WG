import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../App";
import {
  Page, Back, Note, Pill, Empty, Spinner, RailCard, Sheet, SheetHeader, Block,
  SearchInput, Segmented, Button, LoadFailed, ConfirmDialog, SURFACE, TYPE,
} from "../design";
import { usePermissionSet } from "../hooks/usePermissionSet";
import PermissionTree from "../components/PermissionTree";
import {
  fetchVocabulary, fetchAdminFile, saveAdminFile, fetchPersonAccess, fetchAudit,
  bootstrapAdmin, fetchDryRun, runMigration, isAdminFileFailure, resolvePresetChain,
  type AdminFile, type PermissionsFile, type PermissionEntry, type PersonEntry, type Preset,
  type PermissionLeaf, type Explanation, type AuditEntry, type FlatRule,
} from "../api/admin";
import { ago } from "../lib/ago";

/**
 * The Admin tab.
 *
 * Four screens over one file: People (everybody the file has an opinion about),
 * Person (one login's tree, a note, and a save), Presets (create, edit, delete,
 * who holds each) and Audit (the file's own git history). Above all of them, the
 * dry-run banner — the one thing that has to be seen before anybody trusts this
 * screen with a live flip.
 *
 * Follows `AccessPage.tsx`'s shape: one page component, drill-down screens as
 * sibling top-level functions returned in place of the list when something is
 * open, `Segmented` choosing between the three list-level views.
 */

// ── turning a server explanation into a tree layer ──────────────────────

/**
 * The person's resolved state, from `GET /person/:login`, reduced to the
 * layer beneath whatever this screen is about to edit.
 *
 * A leaf whose `origin` reads "set on this person" is excluded: that is
 * exactly the person's own current entry, which `PermissionTree` derives
 * itself from `entry` and would otherwise double up on. Everything else —
 * a preset, a team, organization ownership — becomes a leaf-depth rule, so it
 * outranks nothing it should not and loses to a real edit at the same depth.
 */
function inheritedFromExplanations(explanations?: Record<string, Explanation>): FlatRule[] {
  if (!explanations) return [];
  const out: FlatRule[] = [];
  for (const [leaf, exp] of Object.entries(explanations)) {
    if (!exp.origin || exp.origin === "set on this person") continue;
    out.push({ node: leaf, effect: exp.held ? "grant" : "revoke", layer: 0, origin: `From ${exp.origin}` });
  }
  return out;
}

/** Every preset id -> who holds it, by login or `team <slug>`. */
function countHolders(file: PermissionsFile): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (id: string, label: string) => { const list = m.get(id) ?? []; list.push(label); m.set(id, list); };
  for (const [login, p] of Object.entries(file.people)) for (const id of p.presets ?? []) add(id, login);
  for (const [slug, t] of Object.entries(file.teams)) for (const id of t.presets ?? []) add(id, `team ${slug}`);
  return m;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "preset";
}

function entriesEqual(a: PermissionEntry, b: PermissionEntry): boolean {
  return JSON.stringify([a.grant ?? [], a.revoke ?? []]) === JSON.stringify([b.grant ?? [], b.revoke ?? []]);
}

// ── the dry-run banner ────────────────────────────────────────────────

function DryRunBanner({ enforced, fileEmpty, canMigrate }: {
  enforced: boolean; fileEmpty: boolean; canMigrate: boolean;
}) {
  const show = fileEmpty || !enforced;
  const { data: rows, isLoading } = useQuery({
    queryKey: ["admin", "dry-run"],
    queryFn: fetchDryRun,
    enabled: show,
    staleTime: 60_000,
  });
  const qc = useQueryClient();
  const migrate = useMutation({
    mutationFn: runMigration,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });

  if (!show) return null;

  const losing = (rows ?? []).filter(r => r.losing.length > 0);

  return (
    <Note intent={fileEmpty ? "info" : "warn"}>
      {fileEmpty ? (
        <>
          <p className="font-semibold">Nothing has been generated yet.</p>
          <p className="mt-1">
            Running the migration writes a starting file that reproduces today's access exactly, in
            presets rather than as a per-person copy of it — so the flip to enforcement changes nothing
            on day one. Narrowing what people hold happens afterward, deliberately, one person at a time.
          </p>
        </>
      ) : (
        <>
          <p className="font-semibold">Enforcement is off.</p>
          <p className="mt-1">
            {isLoading ? (
              "Checking what would change if it were switched on…"
            ) : losing.length === 0 ? (
              "With this file in force, nobody would lose anything they hold today."
            ) : (
              <>
                With this file in force, {losing.length} {losing.length === 1 ? "person" : "people"} would
                lose access to at least one thing they hold today
                {losing.length <= 8 ? <>: {losing.map(r => r.login).join(", ")}.</> : "."}
              </>
            )}
          </p>
        </>
      )}

      {canMigrate && fileEmpty && (
        <div className="mt-3">
          <Button variant="primary" onClick={() => migrate.mutate()} disabled={migrate.isPending}>
            {migrate.isPending ? "Running the migration…" : "Run the migration"}
          </Button>
          {migrate.isError && (
            <p className="mt-2 text-[0.8125rem] text-crimson">{(migrate.error as Error).message}</p>
          )}
        </div>
      )}
    </Note>
  );
}

// ── People ────────────────────────────────────────────────────────────

function PeopleView({ file, onOpen }: { file: PermissionsFile; onOpen: (login: string) => void }) {
  const [query, setQuery] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(file.people)
      .map(([login, entry]) => ({ login, entry }))
      .filter(({ entry }) => !onlyEmpty
        || (!(entry.presets?.length) && !(entry.grant?.length) && !(entry.revoke?.length)))
      .filter(({ login }) => !q || login.includes(q))
      .sort((a, b) => a.login.localeCompare(b.login));
  }, [file, query, onlyEmpty]);

  const exact = rows.some(r => r.login === query.trim().toLowerCase());

  return (
    <>
      <div className="flex items-end gap-6 mb-6 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <SearchInput value={query} onChange={setQuery} placeholder="Find a login, or type one to open it" />
        </div>
        <label className="flex items-center gap-2 caps text-ink-2 cursor-pointer pb-2.5">
          <input type="checkbox" checked={onlyEmpty} onChange={e => setOnlyEmpty(e.target.checked)} />
          Holds nothing
        </label>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nobody matches"
          body={query.trim()
            ? `Nobody named "${query.trim()}" is in the file yet. Open it directly to grant them something.`
            : "Nobody is named in the file yet."}
          action={query.trim()
            ? <Button variant="primary" onClick={() => onOpen(query.trim())}>Open {query.trim()}</Button>
            : undefined}
        />
      ) : (
        <div className="grid gap-2">
          {rows.map(({ login, entry }, i) => (
            <PersonRow key={login} login={login} entry={entry} file={file} index={i}
              onOpen={() => onOpen(login)} />
          ))}
        </div>
      )}

      {rows.length > 0 && query.trim() && !exact && (
        <p className="mt-4">
          <button className="textlink caps" onClick={() => onOpen(query.trim())}>
            Open "{query.trim()}" — nobody by that name is in the file yet
          </button>
        </p>
      )}
    </>
  );
}

function PersonRow({ login, entry, file, index, onOpen }: {
  login: string; entry: PersonEntry; file: PermissionsFile; index: number; onOpen: () => void;
}) {
  const hasOverrides = !!(entry.grant?.length || entry.revoke?.length);
  const presetLabel = (entry.presets ?? []).length === 0
    ? "No preset"
    : entry.presets!.map(id => file.presets[id]?.name ?? id).join(", ");

  return (
    <RailCard intent={hasOverrides ? "warn" : "neutral"} index={index} onClick={onOpen}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <span className="display text-[1.0625rem] text-ink">{login}</span>
          <p className="text-[0.7812rem] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{presetLabel}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {hasOverrides && <Pill intent="warn">Overrides</Pill>}
          {entry.note && (
            <span className="text-[0.75rem] text-ink-3 max-w-[24ch] truncate" title={entry.note}>{entry.note}</span>
          )}
        </div>
      </div>
    </RailCard>
  );
}

// ── Person ────────────────────────────────────────────────────────────

function PersonDetail({ login, file, sha, vocabulary, canEdit, onBack, onSaved }: {
  login: string; file: PermissionsFile; sha: string | null; vocabulary: PermissionLeaf[];
  canEdit: boolean; onBack: () => void; onSaved: () => void;
}) {
  const loginKey = login.toLowerCase();
  const existing = file.people[loginKey];

  const { data: access, isLoading } = useQuery({
    queryKey: ["admin", "person", loginKey],
    queryFn: () => fetchPersonAccess(loginKey),
  });

  const [entry, setEntry] = useState<PermissionEntry>({ grant: existing?.grant, revoke: existing?.revoke });
  const [note, setNote] = useState(existing?.note ?? "");
  const [summary, setSummary] = useState(`Update permissions for ${loginKey}`);

  // The draft mirrors whichever login is open; opening a different one from
  // the list re-mounts nothing (this is the same component instance), so the
  // draft has to be reset by hand rather than by a fresh `useState` default.
  useEffect(() => {
    setEntry({ grant: existing?.grant, revoke: existing?.revoke });
    setNote(existing?.note ?? "");
    setSummary(`Update permissions for ${loginKey}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginKey]);

  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const nextEntry: PersonEntry = {
        ...existing,
        grant: entry.grant,
        revoke: entry.revoke,
        note: note.trim() ? note.trim() : undefined,
      };
      const nextFile: PermissionsFile = { ...file, people: { ...file.people, [loginKey]: nextEntry } };
      return saveAdminFile(nextFile, sha, summary.trim() || `Update permissions for ${loginKey}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "file"] });
      qc.invalidateQueries({ queryKey: ["admin", "person", loginKey] });
      onSaved();
    },
  });

  const inherited = useMemo(() => inheritedFromExplanations(access?.explanations), [access]);
  const dirty = !entriesEqual(entry, { grant: existing?.grant, revoke: existing?.revoke })
    || note.trim() !== (existing?.note ?? "");

  const presetLabel = (existing?.presets ?? []).length === 0
    ? "No preset assigned. Everything below is granted directly."
    : `Holds ${existing!.presets!.map(id => file.presets[id]?.name ?? id).join(", ")}.`;

  return (
    <>
      <Back onClick={onBack}>People</Back>
      <Sheet>
        <SheetHeader title={loginKey} subtitle={presetLabel} />

        {isLoading ? (
          <div className="py-16 flex justify-center"><Spinner label="Reading their access" /></div>
        ) : (
          <>
            <Block title="Permissions">
              <PermissionTree vocabulary={vocabulary} inherited={inherited} entry={entry}
                onChange={setEntry} readOnly={!canEdit} />
            </Block>

            <Block title="Note">
              <textarea value={note} onChange={e => setNote(e.target.value)} disabled={!canEdit}
                placeholder="Why does this person hold what they hold? Visible to any other administrator."
                className="w-full bg-paper-2 border border-rule px-3 py-2 text-[0.8438rem] text-ink min-h-[4.5rem] disabled:text-ink-3" />
            </Block>

            {canEdit && (
              <Block title="Save">
                <div className="flex items-center gap-4 flex-wrap">
                  <input value={summary} onChange={e => setSummary(e.target.value)}
                    placeholder="What changed, and why" className={SURFACE.input} style={{ maxWidth: "32rem" }} />
                  <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
                {save.isError && (
                  <p className="mt-3 text-[0.8125rem] text-crimson">{(save.error as Error).message}</p>
                )}
              </Block>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}

// ── Presets ───────────────────────────────────────────────────────────

function PresetsListView({ file, onOpen, onCreate }: {
  file: PermissionsFile; onOpen: (id: string) => void; onCreate: () => void;
}) {
  const holders = useMemo(() => countHolders(file), [file]);
  const entries = useMemo(
    () => Object.entries(file.presets).sort(([, a], [, b]) => a.name.localeCompare(b.name)),
    [file],
  );

  return (
    <>
      <div className="flex justify-end mb-5">
        <Button variant="primary" onClick={onCreate}>New preset</Button>
      </div>

      {entries.length === 0 ? (
        <Empty title="No presets yet" body="Run the migration from the banner above, or create one here." />
      ) : (
        <div className="grid gap-2">
          {entries.map(([id, preset], i) => {
            const n = holders.get(id)?.length ?? 0;
            return (
              <RailCard key={id} intent="neutral" index={i} onClick={() => onOpen(id)}>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <span className="display text-[1.0625rem] text-ink">{preset.name}</span>
                    {preset.inherits && (
                      <span className="ml-2 text-[0.75rem] text-ink-3">
                        inherits {file.presets[preset.inherits]?.name ?? preset.inherits}
                      </span>
                    )}
                    {preset.description && (
                      <p className="text-[0.7812rem] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                        {preset.description}
                      </p>
                    )}
                  </div>
                  <span className="text-[0.75rem] text-ink-3 shrink-0 tabular-nums">
                    {n} holder{n === 1 ? "" : "s"}
                  </span>
                </div>
              </RailCard>
            );
          })}
        </div>
      )}
    </>
  );
}

function PresetDetail({ presetId, file, sha, vocabulary, canEdit, onBack, onSaved }: {
  presetId: string | "new"; file: PermissionsFile; sha: string | null; vocabulary: PermissionLeaf[];
  canEdit: boolean; onBack: () => void; onSaved: () => void;
}) {
  const isNew = presetId === "new";
  const existing = isNew ? undefined : file.presets[presetId];

  const [id, setId] = useState(isNew ? "" : presetId);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [inherits, setInherits] = useState(existing?.inherits ?? "");
  const [entry, setEntry] = useState<PermissionEntry>({ grant: existing?.grant, revoke: existing?.revoke });
  const [summary, setSummary] = useState(
    isNew ? "Create a preset" : `Edit the ${existing?.name ?? presetId} preset`,
  );
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const holders = useMemo(
    () => countHolders(file).get(isNew ? id : presetId) ?? [],
    [file, presetId, id, isNew],
  );

  const otherPresets = useMemo(
    () => Object.entries(file.presets).filter(([pid]) => pid !== presetId),
    [file, presetId],
  );

  const inherited = useMemo(
    () => inherits ? resolvePresetChain(file.presets, inherits, 0) : [],
    [file.presets, inherits],
  );

  // The id a new preset would actually save under, and whether that collides
  // with one that already exists — checked ahead of the click, not discovered
  // by it silently overwriting whatever was already there.
  const finalId = isNew ? slugify(id || name) : presetId;
  const idCollision = isNew && !!file.presets[finalId];

  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const nextPreset: Preset = {
        name: name.trim(),
        description: description.trim() || undefined,
        inherits: inherits || undefined,
        grant: entry.grant,
        revoke: entry.revoke,
      };
      const nextFile: PermissionsFile = { ...file, presets: { ...file.presets, [finalId]: nextPreset } };
      return saveAdminFile(nextFile, sha, summary.trim() || `${isNew ? "Create" : "Edit"} the ${name} preset`);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "file"] }); onSaved(); },
  });

  const del = useMutation({
    mutationFn: () => {
      const nextPresets = { ...file.presets };
      delete nextPresets[presetId];
      const nextFile: PermissionsFile = { ...file, presets: nextPresets };
      return saveAdminFile(nextFile, sha, `Delete the ${existing?.name ?? presetId} preset`);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "file"] }); onSaved(); },
  });

  const requestSave = () => {
    if (!isNew && holders.length > 0) setConfirmSave(true);
    else save.mutate();
  };

  const canSave = name.trim().length > 0 && (!isNew || id.trim().length > 0) && !idCollision && !save.isPending;

  return (
    <>
      <Back onClick={onBack}>Presets</Back>
      <Sheet>
        <SheetHeader
          title={isNew ? "New preset" : existing?.name ?? presetId}
          subtitle={isNew
            ? "Held by nobody until it is assigned to a person or a team."
            : `Held by ${holders.length} ${holders.length === 1 ? "person or team" : "people and teams"}.`}
        />

        <Block title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            {isNew && (
              <label className="block">
                <span className="caps block mb-1.5">Id</span>
                <input value={id} onChange={e => setId(e.target.value)} placeholder="engineer"
                  disabled={!canEdit} className={SURFACE.input} />
                <span className="text-[0.75rem] text-ink-3 mt-1 block">
                  Saves as <span className="font-mono">{finalId}</span>.
                  {idCollision && <span className="text-crimson"> A preset by that id already exists.</span>}
                </span>
              </label>
            )}
            <label className="block">
              <span className="caps block mb-1.5">Name</span>
              <input value={name} onChange={e => setName(e.target.value)} disabled={!canEdit}
                className={SURFACE.input} />
            </label>
            <label className="block sm:col-span-2">
              <span className="caps block mb-1.5">Description</span>
              <input value={description} onChange={e => setDescription(e.target.value)} disabled={!canEdit}
                className={SURFACE.input} />
            </label>
            <label className="block">
              <span className="caps block mb-1.5">Inherits</span>
              <select value={inherits} onChange={e => setInherits(e.target.value)} disabled={!canEdit}
                className={SURFACE.input}>
                <option value="">Nothing</option>
                {otherPresets.map(([pid, p]) => <option key={pid} value={pid}>{p.name}</option>)}
              </select>
            </label>
          </div>
        </Block>

        <Block title="Permissions">
          <PermissionTree vocabulary={vocabulary} inherited={inherited} entry={entry}
            onChange={setEntry} readOnly={!canEdit} />
        </Block>

        {holders.length > 0 && (
          <Block title="Who holds this">
            <p className="text-[0.8125rem] text-ink-2">{holders.join(", ")}</p>
          </Block>
        )}

        {canEdit && (
          <Block title="Save">
            <div className="flex items-center gap-4 flex-wrap">
              <input value={summary} onChange={e => setSummary(e.target.value)}
                placeholder="What changed, and why" className={SURFACE.input} style={{ maxWidth: "32rem" }} />
              <Button variant="primary" disabled={!canSave} onClick={requestSave}>
                {save.isPending ? "Saving…" : isNew ? "Create" : "Save"}
              </Button>
              {!isNew && (
                <Button variant="secondary" disabled={holders.length > 0 || del.isPending}
                  onClick={() => setConfirmDelete(true)}>
                  {del.isPending ? "Deleting…" : "Delete"}
                </Button>
              )}
            </div>
            {!isNew && holders.length > 0 && (
              <p className="mt-2 text-[0.75rem] text-ink-3">
                Held by {holders.length}, so it cannot be deleted until nobody holds it.
              </p>
            )}
            {(save.isError || del.isError) && (
              <p className="mt-3 text-[0.8125rem] text-crimson">
                {((save.error ?? del.error) as Error).message}
              </p>
            )}
          </Block>
        )}
      </Sheet>

      <ConfirmDialog open={confirmSave} onClose={() => setConfirmSave(false)}
        onConfirm={() => { setConfirmSave(false); save.mutate(); }}
        title="This will change how people are governed"
        body={<>This will change {holders.length} {holders.length === 1 ? "person" : "people"}: {holders.join(", ")}.</>}
        confirmLabel="Save anyway" intent="warn" busy={save.isPending} />

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); del.mutate(); }}
        title={`Delete ${existing?.name ?? presetId}?`}
        body="This cannot be undone from here. It stays in the file's git history if it needs recovering."
        confirmLabel="Delete" intent="danger" busy={del.isPending} />
    </>
  );
}

// ── Audit ─────────────────────────────────────────────────────────────

function AuditScreen() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin", "audit"], queryFn: fetchAudit, staleTime: 60_000,
  });

  return (
    <>
      <Note intent="neutral">
        This is the history of policy — who changed what, and when. Team membership changes do not
        appear here: membership lives on GitHub, not in this file.
      </Note>

      {isLoading && <Spinner label="Reading the audit log" />}
      {!isLoading && isError && <LoadFailed what="the audit log" error={error} onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        (data ?? []).length === 0 ? (
          <Empty title="No history yet" body="Nothing has been committed to the permissions file." />
        ) : (
          <div className="grid gap-2">
            {(data ?? []).map((entry, i) => <AuditRow key={entry.sha} entry={entry} index={i} />)}
          </div>
        )
      )}
    </>
  );
}

function AuditRow({ entry, index }: { entry: AuditEntry; index: number }) {
  const lines = entry.message.split("\n").map(l => l.trim()).filter(Boolean);
  const summary = lines[0] ?? entry.message;
  const rest = lines.slice(1).join(" ");
  const when = ago(entry.date) ?? (entry.date ? new Date(entry.date).toLocaleString() : "unknown time");

  return (
    <RailCard intent="neutral" index={index}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-[0.9375rem] text-ink font-semibold">{summary}</p>
          {rest && <p className="text-[0.7812rem] text-ink-3 mt-1">{rest}</p>}
        </div>
        <div className="text-right shrink-0">
          <p className="text-[0.75rem] text-ink-2">{entry.author}</p>
          <p className="text-[0.6875rem] text-ink-3 mt-0.5">{when}</p>
        </div>
      </div>
    </RailCard>
  );
}

// ── the page ──────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user } = useAuth();
  const { can, permissions } = usePermissionSet();

  const [mode, setMode] = useState<"people" | "presets" | "audit">("people");
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [openPreset, setOpenPreset] = useState<string | "new" | null>(null);

  const { data: vocab } = useQuery({
    queryKey: ["admin", "vocabulary"], queryFn: fetchVocabulary, staleTime: Infinity,
  });
  const { data: adminFile, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin", "file"], queryFn: fetchAdminFile, staleTime: 30_000,
  });

  const qc = useQueryClient();
  const bootstrap = useMutation({
    mutationFn: () => bootstrapAdmin(true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "file"] }),
  });

  const canEdit = can("admin.people.assign");
  const vocabulary = vocab?.permissions ?? [];

  const loaded: AdminFile | null = adminFile && !isAdminFileFailure(adminFile) ? adminFile : null;
  const file = loaded?.file ?? null;
  const sha = loaded?.sha ?? null;

  if (file && openPerson) {
    return (
      <Page user={user}>
        <PersonDetail login={openPerson} file={file} sha={sha} vocabulary={vocabulary} canEdit={canEdit}
          onBack={() => setOpenPerson(null)} onSaved={() => setOpenPerson(null)} />
      </Page>
    );
  }

  if (file && openPreset !== null) {
    return (
      <Page user={user}>
        <PresetDetail presetId={openPreset} file={file} sha={sha} vocabulary={vocabulary} canEdit={canEdit}
          onBack={() => setOpenPreset(null)} onSaved={() => setOpenPreset(null)} />
      </Page>
    );
  }

  return (
    <Page user={user}>
      <header className="mb-7 pb-3 border-b-2 border-ink">
        <h1 className={`${TYPE.title} text-ink`}>Admin</h1>
        <p className={`${TYPE.standfirst} mt-2 max-w-[58ch]`}>
          Who holds what, and why — the file permissions.json reads, one commit at a time.
        </p>
      </header>

      {isLoading && <Spinner label="Reading the permissions file" />}

      {!isLoading && isError && <LoadFailed what="the permissions file" error={error} onRetry={() => refetch()} />}

      {!isLoading && !isError && adminFile && isAdminFileFailure(adminFile) && (
        <Note intent="danger">
          <p className="font-semibold">The permissions file could not be read.</p>
          <p className="mt-1">{adminFile.failure.detail}</p>
          {adminFile.failure.problems && adminFile.failure.problems.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {adminFile.failure.problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
        </Note>
      )}

      {!isLoading && !isError && loaded && loaded.source === "no-repo" && (
        <Note intent="warn">
          <p className="font-semibold">There is nowhere to store this yet.</p>
          <p className="mt-1">The permissions repository does not exist in this organization.</p>
          {canEdit && (
            <div className="mt-3">
              <Button variant="primary" onClick={() => bootstrap.mutate()} disabled={bootstrap.isPending}>
                {bootstrap.isPending ? "Creating…" : "Create the permissions repository"}
              </Button>
              {bootstrap.isError && (
                <p className="mt-2 text-[0.8125rem] text-crimson">{(bootstrap.error as Error).message}</p>
              )}
            </div>
          )}
        </Note>
      )}

      {file && loaded && loaded.source !== "no-repo" && (
        <>
          <DryRunBanner enforced={permissions?.enforced ?? false}
            fileEmpty={Object.keys(file.people).length === 0} canMigrate={canEdit} />

          {loaded.unknownNodes.length > 0 && (
            <Note intent="neutral">
              The file names {loaded.unknownNodes.length} permission{loaded.unknownNodes.length === 1 ? "" : "s"}{" "}
              this version of the app does not have: {loaded.unknownNodes.join(", ")}. Ignored, not enforced.
            </Note>
          )}

          <div className="mb-6">
            <Segmented value={mode} onChange={setMode}
              options={[["people", "People"], ["presets", "Presets"], ["audit", "Audit"]]} />
          </div>

          {mode === "people" && <PeopleView file={file} onOpen={setOpenPerson} />}
          {mode === "presets" && (
            <PresetsListView file={file} onOpen={setOpenPreset} onCreate={() => setOpenPreset("new")} />
          )}
          {mode === "audit" && <AuditScreen />}
        </>
      )}
    </Page>
  );
}
