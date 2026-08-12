import { useState, useMemo } from "react";
import { useAuth } from "../App";
import {
  Page, Back, Note, Pill, Empty, Spinner, RailCard, Sheet, SheetHeader, Block,
  InsetRow, SearchInput, Segmented, RefreshButton, type Intent,
} from "../design";
import { useAccessSummary, useUserAccess, useRepoAccess, useAccessRepos } from "../hooks/useAccess";
import type { AccessPath, Person, OrgRole } from "../api/access";

/**
 * Who can reach what.
 *
 * The map is read-only on purpose. Its job is to answer the question people
 * currently answer by clicking through 356 repositories one at a time, and
 * the answer is only useful if it shows the route: revoking a direct grant
 * changes nothing if the person is also in a team that owns the repository.
 */

const ROLE_TONE: Record<string, Intent> = {
  admin: "danger", maintain: "warn", write: "info", push: "info", triage: "neutral", read: "neutral",
};

const ROLE_LABEL: Record<string, string> = {
  push: "write", pull: "read",
};
const roleName = (r: string) => ROLE_LABEL[r] ?? r;

function describePath(p: AccessPath): string {
  if (p.via === "org_owner") return "organization owner";
  if (p.via === "team") return `${p.teamName ?? p.team} team`;
  return "granted to them directly";
}

function OrgRoleTag({ role }: { role: OrgRole }) {
  if (role === "owner") return <Pill intent="danger">owner</Pill>;
  if (role === "outside_collaborator") return <Pill intent="warn">outside</Pill>;
  return null;
}

