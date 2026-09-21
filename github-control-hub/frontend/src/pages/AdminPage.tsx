import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../App";
import {
  Page, Back, Note, Pill, Empty, Spinner, RailCard, Sheet, SheetHeader, Block,
  SearchInput, Segmented, Button, LoadFailed, ConfirmDialog, SURFACE, TYPE,
} from "../design";
import { usePermissionSet } from "../hooks/usePermissionSet";
import PermissionTree from "../components/PermissionTree";
import { ApiError } from "../api/client";
import { knownNodesOf } from "../components/permissionTreeModel";
import { diffAccount, heldFromFile } from "../components/permissionDiff";
import { sliceOf, withPresetChange } from "../components/accountEntries";
import PermissionDiffDialog from "../components/PermissionDiffDialog";
import {
  fetchVocabulary, fetchAdminFile, saveAdminFile, fetchPersonAccess, fetchAudit, fetchOrgMembers,
  bootstrapAdmin, fetchDryRun, runMigration, isAdminFileFailure, fetchResolvedPreset,
  type AdminFile, type PermissionsFile, type PermissionEntry, type PersonEntry, type Preset,
  type AccountEntry, type AwsAccountEntry, type PermissionLeaf, type AuditEntry, type FlatRule,
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
 * The layer beneath whatever this screen is about to edit, as the server
 * reports it — rules only relabelled for display, never recomputed here.
 *
 * This used to be derived from the `explanations` map, by dropping every leaf
 * whose origin read "set on this person" and turning the rest into leaf-depth
 * rules. That looked like the same thing and was not, twice over:
 *
 *   - `explanations` reports the rule that won *overall*. A leaf this person's
 *     own `revoke` was suppressing appears there as not held, which is
 *     indistinguishable from a leaf nothing grants — so the baseline agreed
 *     with the revoke, `collapseEntry` emitted no rule for it, and the next
 *     unrelated tick rewrote the entry without it. Fifteen AWS leaves came
 *     back while the tree went on showing fourteen of them unticked.
 *   - Leaf depth is not the depth the rule was written at, and `decideLeaf` —
 *     here and on the server alike — ranks depth above layer. A person-layer
 *     `revoke: ["aws"]` therefore lost to the client's leaf-depth inherited
 *     grants and won against the server's real `aws`: un-ticking the branch
 *     moved no checkbox and revoked fourteen leaves on save.
 *
 * `GET /admin/person/:login` and `GET /admin/preset/:id/resolved` now answer
 * with `inherited` and `baseline` directly, from the server's own evaluator.
 * Nothing is reconstructed on this side, so nothing on this side can disagree
 * about what a person already holds.
 */
function inheritedFrom(rules?: FlatRule[]): FlatRule[] {
  return (rules ?? []).map(r => ({ ...r, origin: `From ${r.origin}` }));
}

/** The server's baseline, in the shape `collapseEntry` reads it. */
function baselineFrom(baseline?: Record<string, boolean>): Map<string, boolean> | undefined {
  return baseline ? new Map(Object.entries(baseline)) : undefined;
}

/**
 * Which presets an entry assigns, whichever shape it is written in.
 *
 * An entry with no `accounts` map is a legacy one — written before accounts
 * existed, and applying in all of them. Once it has per-account entries, those
 * are what count. This is the same rule `sliceFor` applies on the server, and
 * the two have to agree: when they did not, a preset reported forty-eight
 * holders on one screen and none on the next.
 */
function presetsAssignedBy(entry: { presets?: string[]; accounts?: Record<string, AccountEntry> }): string[] {
  const byAccount = entry.accounts;
  if (!byAccount || Object.keys(byAccount).length === 0) return entry.presets ?? [];
  return [...new Set(Object.values(byAccount).flatMap(a => a.presets ?? []))];
}

/** Every preset id -> who holds it, by login or `team <slug>`. */
function countHolders(file: PermissionsFile): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (id: string, label: string) => { const list = m.get(id) ?? []; list.push(label); m.set(id, list); };
  for (const [login, p] of Object.entries(file.people)) for (const id of presetsAssignedBy(p)) add(id, login);
  for (const [slug, t] of Object.entries(file.teams)) for (const id of presetsAssignedBy(t)) add(id, `team ${slug}`);
  return m;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "preset";
}

function entriesEqual(a: PermissionEntry, b: PermissionEntry): boolean {
  return JSON.stringify([a.grant ?? [], a.revoke ?? []]) === JSON.stringify([b.grant ?? [], b.revoke ?? []]);
}