export default function AccessPage() {
  const { user } = useAuth();
  const [mode, setMode] = useState<"people" | "repos">("people");
  const [query, setQuery] = useState("");
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [openRepo, setOpenRepo] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useAccessSummary();
  const { data: repos } = useAccessRepos(mode === "repos");

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data?.people ?? [];
    if (!q) return list;
    return list.filter(p =>
      p.login.toLowerCase().includes(q) ||
      p.teams.some(t => t.name.toLowerCase().includes(q)));
  }, [data, query]);

  const repoList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter(r => !q || r.toLowerCase().includes(q));
  }, [repos, query]);

  if (openPerson) {
    return (
      <Page user={user}>
        <PersonDetail
          login={openPerson}
          onBack={() => setOpenPerson(null)}
          onOpenRepo={r => { setOpenPerson(null); setMode("repos"); setOpenRepo(r); }}
        />
      </Page>
    );
  }

  if (openRepo) {
    return (
      <Page user={user}>
        <RepoDetail
          repo={openRepo}
          onBack={() => setOpenRepo(null)}
          onOpenPerson={l => { setOpenRepo(null); setMode("people"); setOpenPerson(l); }}
        />
      </Page>
    );
  }

  const owners = (data?.people ?? []).filter(p => p.orgRole === "owner").length;
  const outsiders = (data?.people ?? []).filter(p => p.outside).length;
  const withDirect = (data?.people ?? []).filter(p => p.directCount > 0).length;

  return (
    <Page user={user}>
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Access</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Every person, everything they can reach, and how they came by it.
          </p>
        </div>
        <RefreshButton busy={isFetching} onRefresh={() => refetch()} />
      </div>

      {data?.stale && (
        <Note intent="warn">
          The graph has not been rebuilt since this view existed, so there is nobody in it yet.
          Press Sync data on the Repos page — an empty map here means nothing has been collected,
          not that nobody has access.
        </Note>
      )}

      {data && !data.stale && (
        <>
          {/* The single most load-bearing sentence on the page. The map shows
              write and above; if read is the org default, everyone can already
              see everything, and leaving that implied would be a lie of
              omission on a page about access. */}
          <Note intent="neutral">
            {data.org.defaultRepositoryPermission === "none"
              ? <>Members get no access by default in this organization, so everything below is the whole picture.</>
              : data.org.defaultRepositoryPermission === "unknown"
                ? <>The organization's default permission could not be read, so it is not known whether members can see repositories they are not listed against below.</>
                : <>
                    Every member of this organization already has <strong>{roleName(data.org.defaultRepositoryPermission)}</strong> on
                    every repository — that is the organization default, and it is not repeated below.
                    This map shows write access and above.
                  </>}
          </Note>

          <div className="grid sm:grid-cols-4 gap-3 mb-5">
            <Stat value={data.people.length} label="people" />
            <Stat value={owners} label={owners === 1 ? "org owner" : "org owners"}
              hint="Admin on every repository, always" tone={owners > 3 ? "warn" : "neutral"} />
            <Stat value={outsiders} label="outside collaborators"
              hint="Not members of the organization" tone={outsiders > 0 ? "warn" : "neutral"} />
            <Stat value={withDirect} label="with personal grants"
              hint="Access no team or role explains" tone={withDirect > 0 ? "warn" : "neutral"} />
          </div>
        </>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Segmented
          value={mode}
          onChange={m => { setMode(m); setQuery(""); }}
          options={[["people", "By person"], ["repos", "By repository"]]}
        />
        <div className="flex-1 min-w-[220px]">
          <SearchInput value={query} onChange={setQuery}
            placeholder={mode === "people" ? "Find a person or team" : "Find a repository"} />
        </div>
      </div>

      {isLoading && <Spinner />}

      {mode === "people" && !isLoading && (
        people.length === 0 ? (
          <Empty title="Nobody matches" body="Try a different name, or search by team." />
        ) : (
          <div className="grid gap-2">
            {people.map((p, i) => (
              <PersonRow key={p.login} person={p} index={i} onOpen={() => setOpenPerson(p.login)} />
            ))}
          </div>
        )
      )}

      {mode === "repos" && (
        repoList.length === 0 ? (
          <Empty title="No repositories" body="Nothing in the graph matches that." />
        ) : (
          <div className="grid gap-2">
            {repoList.slice(0, 400).map((r, i) => (
              <InsetRow key={r} intent="neutral" index={i}>
                <button onClick={() => setOpenRepo(r)}
                  className="w-full text-left font-mono text-[13.5px] font-bold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                  {r}
                </button>
              </InsetRow>
            ))}
          </div>
        )
      )}
    </Page>
  );
}

function Stat({ value, label, hint, tone = "neutral" }: {
  value: number; label: string; hint?: string; tone?: Intent;
}) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3">
      <p className={`text-[26px] font-black leading-none tabular-nums ${
        tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-white"
      }`}>{value}</p>
      <p className="text-[12.5px] font-bold text-slate-600 dark:text-slate-300 mt-1.5">{label}</p>
      {hint && <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function PersonRow({ person, index, onOpen }: { person: Person; index: number; onOpen: () => void }) {
  return (
    <RailCard intent={person.outside ? "warn" : person.orgRole === "owner" ? "info" : "neutral"}
      index={index} onClick={onOpen}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {person.avatarUrl
            ? <img src={person.avatarUrl} alt="" className="h-8 w-8 rounded-full shrink-0" />
            : <div className="h-8 w-8 rounded-full bg-slate-200 dark:bg-slate-700 shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-[14px] text-slate-900 dark:text-white">{person.login}</span>
              <OrgRoleTag role={person.orgRole} />
            </div>
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {person.teams.length === 0
                ? "No teams"
                : person.teams.map(t => t.name).join(", ")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6 shrink-0 text-right">
          <Count n={person.repoCount} label="repos" />
          <Count n={person.adminCount} label="admin" warn={person.adminCount > 0} />
          <Count n={person.directCount} label="personal" warn={person.directCount > 0} />
        </div>
      </div>
    </RailCard>
  );
}

function Count({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div>
      <p className={`text-[17px] font-black tabular-nums leading-none ${
        n === 0 ? "text-slate-300 dark:text-slate-600"
          : warn ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-white"
      }`}>{n}</p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{label}</p>
    </div>
  );
}

function PersonDetail({ login, onBack, onOpenRepo }: {
  login: string; onBack: () => void; onOpenRepo: (repo: string) => void;
}) {
  const { data, isLoading } = useUserAccess(login);
  const [showArchived, setShowArchived] = useState(true);

  if (isLoading) return <><Back onClick={onBack}>Access</Back><Spinner /></>;
  if (!data) return <><Back onClick={onBack}>Access</Back><Empty title="Not found" /></>;

  const shown = showArchived ? data.repos : data.repos.filter(r => !r.archived);
  const archivedCount = data.repos.filter(r => r.archived).length;
  const direct = data.repos.filter(r => r.paths.some(p => p.via === "direct"));

  return (
    <>
      <Back onClick={onBack}>Access</Back>
      <Sheet>
        <SheetHeader
          intent={data.orgRole === "owner" ? "warn" : "neutral"}
          title={data.login}
          subtitle={
            data.orgRole === "owner"
              ? "An organization owner. Admin on every repository by virtue of the role — removing individual grants does not change that."
              : data.orgRole === "outside_collaborator"
                ? "Not a member of this organization. Reaches only what was granted to them."
                : `Member of ${data.teams.length === 0 ? "no teams" : data.teams.map(t => t.name).join(", ")}.`
          }
        />

        {data.unknown && (
          <Note intent="warn">
            Nobody by that name is in the graph. They may have left the organization since the last sync.
          </Note>
        )}

        {direct.length > 0 && (
          <Note intent="warn">
            {direct.length === 1 ? "One repository is" : `${direct.length} repositories are`} reachable
            only because of a grant made to this person specifically — no team and no role explains it.
            {direct.length <= 6 && <> {direct.map(r => r.repo).join(", ")}.</>}
          </Note>
        )}

        <Block
          title={`${data.repos.length} ${data.repos.length === 1 ? "repository" : "repositories"}`}
          action={archivedCount > 0 && (
            <button onClick={() => setShowArchived(v => !v)}
              className="text-sm font-bold text-blue-600 dark:text-blue-400 hover:underline">
              {showArchived ? `Hide ${archivedCount} archived` : `Show ${archivedCount} archived`}
            </button>
          )}>
          {shown.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Nothing beyond what every member of the organization already has.
            </p>
          ) : (
            <ul className="grid gap-2">
              {shown.map((r, i) => (
                <InsetRow key={r.repo} intent={ROLE_TONE[r.role] ?? "neutral"} index={i}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={() => onOpenRepo(r.repo)}
                          className="font-mono text-[13.5px] font-bold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 break-all">
                          {r.repo}
                        </button>
                        {r.archived && <Pill intent="neutral">archived</Pill>}
                        {r.visibility === "public" && <Pill intent="warn">public</Pill>}
                      </div>
                      {/* The routes, which are the reason this page exists. */}
                      <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-1">
                        {r.paths.length === 0
                          ? "Route unknown"
                          : r.paths.map((p, j) => (
                            <span key={j}>
                              {j > 0 && <span className="text-slate-300 dark:text-slate-600"> · </span>}
                              <span className={p.via === "direct" ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}>
                                {describePath(p)}
                              </span>
                              <span className="text-slate-400 dark:text-slate-500"> ({roleName(p.role)})</span>
                            </span>
                          ))}
                      </p>
                    </div>
                    <Pill intent={ROLE_TONE[r.role] ?? "neutral"}>{roleName(r.role)}</Pill>
                  </div>
                </InsetRow>
              ))}
            </ul>
          )}
        </Block>
      </Sheet>
    </>
  );
}

function RepoDetail({ repo, onBack, onOpenPerson }: {
  repo: string; onBack: () => void; onOpenPerson: (login: string) => void;
}) {
  const { data, isLoading } = useRepoAccess(repo);

  if (isLoading) return <><Back onClick={onBack}>Access</Back><Spinner /></>;
  if (!data) return <><Back onClick={onBack}>Access</Back><Empty title="Not found" /></>;

  const outsiders = data.people.filter(p => p.outside);
  const admins = data.people.filter(p => p.role === "admin");

  return (
    <>
      <Back onClick={onBack}>Access</Back>
      <Sheet>
        <SheetHeader
          intent={outsiders.length > 0 ? "warn" : "neutral"}
          title={data.repo}
          subtitle={`${data.people.length} ${data.people.length === 1 ? "person" : "people"} can write to this${
            admins.length ? `, ${admins.length} as admin` : ""
          }.${data.archived ? " It is archived — access to an archived repository is still access to its history." : ""}`}
        />

        {outsiders.length > 0 && (
          <Note intent="warn">
            {outsiders.map(p => p.login).join(", ")} {outsiders.length === 1 ? "is" : "are"} not
            {outsiders.length === 1 ? " a member" : " members"} of this organization.
          </Note>
        )}

        <Block title={data.teams.length === 0 ? "No team owns this" : "Teams"}>
          {data.teams.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Nobody reaches it through a team, so every route below is an individual one.
            </p>
          ) : (
            <ul className="grid gap-2">
              {data.teams.map((t, i) => (
                <InsetRow key={t.slug} intent="neutral" index={i}>
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-bold text-[13.5px] text-slate-900 dark:text-white">{t.name}</span>
                    <Pill intent={ROLE_TONE[t.permission] ?? "neutral"}>{roleName(t.permission)}</Pill>
                  </div>
                </InsetRow>
              ))}
            </ul>
          )}
        </Block>

        <Block title="People">
          <ul className="grid gap-2">
            {data.people.map((p, i) => (
              <InsetRow key={p.login} intent={ROLE_TONE[p.role] ?? "neutral"} index={i}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => onOpenPerson(p.login)}
                        className="font-bold text-[13.5px] text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                        {p.login}
                      </button>
                      <OrgRoleTag role={p.orgRole} />
                    </div>
                    <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-1">
                      {p.paths.map((path, j) => (
                        <span key={j}>
                          {j > 0 && <span className="text-slate-300 dark:text-slate-600"> · </span>}
                          <span className={path.via === "direct" ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}>
                            {describePath(path)}
                          </span>
                        </span>
                      ))}
                    </p>
                  </div>
                  <Pill intent={ROLE_TONE[p.role] ?? "neutral"}>{roleName(p.role)}</Pill>
                </div>
              </InsetRow>
            ))}
          </ul>
        </Block>
      </Sheet>
    </>
  );
}