/** Same members, regardless of order — a reorder is not an edit worth a save. */
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every(v => sb.has(v));
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

  /**
   * The organization's own roster, not just the file's.
   *
   * Searching `file.people` alone meant the only people the screen could offer
   * were the ones who had already been granted something — so adding anybody
   * new required typing their login exactly, from memory, and a typo made an
   * entry that matched no account and said nothing about it.
   *
   * A failure here is not fatal: the file's own entries still list and a login
   * can still be opened directly, which is what the screen did before.
   */
  const { data: roster, isLoading: rosterLoading, isError: rosterFailed } = useQuery({
    queryKey: ["admin", "org-members"], queryFn: fetchOrgMembers,
    /**
     * Thirty seconds, not five minutes. This roster is what says who is on the
     * admin team, and the save path asks GitHub fresh every time — so with a
     * five-minute cache somebody who had just joined the team showed as
     * configurable here while every save on them was refused as exempt.
     */
    staleTime: 30_000, refetchOnWindowFocus: true,
  });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const named = new Set(Object.keys(file.people));

    // Everyone in the file, plus everyone in the organization who is not in it
    // yet. The second group is what makes somebody addable without knowing how
    // they spell their username.
    const exempt = new Set((roster ?? []).filter(m => m.exempt).map(m => m.login.toLowerCase()));

    const all = [
      ...Object.entries(file.people)
        .map(([login, entry]) => ({ login, entry, inFile: true, exempt: exempt.has(login) })),
      ...(roster ?? [])
        .filter(m => !named.has(m.login.toLowerCase()))
        .map(m => ({
          login: m.login.toLowerCase(), entry: {} as PersonEntry,
          inFile: false, exempt: m.exempt === true,
        })),
    ];

    return all
      .filter(({ entry, inFile }) => !onlyEmpty || !inFile
        || (!(entry.presets?.length) && !(entry.grant?.length) && !(entry.revoke?.length)))
      .filter(({ login }) => !q || login.includes(q))
      .sort((a, b) => a.login.localeCompare(b.login));
  }, [file, roster, query, onlyEmpty]);

  const exact = rows.some(r => r.login === query.trim().toLowerCase());

  return (
    <>
      <div className="flex items-end gap-6 mb-6 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <SearchInput value={query} onChange={setQuery}
            placeholder={rosterFailed
              ? "Type a login to open it — the organization's roster could not be read"
              : rosterLoading ? "Loading the organization…" : "Search anyone in the organization"} />
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
            ? `No member of the organization matches "${query.trim()}". If they are an outside `
              + "collaborator rather than a member, open the login directly."
            : "Nobody is named in the file yet."}
          action={query.trim()
            ? <Button variant="primary" onClick={() => onOpen(query.trim())}>Open {query.trim()}</Button>
            : undefined}
        />
      ) : (
        <div className="grid gap-2">
          {rows.map(({ login, entry, inFile, exempt }, i) => (
            <PersonRow key={login} login={login} entry={entry} file={file} index={i}
              inFile={inFile} exempt={exempt} onOpen={() => onOpen(login)} />
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

function PersonRow({ login, entry, file, index, inFile, exempt, onOpen }: {
  login: string; entry: PersonEntry; file: PermissionsFile; index: number;
  inFile: boolean; exempt: boolean; onOpen: () => void;
}) {
  const hasOverrides = !exempt && !!(entry.grant?.length || entry.revoke?.length);
  const presetLabel = exempt
    ? "On the Control Hub admin team — holds everything, not configurable here"
    : !inFile
      ? "In the organization, holds nothing here yet"
      : (entry.presets ?? []).length === 0
        ? "No preset"
        : entry.presets!.map(id => file.presets[id]?.name ?? id).join(", ");

  return (
    <RailCard intent={hasOverrides ? "warn" : "neutral"} index={index} onClick={onOpen}>
      {/*
        * Muted, the same way the pickers grey out rows that cannot be chosen.
        * Still openable — seeing what somebody holds is the point of the tab —
        * but it reads at a glance as "not configurable here" rather than only
        * saying so in a pill on the far side of the row.
        */}
      <div className={`flex items-center justify-between gap-4 flex-wrap ${exempt ? "opacity-55" : ""}`}>
        <div className="min-w-0">
          <span className="display text-[1.0625rem] text-ink">{login}</span>
          <p className="text-[0.7812rem] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{presetLabel}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {exempt && <Pill intent="info">Admin team</Pill>}
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

function PersonDetail({ login, file, sha, vocabulary, canOverride, canAssign, onBack, onSaved, accounts,}: {
  login: string; file: PermissionsFile; sha: string | null; vocabulary: PermissionLeaf[];
  /** The permission tree: grant/revoke one permission for this person. */
  canOverride: boolean;
  /** The preset multi-select: which presets this person holds. */
  canAssign: boolean;
  onBack: () => void; onSaved: () => void;
  accounts: Record<string, string>;
}) {
  const loginKey = login.toLowerCase();
  const existing = file.people[loginKey];

  const { data: access, isLoading } = useQuery({
    queryKey: ["admin", "person", loginKey],
    queryFn: () => fetchPersonAccess(loginKey),
  });

  /**
   * The accounts this person can be configured in, and the one being edited.
   *
   * An account is a configured environment — some with GitHub, some AWS-only —
   * and each has its own tabs, so each gets its own permissions. With none
   * declared there is a single unscoped draft, which is the pre-account shape
   * and what a file written before accounts uses.
   */
  const accountIds = useMemo(() => Object.keys(accounts).sort(
    (a, b) => (accounts[a] ?? a).localeCompare(accounts[b] ?? b)), [accounts]);
  const scoped = accountIds.length > 0;

  const draftFor = (accountId: string | null): PermissionEntry & { presets?: string[] } => {
    // `sliceOf` reads a legacy entry — the shape the migration writes — as
    // applying in every account. Reading it as empty showed a migrated person
    // with nothing in any tab, and saving would have written that back.
    const from = sliceOf(existing, accountId);
    return { presets: from.presets ?? [], grant: from.grant, revoke: from.revoke };
  };

  const [tab, setTab] = useState<string | null>(accountIds[0] ?? null);
  const [drafts, setDrafts] = useState<Record<string, PermissionEntry & { presets?: string[] }>>(() =>
    scoped
      ? Object.fromEntries(accountIds.map(id => [id, draftFor(id)]))
      : { "": draftFor(null) });
  const [note, setNote] = useState(existing?.note ?? "");
  const [summary, setSummary] = useState(`Update permissions for ${loginKey}`);
  const [confirming, setConfirming] = useState(false);

  const tabKey = scoped ? (tab ?? accountIds[0] ?? "") : "";
  const draft = drafts[tabKey] ?? { presets: [] };
  const entry: PermissionEntry = { grant: draft.grant, revoke: draft.revoke };
  const presets = draft.presets ?? [];

  const patchDraft = (patch: Partial<PermissionEntry & { presets?: string[] }>) =>
    setDrafts(prev => ({ ...prev, [tabKey]: { ...prev[tabKey], ...patch } }));

  const setEntry = (next: PermissionEntry) => patchDraft({ grant: next.grant, revoke: next.revoke });
  const setPresets = (next: string[] | ((p: string[]) => string[])) =>
    patchDraft({ presets: typeof next === "function" ? next(presets) : next });

  // The draft mirrors whichever login is open; opening a different one from
  // the list re-mounts nothing (this is the same component instance), so the
  // draft has to be reset by hand rather than by a fresh `useState` default.
  useEffect(() => {
    setDrafts(scoped
      ? Object.fromEntries(accountIds.map(id => [id, draftFor(id)]))
      : { "": draftFor(null) });
    setTab(accountIds[0] ?? null);
    setNote(existing?.note ?? "");
    setSummary(`Update permissions for ${loginKey}`);
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginKey, accountIds.join(",")]);

  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const trim = (d: PermissionEntry & { presets?: string[] }) => ({
        presets: d.presets?.length ? d.presets : undefined,
        grant: d.grant?.length ? d.grant : undefined,
        revoke: d.revoke?.length ? d.revoke : undefined,
      });

      /**
       * Per-account entries when accounts are declared, the pre-account fields
       * when they are not. Never both: an entry carrying a top-level grant
       * *and* per-account entries would read as though the top-level one
       * applied everywhere, which is exactly what per-account access exists to
       * stop.
       */
      const nextEntry: PersonEntry = scoped
        ? {
            ...existing,
            presets: undefined, grant: undefined, revoke: undefined,
            accounts: Object.fromEntries(accountIds.map(id => [id, trim(drafts[id] ?? {})])),
            note: note.trim() ? note.trim() : undefined,
          }
        : {
            ...existing,
            ...trim(drafts[""] ?? {}),
            note: note.trim() ? note.trim() : undefined,
          };
      const nextFile: PermissionsFile = { ...file, people: { ...file.people, [loginKey]: nextEntry } };
      return saveAdminFile(nextFile, sha, summary.trim() || `Update permissions for ${loginKey}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "file"] });
      qc.invalidateQueries({ queryKey: ["admin", "person", loginKey] });
      setConfirming(false);
      onSaved();
    },
    /**
     * The server knows before this screen does. When it refuses because the
     * person is on the admin team, re-read who is — so the screen locks and
     * says why, instead of showing the error and carrying on offering an edit
     * that can never be saved.
     */
    onError: (err) => {
      if (err instanceof ApiError && err.code === "EXEMPT_SUBJECT") {
        qc.invalidateQueries({ queryKey: ["admin", "org-members"] });
        qc.invalidateQueries({ queryKey: ["admin", "person", loginKey] });
        setConfirming(false);
      }
    },
  });

  /**
   * What the save will change, per account. Computed against each account's own
   * baseline, because a permission can be inherited in one account and not in
   * another — so "gains Fix a finding" is only true where the layers beneath
   * did not already grant it.
   */
  const diffs = useMemo(() => {
    if (!scoped) {
      return [diffAccount("", "This install", vocabulary,
        { grant: existing?.grant, revoke: existing?.revoke },
        drafts[""] ?? {},
        access?.baseline ?? {}, inheritedFrom(access?.inherited))];
    }
    return accountIds.map(id => diffAccount(
      id, accounts[id] ?? id, vocabulary,
      sliceOf(existing, id),
      drafts[id] ?? {},
      access?.perAccount?.[id]?.baseline ?? {},
      inheritedFrom(access?.perAccount?.[id]?.rules),
    )).filter(d => !d.unchanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, accountIds.join(","), drafts, existing, access, vocabulary]);

  const storedPresetsFor = (accountId: string) =>
    sliceOf(existing, scoped ? accountId : null).presets ?? [];
  const presetsChanged = !sameMembers(presets, storedPresetsFor(tabKey));

  /**
   * Assigning a preset has to move the tree's baseline before anybody saves,
   * or the tree keeps showing what the *stored* presets grant while the
   * multi-select above it already disagrees.
   *
   * While the selection matches what is stored, `access.explanations` — the
   * server's own resolution of this person's teams and presets together — is
   * exactly right and is used as-is. Once it stops matching, this asks the
   * server what each *selected* preset resolves to on its own
   * (`GET /admin/preset/:id/resolved`, the same route the Presets editor
   * uses) and unions them. That drops this person's **team-derived** rules
   * from the preview for as long as the edit is in progress, because this
   * route answers for a preset rather than for a person.
   *
   * That was called "a preview simplification rather than a correctness gap in
   * what gets saved", and it was not: the tree's edits are a diff against this
   * baseline, so an incomplete baseline is a wrong diff. A tick made against it
   * would write rules for branches the preview had dropped. The tree is
   * therefore read-only while the selection is dirty — save the preset change,
   * let the server re-resolve the person, then edit — which is the honest
   * version of the same screen and costs one save.
   */
  const presetQueries = useQueries({
    queries: (presetsChanged ? presets : []).map(id => ({
      queryKey: ["admin", "preset", id, "resolved"],
      queryFn: () => fetchResolvedPreset(id),
      staleTime: 30_000,
    })),
  });

  /**
   * The layers beneath this person **in the account being edited**. The server
   * computes one standing per declared account; the unscoped pair is the
   * fallback for an install that has declared none.
   */
  const scopedStanding = scoped ? access?.perAccount?.[tabKey] : undefined;

  const inherited = useMemo(() => {
    if (!presetsChanged) {
      return inheritedFrom(scoped ? scopedStanding?.rules : access?.inherited);
    }
    return presetQueries.flatMap(q => inheritedFrom(q.data?.inherited));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetsChanged, access, scoped, tabKey, presetQueries.map(q => q.dataUpdatedAt).join(",")]);

  /**
   * The server's own baseline, while it is the one that answers for this
   * person. Once the preset selection is dirty there is no such answer — the
   * preset route answers for presets, not for people, so her team-derived
   * rules are missing — and the tree is read-only until the change is saved;
   * it derives a baseline from `inherited` there, and nothing is written
   * against it.
   */
  const baseline = useMemo(
    () => (presetsChanged
      ? undefined
      : baselineFrom(scoped ? scopedStanding?.baseline : access?.baseline)),
    [presetsChanged, access, scoped, tabKey],
  );

  /**
   * The server could not read this person's GitHub teams, so `baseline` is
   * missing whatever those teams grant.
   *
   * This locks the tree for the same reason a dirty preset selection does, and
   * it is not a cosmetic caveat: the tree saves the difference between what is
   * ticked and the baseline, so an understated baseline makes this person's own
   * revokes look redundant, and the next tick — on any leaf at all — drops them
   * and hands back everything they were suppressing. Editing against a baseline
   * we know is wrong is the one thing this screen must not do.
   */
  const baselineIncomplete = access?.teamsUnavailable === true;

  /**
   * On the Control Hub admin team, so they hold everything by membership and
   * an entry here would decide nothing. The screen stays readable — seeing
   * what somebody holds is the point of opening it — but every control that
   * would compose a restriction is off, because a restriction that will never
   * take effect is worse than none: it reads, to the next administrator, as
   * one that is in force.
   */
  const exempt = access?.exempt === true;

  /**
   * Whether anything is set on this person directly, as opposed to reaching
   * them through a preset or a team. Clearing these is the way to say "give
   * them exactly what the preset says and nothing else" — without it, undoing
   * a scatter of earlier overrides means finding and un-ticking each one, and
   * a missed one is invisible because it looks the same as an inherited tick.
   */
  const overrideCount = (entry.grant?.length ?? 0) + (entry.revoke?.length ?? 0);
  const hasOverrides = overrideCount > 0;

  /**
   * Dirty across *every* account, not just the one on screen. Copying this
   * account's permissions onto another changes a draft the current tab is not
   * showing, and a Save button that only watched the visible tab would stay
   * disabled over a real change.
   */
  const anyAccountChanged = scoped
    ? accountIds.some(id => {
        // Compared against what applies there, not the raw per-account slot:
        // for a legacy entry the slot is empty and the draft is not, which would
        // report a change nobody made and enable Save on an untouched person.
        const stored = sliceOf(existing, id);
        const d = drafts[id] ?? {};
        return !entriesEqual({ grant: d.grant, revoke: d.revoke },
                             { grant: stored?.grant, revoke: stored?.revoke })
          || !sameMembers(d.presets ?? [], stored?.presets ?? []);
      })
    : !entriesEqual({ grant: drafts[""]?.grant, revoke: drafts[""]?.revoke },
                    { grant: existing?.grant, revoke: existing?.revoke })
      || !sameMembers(drafts[""]?.presets ?? [], existing?.presets ?? []);

  const dirty = anyAccountChanged || note.trim() !== (existing?.note ?? "");

  const storedPresets = storedPresetsFor(tabKey);
  const presetLabel = storedPresets.length === 0
    ? scoped
      ? `No preset assigned in ${accounts[tabKey] ?? tabKey}. Everything below is granted directly.`
      : "No preset assigned. Everything below is granted directly."
    : `Holds ${storedPresets.map(id => file.presets[id]?.name ?? id).join(", ")}`
      + (scoped ? ` in ${accounts[tabKey] ?? tabKey}.` : ".");

  const presetEntries = useMemo(
    () => Object.entries(file.presets).sort(([, a], [, b]) => a.name.localeCompare(b.name)),
    [file],
  );

  const togglePreset = (id: string) => {
    setPresets(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  return (
    <>
      <Back onClick={onBack}>People</Back>
      <Sheet>
        <SheetHeader title={loginKey} subtitle={presetLabel} />

        {isLoading ? (
          <div className="py-16 flex justify-center"><Spinner label="Reading their access" /></div>
        ) : (
          <>
            {(canAssign || (existing?.presets ?? []).length > 0) && (
              <Block title="Presets">
                {presetEntries.length === 0 ? (
                  <p className={`${TYPE.body} text-ink-3`}>No presets exist yet. Create one on the Presets tab.</p>
                ) : (
                  <div className="grid gap-2">
                    {presetEntries.map(([id, preset]) => (
                      <label key={id}
                        className={`flex items-center gap-2.5 ${canAssign ? "cursor-pointer" : ""}`}>
                        <input type="checkbox" checked={presets.includes(id)} disabled={!canAssign || exempt}
                          onChange={() => togglePreset(id)} className="shrink-0" />
                        <span className={`${TYPE.body} text-ink`}>{preset.name}</span>
                        {preset.description && (
                          <span className="text-[0.75rem] text-ink-3">— {preset.description}</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </Block>
            )}

            {scoped && (
              <Block title="Account">
                <Segmented value={tabKey} onChange={setTab}
                  options={accountIds.map(id => [id, accounts[id] ?? id] as [string, string])} />
                <p className={`${TYPE.sub} text-ink-3 mt-2`}>
                  Each account is configured separately, and an account {loginKey} has been given
                  nothing in grants them nothing there.
                  {access?.installAccount === tabKey
                    ? " This is the account this install enforces."
                    : access?.installAccount
                      ? " This install enforces a different account; changes here apply where that account runs."
                      : ""}
                </p>

                {canOverride && !exempt && accountIds.length > 1 && (
                  <div className="mt-3 flex items-center gap-3 flex-wrap">
                    <span className={`${TYPE.sub} text-ink-2`}>Copy this account's permissions to</span>
                    {accountIds.filter(id => id !== tabKey).map(id => (
                      <Button key={id} variant="ghost"
                        onClick={() => setDrafts(prev => ({ ...prev, [id]: { ...prev[tabKey] } }))}>
                        {accounts[id] ?? id}
                      </Button>
                    ))}
                    <Button variant="ghost"
                      onClick={() => setDrafts(prev => Object.fromEntries(
                        accountIds.map(id => [id, { ...prev[tabKey] }])))}>
                      all of them
                    </Button>
                  </div>
                )}
              </Block>
            )}

            <Block title="Permissions">
              {exempt && (
                <Note intent="info">
                  {loginKey} is on the Control Hub admin team, which holds every permission in the
                  app — the GitHub side and the AWS side both. Nothing set here would change that,
                  so nothing here can be set. To narrow what they can do, take them off that team
                  on GitHub; membership is the grant, and it is visible there rather than
                  contradicted by an entry in here.
                </Note>
              )}
              {presetsChanged && (
                <p className={`${TYPE.sub} text-ink-2 mb-3`}>
                  The preset selection above has changed, so what {loginKey} inherits is not
                  settled yet. Save that first — the permissions below are edited as a
                  difference from what their presets and teams already give them, and that
                  answer is only right once the server has re-resolved it.
                </p>
              )}
              {baselineIncomplete && (
                <Note intent="warn">
                  GitHub could not be asked which teams {loginKey} is on, so what they already
                  inherit is not fully known here. Permissions are edited as a difference from
                  that answer, so editing now could quietly undo a restriction they hold.
                  Reload once GitHub is reachable.
                </Note>
              )}
              {Object.keys(accounts).length > 0 && !exempt && (
                <p className={`${TYPE.sub} text-ink-2 mb-3`}>
                  To give {loginKey} different access in different AWS accounts, open{" "}
                  <strong className="text-ink">AWS → Per-account access</strong>. Anything ticked
                  directly under AWS applies to every account, including ones added later.
                </p>
              )}

              <PermissionTree vocabulary={vocabulary} inherited={inherited} baseline={baseline} entry={entry}
                onChange={setEntry} readOnly={!canOverride || presetsChanged || baselineIncomplete || exempt} />

              {canOverride && !presetsChanged && !baselineIncomplete && hasOverrides && (
                <div className="mt-4 flex items-center gap-3 flex-wrap">
                  <Button variant="ghost" onClick={() => setEntry({})}>Clear this person's overrides</Button>
                  <span className={`${TYPE.sub} text-ink-3`}>
                    Removes everything set on {loginKey} directly — {overrideCount}{" "}
                    {overrideCount === 1 ? "entry" : "entries"} — and leaves them with exactly what
                    their presets and teams give them. Takes effect when you save.
                  </span>
                </div>
              )}
            </Block>

            <Block title="Note">
              <textarea value={note} onChange={e => setNote(e.target.value)} disabled={!canOverride || exempt}
                placeholder="Why does this person hold what they hold? Visible to any other administrator."
                className="w-full bg-paper-2 border border-rule px-3 py-2 text-[0.8438rem] text-ink min-h-[4.5rem] disabled:text-ink-3" />
            </Block>

            {(canOverride || canAssign) && !exempt && (
              <Block title="Save">
                {/*
                  * The preview diffs what the entries *decide*, not the entries
                  * themselves. Two entries that look nothing alike can decide
                  * the same thing, and two differing by a character can decide
                  * something very different — so a textual diff would report
                  * noise and miss substance. This answers the question somebody
                  * is actually asking: what will this person be able to do,
                  * where, that they could not before.
                  */}
                {dirty && diffs.length > 0 && (
                  <div className="mb-4 grid gap-3">
                    {diffs.map(d => (
                      <RailCard key={d.accountId} intent={d.lost.length ? "warn" : "neutral"} index={0}>
                        <div className="min-w-0">
                          <span className="display text-[1.0625rem] text-ink">{d.name}</span>
                          {d.unchanged ? (
                            <p className={`${TYPE.sub} text-ink-3 mt-1`}>No change.</p>
                          ) : (
                            <div className="mt-1 grid gap-1">
                              {d.gained.length > 0 && (
                                <p className={`${TYPE.sub} text-ink-2`}>
                                  <strong className="text-ink">Gains {d.gained.length}:</strong>{" "}
                                  {d.gained.slice(0, 6).map(l => l.label).join(", ")}
                                  {d.gained.length > 6 && `, and ${d.gained.length - 6} more`}
                                </p>
                              )}
                              {d.lost.length > 0 && (
                                <p className={`${TYPE.sub} text-ink-2`}>
                                  <strong className="text-ink">Loses {d.lost.length}:</strong>{" "}
                                  {d.lost.slice(0, 6).map(l => l.label).join(", ")}
                                  {d.lost.length > 6 && `, and ${d.lost.length - 6} more`}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </RailCard>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-4 flex-wrap">
                  <input value={summary} onChange={e => setSummary(e.target.value)}
                    placeholder="What changed, and why" className={SURFACE.input} style={{ maxWidth: "32rem" }} />
                  {/*
                    * Review, then save. The summary above answers "is this
                    * roughly right"; the dialog answers "what exactly am I
                    * about to do", which is the question worth asking before
                    * changing what somebody can do in production.
                    */}
                  <Button variant="primary" disabled={!dirty || save.isPending}
                    onClick={() => setConfirming(true)}>
                    {save.isPending ? "Saving…" : "Review and save"}
                  </Button>
                </div>
                {save.isError && (
                  <p className="mt-3 text-[0.8125rem] text-crimson">{(save.error as Error).message}</p>
                )}

                {confirming && (
                  <PermissionDiffDialog
                    title={`Changes to ${loginKey}`}
                    subtitle={scoped ? "Reviewed one account at a time." : undefined}
                    diffs={diffs}
                    notes={note.trim() !== (existing?.note ?? "") ? ["Note changed"] : []}
                    confirming={save.isPending}
                    onCancel={() => setConfirming(false)}
                    onConfirm={() => save.mutate()}
                  />
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

function PresetsListView({ file, canCreate, onOpen, onCreate }: {
  file: PermissionsFile; canCreate: boolean; onOpen: (id: string) => void; onCreate: () => void;
}) {
  const holders = useMemo(() => countHolders(file), [file]);
  const entries = useMemo(
    () => Object.entries(file.presets).sort(([, a], [, b]) => a.name.localeCompare(b.name)),
    [file],
  );

  return (
    <>
      {canCreate && (
        <div className="flex justify-end mb-5">
          <Button variant="primary" onClick={onCreate}>New preset</Button>
        </div>
      )}

      {entries.length === 0 ? (
        <Empty title="No presets yet"
          body={canCreate
            ? "Run the migration from the banner above, or create one here."
            : "Run the migration from the banner above, or ask an administrator to create one."} />
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

function PresetDetail({ presetId, file, sha, vocabulary, canEditFields, canDelete, canAssign, onBack, onSaved, accounts,}: {
  presetId: string | "new"; file: PermissionsFile; sha: string | null; vocabulary: PermissionLeaf[];
  /**
   * `admin.people.assign` — handing this preset to people is assigning a
   * preset, which is a different authority from editing the preset itself.
   * Somebody who may hand out bundles need not be able to redefine them.
   */
  canAssign: boolean;
  /** `admin.presets.create` for a new preset, `admin.presets.edit` for an existing one. */
  canEditFields: boolean;
  /** `admin.presets.delete`. Independent of `canEditFields`: holding one does not imply the other. */
  canDelete: boolean;
  onBack: () => void; onSaved: () => void;
  accounts: Record<string, string>;
}) {
  const isNew = presetId === "new";
  const existing = isNew ? undefined : file.presets[presetId];

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
    // A preset being created holds nobody yet, and `finalId` moves as the name
    // is typed — looking it up would report the holders of whatever existing
    // preset the half-typed name happens to collide with.
    () => (isNew ? [] : countHolders(file).get(presetId) ?? []),
    [file, presetId, isNew],
  );

  const otherPresets = useMemo(
    () => Object.entries(file.presets).filter(([pid]) => pid !== presetId),
    [file, presetId],
  );

  /**
   * Handing this preset to people, or taking it back, from the preset's own
   * page.
   *
   * The alternative is opening each person in turn, and a preset exists
   * precisely because the same decision applies to several people — so making
   * them one-at-a-time work is making the feature argue with itself.
   *
   * Accounts: a preset is assigned *per account*, so applying one means
   * choosing where. "Every account" is the common case and the default; the
   * per-account tabs are for when somebody should have it in sandbox only.
   */
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTo, setAssignTo] = useState<Set<string>>(new Set());
  const [assignAccounts, setAssignAccounts] = useState<Set<string>>(
    () => new Set(Object.keys(accounts)));
  const [assignMode, setAssignMode] = useState<"apply" | "remove">("apply");
  const [assignSearch, setAssignSearch] = useState("");

  const scopedHere = Object.keys(accounts).length > 0;

  const qcAssign = useQueryClient();
  const assignSave = useMutation({
    mutationFn: () => saveAdminFile(assignedFile, sha,
      `${assignMode === "apply" ? "Apply" : "Remove"} the ${existing?.name ?? presetId} preset `
      + `${assignMode === "apply" ? "to" : "from"} ${selected.size} `
      + `${selected.size === 1 ? "person" : "people"}`),
    onSuccess: () => {
      qcAssign.invalidateQueries({ queryKey: ["admin"] });
      setAssignOpen(false);
      setAssignTo(new Set());
    },
    // As on the person screen: an exempt refusal means the roster is stale.
    // Re-reading it greys those people out and drops them from `selected`.
    onError: (err) => {
      if (err instanceof ApiError && err.code === "EXEMPT_SUBJECT") {
        qcAssign.invalidateQueries({ queryKey: ["admin", "org-members"] });
        setAssignOpen(false);
      }
    },
  });

  /** Who holds this preset, per account, so the list can say where. */
  const holdsIn = (login: string): string[] => {
    const person = file.people[login];
    if (!person) return [];
    if (!scopedHere) return (sliceOf(person, null).presets ?? []).includes(presetId) ? [""] : [];
    return Object.keys(accounts)
      .filter(accountId => (sliceOf(person, accountId).presets ?? []).includes(presetId));
  };

  /**
   * Who can be picked, and why the rest cannot — computed once, and read by
   * both the list and "Select everyone".
   *
   * They used to decide separately: the list greyed rows out, and "Select
   * everyone" took every login in the file regardless, including the greyed
   * ones. Two rules for one question is how they drifted.
   *
   * Members of the Control Hub admin team are never pickable. They hold every
   * permission by membership, the server refuses any entry naming them, and a
   * screen that lets you select them only to fail on save is a screen that
   * lied about what it could do.
   */
  const { data: rosterForAssign } = useQuery({
    queryKey: ["admin", "org-members"], queryFn: fetchOrgMembers,
    staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const exemptLogins = useMemo(
    () => new Set((rosterForAssign ?? []).filter(m => m.exempt).map(m => m.login.toLowerCase())),
    [rosterForAssign],
  );

  const candidates = useMemo(() => Object.keys(file.people).sort().map(login => {
    const where = holdsIn(login);
    const already = where.length > 0;
    const exempt = exemptLogins.has(login);
    const eligible = !exempt && (assignMode === "apply" ? !already || scopedHere : already);
    const reason = exempt
      ? "On the Control Hub admin team — holds everything already"
      : !eligible
        ? (assignMode === "apply" ? "Already holds it" : "Does not hold it")
        : null;
    return { login, where, already, exempt, eligible, reason };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [file, exemptLogins, assignMode, scopedHere, presetId, accounts]);

  /**
   * What will actually be saved: the selection, narrowed to rows that are
   * eligible *now*. The roster refreshes while somebody is choosing, so a person
   * selected a minute ago can since have joined the admin team — acting on them
   * anyway is exactly the save the server would refuse.
   */
  const selected = useMemo(() => {
    const ok = new Set(candidates.filter(c => c.eligible).map(c => c.login));
    return new Set([...assignTo].filter(login => ok.has(login)));
  }, [assignTo, candidates]);

  /** The file as it would be after applying or removing this preset. */
  /**
   * The file after the change, built by the same tested function everything
   * else uses. It used to be written inline and edited only the per-account
   * slots, so removing a preset from a migrated person — who holds it at the
   * top level — changed nothing and the review said so.
   */
  const assignedFile = useMemo((): PermissionsFile => withPresetChange(
    file, selected, presetId, assignMode,
    scopedHere ? [...assignAccounts] : [],
    Object.keys(accounts),
  ), [file, selected, assignAccounts, assignMode, presetId, scopedHere, accounts]);

  /**
   * One entry per person, not per account: on this screen the question is
   * "what does this do to each of these people", and grouping by account would
   * bury the person's name under a heading they all share.
   */
  const assignDiffs = useMemo(() => {
    const known = knownNodesOf(vocabulary);
    const at = (f: PermissionsFile, login: string, accountId: string) => {
      const person = f.people[login];
      const slice = sliceOf(person, scopedHere ? accountId : null);
      return heldFromFile(vocabulary, f.presets, slice?.presets ?? [], slice, known);
    };

    const accountsToShow = scopedHere ? Object.keys(accounts) : [""];

    return [...selected].sort().flatMap(login =>
      accountsToShow.map(accountId => {
        const before = at(file, login, accountId);
        const after = at(assignedFile, login, accountId);
        const gained = vocabulary.filter(l => !before.has(l.key) && after.has(l.key))
          .map(l => ({ key: l.key, label: l.label }));
        const lost = vocabulary.filter(l => before.has(l.key) && !after.has(l.key))
          .map(l => ({ key: l.key, label: l.label }));
        return {
          accountId: `${login}:${accountId}`,
          name: scopedHere ? `${login} — ${accounts[accountId] ?? accountId}` : login,
          gained, lost,
          unchanged: gained.length === 0 && lost.length === 0,
        };
      }));
  }, [selected, file, assignedFile, vocabulary, accounts, scopedHere]);


  /**
   * What `inherits` actually grants, resolved by the server's own
   * `resolvePreset` rather than a client-side port of it — `GET
   * /admin/preset/:id/resolved` answers for a chain that has not been saved
   * yet too, since it resolves whichever existing preset `inherits` currently
   * names from the stored file, independent of whatever this screen has
   * drafted for the preset being edited.
   */
  const { data: inheritsData } = useQuery({
    queryKey: ["admin", "preset", inherits, "resolved"],
    queryFn: () => fetchResolvedPreset(inherits),
    enabled: !!inherits,
    staleTime: 30_000,
  });
  const inherited = useMemo(() => inheritedFrom(inheritsData?.inherited), [inheritsData]);
  const baseline = useMemo(() => baselineFrom(inheritsData?.baseline), [inheritsData]);

  // The id a new preset would actually save under, and whether that collides
  // with one that already exists — checked ahead of the click, not discovered
  // by it silently overwriting whatever was already there.
  const finalId = isNew ? slugify(name) : presetId;
  const idCollision = isNew && !!file.presets[finalId];

  const qc = useQueryClient();

  /** The file as it would be saved — one value, used by the review and the save alike. */
  const presetFile = useMemo((): PermissionsFile => ({
    ...file,
    presets: {
      ...file.presets,
      [finalId]: {
        name: name.trim(),
        description: description.trim() || undefined,
        inherits: inherits || undefined,
        grant: entry.grant,
        revoke: entry.revoke,
      } as Preset,
    },
  }), [file, finalId, name, description, inherits, entry]);

  /**
   * What saving this preset changes, reviewed before it is written.
   *
   * First, the preset itself: what it grants before and after. Then each
   * person who holds it, in each account, as they would actually end up —
   * because presets add up, taking something out of this one changes nothing
   * for somebody whose other preset still gives it, and the review should say
   * so rather than implying everybody loses it.
   *
   * It used to confirm only when somebody already held the preset, with a
   * generic "are you sure" and no diff; a new preset, or one nobody held yet,
   * saved with no review at all.
   */
  const presetDiffs = useMemo(() => {
    const known = knownNodesOf(vocabulary);
    const heldBy = (f: PermissionsFile, presets: string[], own?: PermissionEntry) =>
      heldFromFile(vocabulary, f.presets, presets, own, known);
    const change = (accountId: string, label: string, before: Set<string>, after: Set<string>) => {
      const gained = vocabulary.filter(l => !before.has(l.key) && after.has(l.key))
        .map(l => ({ key: l.key, label: l.label }));
      const lost = vocabulary.filter(l => before.has(l.key) && !after.has(l.key))
        .map(l => ({ key: l.key, label: l.label }));
      return { accountId, name: label, gained, lost, unchanged: gained.length === 0 && lost.length === 0 };
    };

    const itself = change("__preset__", `The ${name.trim() || "new"} preset itself`,
      isNew ? new Set<string>() : heldBy(file, [presetId]),
      heldBy(presetFile, [finalId]));

    const accountIds = Object.keys(accounts);
    const holderRows = isNew ? [] : Object.keys(file.people).flatMap(login => {
      const person = file.people[login];
      return (accountIds.length ? accountIds : [null]).flatMap(accountId => {
        const slice = sliceOf(person, accountId);
        if (!(slice.presets ?? []).includes(presetId)) return [];
        return [change(
          `${login}:${accountId ?? ""}`,
          accountId ? `${login} — ${accounts[accountId] ?? accountId}` : login,
          heldBy(file, slice.presets ?? [], slice),
          heldBy(presetFile, slice.presets ?? [], slice),
        )];
      });
    });

    return [itself, ...holderRows];
  }, [file, presetFile, presetId, finalId, isNew, name, vocabulary, accounts]);

  /** What changes that is not a permission, so a rename is still a reviewable, saveable change. */
  const presetNotes = useMemo(() => {
    const out: string[] = [];
    if (isNew) {
      out.push(`Creates the preset "${name.trim()}", saved as ${finalId}`);
      return out;
    }
    if (name.trim() !== (existing?.name ?? "")) out.push(`Renamed from "${existing?.name ?? ""}" to "${name.trim()}"`);
    if ((description.trim() || undefined) !== (existing?.description || undefined)) out.push("Description changed");
    if ((inherits || undefined) !== (existing?.inherits || undefined)) {
      out.push(inherits
        ? `Now inherits ${file.presets[inherits]?.name ?? inherits}`
        : "No longer inherits another preset");
    }
    return out;
  }, [isNew, name, finalId, description, inherits, existing, file]);

  const save = useMutation({
    mutationFn: () => saveAdminFile(presetFile, sha,
      summary.trim() || `${isNew ? "Create" : "Edit"} the ${name} preset`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "file"] }); setConfirmSave(false); onSaved(); },
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

  // Always through the review. See `presetDiffs`.
  const requestSave = () => setConfirmSave(true);

  // The name is the only thing asked for, so it is the only thing required.
  const canSave = name.trim().length > 0 && !idCollision && !save.isPending;

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
            {/*
              * No id field. It is derived from the name, which is the only
              * thing anybody creating a preset has an opinion about — asking
              * for both means asking a question whose answer is "whatever you
              * just typed, with hyphens", and then making somebody feel they
              * got it wrong. The derived id is shown, because it is what the
              * file stores and what a collision would be about.
              */}
            <label className="block sm:col-span-2">
              <span className="caps block mb-1.5">Name</span>
              <input value={name} onChange={e => setName(e.target.value)} disabled={!canEditFields}
                placeholder="Engineer" className={SURFACE.input} />
              {isNew && name.trim() !== "" && (
                <span className="text-[0.75rem] text-ink-3 mt-1 block">
                  Saved as <span className="font-mono">{finalId}</span>.
                  {idCollision && <span className="text-crimson"> A preset by that id already exists.</span>}
                </span>
              )}
            </label>
            <label className="block sm:col-span-2">
              <span className="caps block mb-1.5">Description</span>
              <input value={description} onChange={e => setDescription(e.target.value)} disabled={!canEditFields}
                className={SURFACE.input} />
            </label>
            <label className="block">
              <span className="caps block mb-1.5">Inherits</span>
              <select value={inherits} onChange={e => setInherits(e.target.value)} disabled={!canEditFields}
                className={SURFACE.input}>
                <option value="">Nothing</option>
                {otherPresets.map(([pid, p]) => <option key={pid} value={pid}>{p.name}</option>)}
              </select>
            </label>
          </div>
        </Block>

        <Block title="Permissions">
          <PermissionTree vocabulary={vocabulary} inherited={inherited} baseline={baseline} entry={entry}
            onChange={setEntry} readOnly={!canEditFields} />
        </Block>

        {holders.length > 0 && (
          <Block title="Who holds this">
            <p className="text-[0.8125rem] text-ink-2">{holders.join(", ")}</p>
          </Block>
        )}

        {assignOpen && (
          <PermissionDiffDialog
            title={`${assignMode === "apply" ? "Applying" : "Removing"} ${existing?.name ?? presetId}`}
            subtitle={`${selected.size} ${selected.size === 1 ? "person" : "people"}. `
              + "Shows what the file gives them; access from their GitHub teams is not included."}
            diffs={assignDiffs}
            confirming={assignSave.isPending}
            onCancel={() => setAssignOpen(false)}
            onConfirm={() => assignSave.mutate()}
          />
        )}

        {!isNew && canAssign && (
          <Block title="Apply to people">
            <div className="flex items-center gap-3 flex-wrap mb-3">
              <Segmented value={assignMode} onChange={m => { setAssignMode(m); setAssignTo(new Set()); }}
                options={[["apply", "Apply to"], ["remove", "Remove from"]]} />
              <div className="flex-1 min-w-[200px]">
                <SearchInput value={assignSearch} onChange={setAssignSearch}
                  placeholder="Find people" />
              </div>
            </div>

            {scopedHere && assignMode === "apply" && (
              <div className="mb-3">
                <span className="caps text-ink-2">In which accounts</span>
                <div className="grid gap-1.5 mt-1.5">
                  {Object.entries(accounts).map(([accountId, label]) => (
                    <label key={accountId} className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={assignAccounts.has(accountId)}
                        onChange={() => setAssignAccounts(prev => {
                          const next = new Set(prev);
                          if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
                          return next;
                        })} />
                      <span className={`${TYPE.body} text-ink`}>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/*
              * Everybody the file knows about, with where they already hold it
              * shown beside them — so "apply to everyone" is a decision made
              * with the current state visible rather than a guess.
              *
              * Headed, because the account checkboxes sit directly above and
              * arrive pre-ticked: two unlabelled lists, one ticked and one not,
              * read as a single list where the accounts are the only things
              * anybody has selected.
              */}
            <span className="caps text-ink-2">
              {assignMode === "apply" ? "Who to apply it to" : "Who to remove it from"}
            </span>
            <div className="grid gap-1.5 max-h-[18rem] overflow-y-auto mt-1.5">
              {candidates
                .filter(({ login }) => !assignSearch.trim() || login.includes(assignSearch.trim().toLowerCase()))
                .map(({ login, where, already, eligible, reason }) => {
                  return (
                    <label key={login} title={reason ?? undefined}
                      className={`flex items-center gap-2.5 ${eligible ? "cursor-pointer" : "opacity-45"}`}>
                      <input type="checkbox" checked={assignTo.has(login)} disabled={!eligible}
                        onChange={() => setAssignTo(prev => {
                          const next = new Set(prev);
                          if (next.has(login)) next.delete(login); else next.add(login);
                          return next;
                        })} />
                      <span className={`${TYPE.body} text-ink`}>{login}</span>
                      {reason && !already ? (
                        <span className={`${TYPE.sub} text-ink-3`}>{reason}</span>
                      ) : already && (
                        <span className={`${TYPE.sub} text-ink-3`}>
                          holds it{scopedHere && ` in ${where.map(a => accounts[a] ?? a).join(", ")}`}
                        </span>
                      )}
                    </label>
                  );
                })}
            </div>

            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <Button variant="ghost"
                onClick={() => setAssignTo(new Set(candidates.filter(c => c.eligible).map(c => c.login)))}>
                Select everyone eligible ({candidates.filter(c => c.eligible).length})
              </Button>
              <Button variant="ghost" onClick={() => setAssignTo(new Set())}>Clear</Button>
              <Button variant="primary" disabled={selected.size === 0}
                onClick={() => setAssignOpen(true)}>
                Review {assignMode === "apply" ? "applying" : "removing"} for {selected.size}
              </Button>
            </div>
          </Block>
        )}

        {(canEditFields || (!isNew && canDelete)) && (
          <Block title="Save">
            <div className="flex items-center gap-4 flex-wrap">
              <input value={summary} onChange={e => setSummary(e.target.value)}
                placeholder="What changed, and why" className={SURFACE.input} style={{ maxWidth: "32rem" }} />
              {canEditFields && (
                <Button variant="primary" disabled={!canSave} onClick={requestSave}>
                  {save.isPending ? "Saving…" : isNew ? "Create" : "Save"}
                </Button>
              )}
              {!isNew && canDelete && (
                <Button variant="secondary" disabled={holders.length > 0 || del.isPending}
                  onClick={() => setConfirmDelete(true)}>
                  {del.isPending ? "Deleting…" : "Delete"}
                </Button>
              )}
            </div>
            {!isNew && canDelete && holders.length > 0 && (
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

      {confirmSave && (
        <PermissionDiffDialog
          title={isNew ? `Creating ${name.trim() || "a preset"}` : `Changes to ${existing?.name ?? presetId}`}
          subtitle={isNew
            ? "Nobody holds it yet."
            : `${holders.length} ${holders.length === 1 ? "holder" : "holders"}. `
              + "Each holder is shown as they would actually end up; access from their GitHub teams is not included."}
          diffs={presetDiffs}
          notes={presetNotes}
          confirming={save.isPending}
          onCancel={() => setConfirmSave(false)}
          onConfirm={() => save.mutate()}
        />
      )}

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); del.mutate(); }}
        title={`Delete ${existing?.name ?? presetId}?`}
        body="This cannot be undone from here. It stays in the file's git history if it needs recovering."
        confirmLabel="Delete" intent="danger" busy={del.isPending} />
    </>
  );
}

type AdminMode = "people" | "presets" | "audit" | "aws";

// ── AWS accounts ──────────────────────────────────────────────────────

/**
 * Which AWS accounts this organization wants to scope permissions by.
 *
 * Declaring one adds a tab to every person's permissions, so
 * "remediate in sandbox, read-only in production" becomes expressible. It does
 * **not** give the app credentials for that account — that is a separate piece
 * of setup — which is why an account can be declared here long before the
 * guardrail engine can reach it, and why the list says which ones are live.
 */
function AwsAccountsView({ file, sha, live, canEdit, onSaved }: {
  file: PermissionsFile; sha: string | null; live: string[];
  canEdit: boolean; onSaved: () => void;
}) {
  const [rows, setRows] = useState<AwsAccountEntry[]>(() => file.awsAccounts ?? []);
  const [id, setId] = useState("");
  const [name, setName] = useState("");

  /**
   * The sha this screen will write against.
   *
   * Every save returns the new one, and a second save made before the refetch
   * lands would otherwise still be carrying the sha from before the first —
   * which GitHub refuses as a conflict. Adding two accounts in a row is the
   * obvious thing to do here, so it has to work without waiting.
   */
  const [liveSha, setLiveSha] = useState<string | null>(sha);
  useEffect(() => { setLiveSha(sha); }, [sha]);

  useEffect(() => { setRows(file.awsAccounts ?? []); }, [file]);

  const save = useMutation({
    mutationFn: (next: AwsAccountEntry[]) =>
      saveAdminFile({ ...file, awsAccounts: next }, liveSha, "Update the AWS account list"),
    onSuccess: (result) => { setLiveSha(result.sha); onSaved(); },
    // The optimistic row goes back if the save failed, so the screen never
    // shows an account the file does not have.
    onError: () => setRows(file.awsAccounts ?? []),
  });

  const idOk = /^[0-9]{12}$/.test(id.trim());
  const duplicate = rows.some(r => r.accountId === id.trim());

  const add = () => {
    const next = [...rows, { accountId: id.trim(), name: name.trim() }];
    setRows(next); setId(""); setName(""); save.mutate(next);
  };

  const remove = (accountId: string) => {
    const next = rows.filter(r => r.accountId !== accountId);
    setRows(next); save.mutate(next);
  };

  return (
    <Sheet>
      <SheetHeader title="AWS accounts"
        subtitle="Each one becomes a branch of the permission tree, so access can be granted per account." />

      <Block title="Declared">
        {rows.length === 0 ? (
          <p className={`${TYPE.body} text-ink-3`}>
            None yet. Until an account is declared here, AWS permissions apply to every account at
            once — granting <code>aws.remediate</code> means remediating anywhere.
          </p>
        ) : (
          <div className="grid gap-2">
            {rows.map((row, i) => (
              <RailCard key={row.accountId} intent="neutral" index={i}>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <span className="display text-[1.0625rem] text-ink">{row.name}</span>
                    <p className="text-[0.7812rem] text-slate-500 dark:text-slate-400 mt-0.5">
                      {row.accountId}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {live.includes(row.accountId)
                      ? <Pill intent="good">Reachable</Pill>
                      : <Pill intent="neutral">Declared only</Pill>}
                    {canEdit && (
                      <Button variant="ghost" onClick={() => remove(row.accountId)}>Remove</Button>
                    )}
                  </div>
                </div>
              </RailCard>
            ))}
          </div>
        )}
      </Block>

      {canEdit && (
        <Block title="Add an account">
          <div className="flex items-end gap-3 flex-wrap">
            <label className="grid gap-1">
              <span className="caps text-ink-2">Account ID</span>
              <input value={id} onChange={e => setId(e.target.value.replace(/\D/g, "").slice(0, 12))}
                placeholder="twelve digits" className={SURFACE.input} />
            </label>
            <label className="grid gap-1 flex-1 min-w-[180px]">
              <span className="caps text-ink-2">Name</span>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="prod, sandbox…" className={SURFACE.input} />
            </label>
            <Button variant="primary" disabled={!idOk || !name.trim() || duplicate || save.isPending}
              onClick={add}>
              {save.isPending ? "Saving…" : "Add"}
            </Button>
          </div>
          {id.trim() !== "" && !idOk && (
            <p className={`${TYPE.sub} text-ink-3 mt-2`}>
              An AWS account id is twelve digits. It becomes part of every permission key for this
              account, so anything else would invent branches nobody can grant.
            </p>
          )}
          {duplicate && (
            <p className={`${TYPE.sub} text-ink-3 mt-2`}>That account is already declared.</p>
          )}
          {save.isError && (
            <p className="mt-2 text-[0.8125rem] text-crimson">{(save.error as Error).message}</p>
          )}
        </Block>
      )}

      <Block title="What this does not do">
        <p className={`${TYPE.body} text-ink-2`}>
          Declaring an account here does not give the app credentials for it. It says the account
          exists and is worth granting permissions about — the guardrail engine reaches an account
          only once its access is configured separately. An account marked <em>Declared only</em> can
          still have permissions written for it today; they take effect when it becomes reachable.
        </p>
      </Block>
    </Sheet>
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

  const [mode, setMode] = useState<AdminMode>("people");
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [openPreset, setOpenPreset] = useState<string | "new" | null>(null);

  const { data: vocab } = useQuery({
    queryKey: ["admin", "vocabulary"], queryFn: fetchVocabulary,
    /**
     * Not `Infinity` any more. It was right while the vocabulary was a fixed
     * list, and stopped being right the moment declaring an AWS account could
     * add branches to it — a cached-forever vocabulary means the account you
     * just added has nothing to grant until a reload.
     */
    staleTime: 60_000,
  });

  // Five distinct capabilities, threaded to where each belongs, rather than
  // one `canEdit` gating all of People and Presets at once — see the brief:
  // the preset editor gated on a *people* permission is the bug this fixes.
  const canPeopleRead = can("admin.people.read");
  const canPresetsRead = can("admin.presets.read");
  // Declaring an AWS account changes what the whole organization can be
  // granted, which is the same kind of act as editing a preset.
  const canPresetsEdit = can("admin.presets.edit");
  const canAuditRead = can("admin.audit.read");
  const canAssign = can("admin.people.assign");
  const canOverride = can("admin.people.override");
  const canCreatePreset = can("admin.presets.create");
  const canEditPresets = can("admin.presets.edit");
  const canDeletePresets = can("admin.presets.delete");

  // GET /file answers to either People's or Presets' read permission — no
  // point asking for it (and no organization-wide right to be denied on)
  // when the viewer holds neither.
  const canReadFile = canPeopleRead || canPresetsRead;
  const { data: adminFile, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin", "file"], queryFn: fetchAdminFile, staleTime: 30_000, enabled: canReadFile,
  });

  const qc = useQueryClient();
  const bootstrap = useMutation({
    mutationFn: () => bootstrapAdmin(true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "file"] }),
  });

  const vocabulary = vocab?.permissions ?? [];
  /**
   * `{ id: name }` for the account branches. Memoised because it is a prop on
   * the tree, and a fresh object each render would rebuild the whole tree on
   * every keystroke elsewhere on the screen.
   */
  const accountNames = useMemo(
    () => Object.fromEntries((vocab?.accounts ?? []).map(a => [a.accountId, a.name])),
    [vocab]);

  const loaded: AdminFile | null = adminFile && !isAdminFileFailure(adminFile) ? adminFile : null;
  const file = loaded?.file ?? null;
  const sha = loaded?.sha ?? null;

  // The three list views, filtered to the ones the viewer actually holds —
  // `Segmented` used to offer all three unconditionally, so somebody without
  // `admin.audit.read` could open Audit and collect a 403 for their trouble.
  const tabOptions: [AdminMode, string][] = [];
  if (canPeopleRead) tabOptions.push(["people", "People"]);
  if (canPresetsRead) tabOptions.push(["presets", "Presets"]);
  if (canAuditRead) tabOptions.push(["audit", "Audit"]);
  /**
   * Declaring an AWS account is an organization-wide change to what can be
   * granted, so it sits behind the same permission as editing a preset rather
   * than behind an AWS permission — the person doing it is shaping the
   * permission tree, not operating AWS.
   */
  if (canPresetsRead) tabOptions.push(["aws", "AWS accounts"]);
  // Falls back to `mode` itself when `tabOptions` is empty (nothing renders
  // that reads it then) purely to keep this typed as a real mode, not
  // `| undefined`, for the branch below where it does.
  const activeMode = tabOptions.some(([v]) => v === mode) ? mode : (tabOptions[0]?.[0] ?? mode);

  if (file && openPerson) {
    return (
      <Page user={user}>
        <PersonDetail login={openPerson} file={file} sha={sha} vocabulary={vocabulary} accounts={accountNames}
          canOverride={canOverride} canAssign={canAssign}
          onBack={() => setOpenPerson(null)} onSaved={() => setOpenPerson(null)} />
      </Page>
    );
  }

  if (file && openPreset !== null) {
    const isNew = openPreset === "new";
    return (
      <Page user={user}>
        <PresetDetail presetId={openPreset} file={file} sha={sha} vocabulary={vocabulary} canAssign={canAssign} accounts={accountNames}
          canEditFields={isNew ? canCreatePreset : canEditPresets} canDelete={canDeletePresets}
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

      {tabOptions.length === 0 ? (
        <Empty title="Nothing to open yet"
          body="You can see the Admin tab, but you do not hold any of the permissions that unlock what is inside it. Ask an administrator for admin.people.read, admin.presets.read or admin.audit.read." />
      ) : (
        <>
          {canReadFile && isLoading && <Spinner label="Reading the permissions file" />}

          {canReadFile && !isLoading && isError && (
            <LoadFailed what="the permissions file" error={error} onRetry={() => refetch()} />
          )}

          {canReadFile && !isLoading && !isError && adminFile && isAdminFileFailure(adminFile) && (
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

          {canReadFile && !isLoading && !isError && loaded && loaded.source === "no-repo" && (
            <Note intent="warn">
              <p className="font-semibold">There is nowhere to store this yet.</p>
              <p className="mt-1">The permissions repository does not exist in this organization.</p>
              {canAssign && (
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

          {/* Audit needs none of this — its own tab, own endpoint, no dependency on the file. */}
          {(!canReadFile || (file && loaded && loaded.source !== "no-repo")) && (
            <>
              {canReadFile && file && loaded && loaded.source !== "no-repo" && (
                <>
                  <DryRunBanner enforced={permissions?.enforced ?? false}
                    fileEmpty={Object.keys(file.people).length === 0} canMigrate={canAssign} />

                  {loaded.unknownNodes.length > 0 && (
                    <Note intent="neutral">
                      The file names {loaded.unknownNodes.length} permission{loaded.unknownNodes.length === 1 ? "" : "s"}{" "}
                      this version of the app does not have: {loaded.unknownNodes.join(", ")}. Ignored, not enforced.
                    </Note>
                  )}
                </>
              )}

              <div className="mb-6">
                <Segmented value={activeMode} onChange={setMode} options={tabOptions} />
              </div>

              {activeMode === "people" && file && <PeopleView file={file} onOpen={setOpenPerson} />}
              {activeMode === "presets" && file && (
                <PresetsListView file={file} canCreate={canCreatePreset}
                  onOpen={setOpenPreset} onCreate={() => setOpenPreset("new")} />
              )}
              {activeMode === "audit" && <AuditScreen />}
              {activeMode === "aws" && file && (
                <AwsAccountsView file={file} sha={sha} live={vocab?.liveAccountIds ?? []}
                  canEdit={canPresetsEdit} onSaved={() => qc.invalidateQueries({ queryKey: ["admin"] })} />
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}
