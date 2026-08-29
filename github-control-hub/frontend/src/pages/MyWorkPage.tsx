import { useMemo, useState } from "react";
import { useAuth } from "../App";
import { useMyWork, usePushCheck, useShipped } from "../hooks/useMe";
import { useRepos } from "../hooks/useRepos";
import {
  Page, PageHeader, Note, Pill, Empty, Spinner, Segmented,
  SURFACE, TYPE, RefreshButton, LoadFailed,
} from "../design";
import UserAvatar from "../components/UserAvatar";
import type { MyPull, Waiting } from "../api/me";
import DevAlertSettings from "../components/DevAlertSettings";
import PersonalBoard from "../components/PersonalBoard";

/**
 * The app, pointed at whoever is reading it.
 *
 * Every other screen answers a question about the organization. This one
 * answers the four a developer actually has during a working day, out of the
 * same data: what is stopping my work, what is stopping everyone else's,
 * why was my push refused, and what did I get out of the door.
 *
 * The organising idea is that these are questions about *the next action*, not
 * about state. "Fourteen open pull requests" is state. "Three are waiting on
 * you and two are waiting on nobody" is the next action, and it is the same
 * fourteen rows.
 */

type Lens = "queue" | "push" | "shipped" | "board" | "alerts";

/** How each waiting-state reads, and how loud it should be. */
const WAITING: Record<Waiting, { label: string; tone: string; rail: string }> = {
  nobody:    { label: "Ready to merge", tone: "text-emerald-600 dark:text-emerald-400", rail: "bg-emerald-500" },
  you:       { label: "On you",         tone: "text-amber-600 dark:text-amber-400",     rail: "bg-amber-500" },
  reviewers: { label: "On reviewers",   tone: "text-sky-600 dark:text-sky-400",         rail: "bg-sky-500" },
  checks:    { label: "Checks running", tone: "text-slate-400 dark:text-slate-500",     rail: "bg-slate-300 dark:bg-slate-600" },
};

/** The block reason as a sentence, rather than as the enum it is stored as. */
const REASON: Record<string, string> = {
  "ready": "Nothing is in the way",
  "needs-approval": "Waiting for approval",
  "changes-requested": "Changes were requested",
  "draft": "Still a draft",
  "conflict": "Conflicts with the base branch",
  "behind": "Behind the base branch",
  "checks-failing": "Checks are failing",
  "checks-pending": "Checks are still running",
  "blocked": "GitHub reports it as blocked",
};

function PullRow({ pr, showAuthor }: { pr: MyPull; showAuthor?: boolean }) {
  const w = WAITING[pr.waiting];
  return (
    <a
      href={pr.url} target="_blank" rel="noreferrer noopener"
      className="group relative flex items-start gap-3.5 pl-5 pr-4 py-3.5
                 hover:bg-slate-50/80 dark:hover:bg-white/[0.035] transition-colors"
    >
      {/* The rail, not a dot. It runs the height of the row, so a column of
          them reads as a stacked bar of what the day is made of before any of
          the text has been read. */}
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${w.rail}`} aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-semibold text-slate-900 dark:text-slate-100 truncate">
            {pr.title}
          </span>
          {pr.isDraft && <Pill intent="neutral">draft</Pill>}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-slate-300 dark:text-slate-600">
            {pr.idleDays === 0 ? "today" : `${pr.idleDays}d`}
          </span>
        </div>

        <div className="flex items-center gap-2 mt-1.5 min-w-0">
          {showAuthor && <UserAvatar login={pr.author} size={16} />}
          <span className={`text-[11.5px] font-bold uppercase tracking-wider ${w.tone}`}>
            {REASON[pr.reason] ?? pr.reason}
          </span>
          <span className="text-[12px] font-mono text-slate-400 dark:text-slate-500 truncate">
            {pr.repo}#{pr.number}
          </span>
        </div>

        {(pr.approvals > 0 || pr.pending.length > 0) && (
          <div className="flex items-center gap-3 mt-1.5 text-[11.5px] text-slate-400 dark:text-slate-500">
            {pr.approvals > 0 && (
              <span className="inline-flex items-center gap-1">
                <i className="ph-fill ph-check-circle text-emerald-500 text-[12px]" aria-hidden="true" />
                {pr.approvals}
              </span>
            )}
            {pr.pending.length > 0 && (
              <span className="truncate">waiting on {pr.pending.slice(0, 3).join(", ")}</span>
            )}
          </div>
        )}
      </div>
    </a>
  );
}

/**
 * A card with a heading, a line, and the thing.
 *
 * The generic Block gave a heading and nothing else, so eight of them read as
 * eight identical grey rectangles. This is the treatment the Activity cards
 * already use — a rule under the heading rather than a tinted title bar, which
 * was chrome doing the work a line does.
 */
function Panel({ title, count, note, children }: {
  title: string; count?: number; note?: string; children: React.ReactNode;
}) {
  return (
    <section className={`${SURFACE.card} overflow-hidden flex flex-col`}>
      <div className="px-5 pt-4">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">{title}</h3>
          {count !== undefined && (
            <span className="text-[12px] font-bold tabular-nums text-slate-300 dark:text-slate-600">{count}</span>
          )}
        </div>
        {note && <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">{note}</p>}
        <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/** Rows share one surface, divided by hairlines, rather than floating apart. */
function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">{children}</div>;
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-8 text-[13px] text-center text-slate-400 dark:text-slate-500">{children}</p>
  );
}

/**
 * The one number that decides whether the day needs rearranging.
 *
 * Three equal boxes said all three mattered equally, which is how a dashboard
 * ends up with nothing to look at first. What other people are waiting on you
 * for leads — it is the only one where somebody else is blocked — and the other
 * two are supporting facts at supporting size, on one surface divided by
 * hairlines rather than floating apart as peers.
 */
function Headline({ mergeable, onYou, toReview }: {
  mergeable: number; onYou: number; toReview: number;
}) {
  const clear = toReview === 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] mb-5">
      <div className={`${SURFACE.card} relative overflow-hidden px-6 py-5`}>
        {/* Tinted by the answer, so the direction reads before the number
            does: amber when people are waiting, green when nobody is. */}
        <div aria-hidden="true"
          className={`pointer-events-none absolute -right-16 -top-16 w-56 h-56 rounded-full blur-2xl opacity-[0.16]
            ${clear ? "bg-emerald-500" : "bg-amber-500"}`} />

        <div className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Waiting on you</div>
        <div className="flex items-end gap-3 mt-2.5">
          <span className={`text-[52px] font-black tabular-nums leading-[0.85] tracking-[-0.04em]
            ${clear ? "text-slate-300 dark:text-slate-600" : "text-slate-900 dark:text-white"}`}>
            {toReview}
          </span>
          {!clear && (
            <span className="mb-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-bold
                             bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <i className="ph-bold ph-eyes text-[12px]" aria-hidden="true" />
              review
            </span>
          )}
        </div>
        <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-2.5">
          {clear
            ? "Nobody is blocked on a review from you."
            : `${toReview === 1 ? "One pull request is" : `${toReview} pull requests are`} blocked until you look.`}
        </p>
      </div>

      <div className={`${SURFACE.card} overflow-hidden grid sm:grid-cols-2 lg:grid-cols-1
                       gap-px bg-slate-200/70 dark:bg-white/[0.07]`}>
        <MiniStat icon="ph-git-merge" tone="text-emerald-600 dark:text-emerald-400"
          label="Ready to merge" value={mergeable}
          foot={mergeable ? "nothing is in the way" : "none waiting to go out"} />
        <MiniStat icon="ph-wrench" tone="text-amber-600 dark:text-amber-400"
          label="Need your attention" value={onYou}
          foot={onYou ? "conflicts, checks or a stale base" : "none of yours are stuck"} />
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value, foot, tone }: {
  icon: string; label: string; value: number; foot: string; tone: string;
}) {
  return (
    <div className="bg-white dark:bg-[#151a23] px-5 py-4 flex items-center gap-4">
      <i className={`${icon} ph-fill text-[19px] ${value === 0 ? "text-slate-300 dark:text-slate-600" : tone}`}
         aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-[22px] font-black tabular-nums leading-none
            ${value === 0 ? "text-slate-300 dark:text-slate-600" : "text-slate-900 dark:text-white"}`}>
            {value}
          </span>
          <span className="text-[12px] font-bold text-slate-600 dark:text-slate-300">{label}</span>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 truncate">{foot}</p>
      </div>
    </div>
  );
}

function Queue() {
  const { data, isLoading, isError, error, refetch } = useMyWork();

  if (isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>;
  if (isError) return <LoadFailed what="your queue" error={error as Error} onRetry={() => refetch()} />;
  if (!data) return null;

  // Not the same as having nothing to do, and the difference matters enough to
  // say. An empty list here means the walk has never run.
  if (!data.collected) {
    return (
      <Empty
        title="No pull request data yet"
        body="The scheduled pass that collects open pull requests has not run in this account. Open the PR's tab once and it will be collected."
      />
    );
  }

  return (
    <>
      <Headline mergeable={data.mergeable} onYou={data.onYou} toReview={data.toReview.length} />

      {data.truncated && (
        <Note intent="warn">
          The pull request walk stopped at its page limit, so this may be missing
          the oldest few. Everything shown is real; the list is what may be short.
        </Note>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Waiting on you" count={data.toReview.length}
          note="Reviews other people are blocked on.">
          {data.toReview.length === 0
            ? <Quiet>Nobody is waiting on a review from you.</Quiet>
            : <Rows>{data.toReview.map(pr => <PullRow key={pr.url} pr={pr} showAuthor />)}</Rows>}
        </Panel>

        <Panel title="Your pull requests" count={data.mine.length}
          note="Most idle first, since those are the forgotten ones.">
          {data.mine.length === 0
            ? <Quiet>You have nothing open.</Quiet>
            : <Rows>{data.mine.map(pr => <PullRow key={pr.url} pr={pr} />)}</Rows>}
        </Panel>
      </div>

      {data.cachedAt && (
        <p className="mt-4 text-[11.5px] text-slate-400 dark:text-slate-500">
          Collected {new Date(data.cachedAt).toLocaleString()}.
        </p>
      )}
    </>
  );
}

function RuleList({ title, rules, intent }: {
  title: string; rules: { label: string; detail: string }[]; intent: "danger" | "info";
}) {
  if (rules.length === 0) return null;
  const bar = intent === "danger" ? "bg-rose-400 dark:bg-rose-500" : "bg-sky-400 dark:bg-sky-500";
  return (
    <div className="mt-4">
      <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400 mb-2">
        {title}
      </h4>
      <div className="grid gap-2">
        {rules.map(r => (
          <div key={r.label} className="flex gap-3 px-3.5 py-3 rounded-lg bg-slate-50 dark:bg-white/[0.04]
                                        border border-slate-200/70 dark:border-white/10">
            <span className={`w-[3px] rounded-full shrink-0 ${bar}`} aria-hidden="true" />
            <div>
              <div className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{r.label}</div>
              <div className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">{r.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PushCheck() {
  const { data: repos } = useRepos();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const { data, isFetching, isError, error } = usePushCheck(repo, branch);

  const names = useMemo(() => (repos ?? []).map(r => r.name).sort(), [repos]);

  return (
    <Panel title="Why can't I push?"
      note="What will happen before you try it, and who can approve if you cannot.">
      <div className="p-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Repository
            </label>
            <input
              list="mywork-repos" value={repo} onChange={e => setRepo(e.target.value)}
              placeholder="Start typing a name" className={SURFACE.input}
            />
            <datalist id="mywork-repos">
              {names.map(n => <option key={n} value={n} />)}
            </datalist>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Branch
            </label>
            <input value={branch} onChange={e => setBranch(e.target.value)}
              placeholder="main" className={SURFACE.input} />
          </div>
        </div>

        {!repo && (
          <p className="mt-4 text-[13px] text-slate-500 dark:text-slate-400">
            Pick a repository and a branch, and this says exactly what will happen
            when you push or try to merge — and who can approve it if you cannot.
          </p>
        )}

        {repo && isFetching && <div className="py-10 flex justify-center"><Spinner /></div>}

        {repo && isError && (
          <Note intent="danger">{(error as Error)?.message ?? "Could not read the rules."}</Note>
        )}

        {data && !isFetching && (
          <div className="mt-5">
            {/* Every one of these is a case where an empty rule list would read
                as "nothing is stopping you", which is the opposite of true. */}
            {data.message && <Note intent={data.unreadable ? "warn" : "danger"}>{data.message}</Note>}

            {data.reachable && !data.message && data.protected === false && (
              <Note intent="good">
                Nothing protects <span className="font-mono">{data.branch}</span>. You can push
                straight to it.
              </Note>
            )}

            {data.reachable && !data.message && data.protected && (
              <>
                {data.cannotPushBecause?.length === 0 && data.mergeNeeds?.length === 0 && (
                  <Note intent="good">
                    It is protected, but nothing currently blocks you.
                  </Note>
                )}
                <RuleList title="Why a direct push is refused" rules={data.cannotPushBecause ?? []} intent="danger" />
                <RuleList title="What a pull request will need" rules={data.mergeNeeds ?? []} intent="info" />

                {data.bypassNote && (
                  <div className="mt-4">
                    <Note intent={data.canBypass ? "warn" : "info"}>{data.bypassNote}</Note>
                  </div>
                )}

                {(data.approvers?.length ?? 0) > 0 && (
                  <div className="mt-5">
                    <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400 mb-2">
                      Who can approve
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {data.approvers!.map(p => (
                        <span key={p.login}
                          className="inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full
                                     bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10">
                          <UserAvatar login={p.login} size={18} />
                          <span className="text-[12.5px] font-medium text-slate-700 dark:text-slate-200">{p.login}</span>
                          {/* Admins can change the rule as well as satisfy it,
                              which is a different favour to ask for. */}
                          {p.role === "admin" && (
                            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                              admin
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Shipped() {
  const [days, setDays] = useState(7);
  const { data, isLoading, isError, error, refetch } = useShipped(days);

  return (
    <>
      <div className="flex justify-end mb-4">
        <Segmented
          value={String(days)}
          onChange={v => setDays(Number(v))}
          options={[["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]}
        />
      </div>

      {isLoading && <div className="py-16 flex justify-center"><Spinner /></div>}
      {isError && <LoadFailed what="your shipping history" error={error as Error} onRetry={() => refetch()} />}

      {data && (
        <>
          {/* The one reason this list is empty that is not "you shipped
              nothing". Said before the list, not after it. */}
          {!data.detailedLogging && (
            <Note intent="warn">
              Merges are not being recorded. Detailed logging is off for this
              organization, so nothing below can show what went out — turn it on
              in Activity settings and it starts from then, not retroactively.
            </Note>
          )}

          <div className="grid gap-5 lg:grid-cols-2 mt-4">
            <Panel title={`Merged in the last ${data.days} days`} count={data.merged.length}
              note="From the activity log, so it needs detailed logging on.">
              {data.merged.length === 0
                ? <p className="text-[13px] text-slate-500 dark:text-slate-400 px-1 py-2">
                    {data.detailedLogging ? "Nothing merged in this window." : "Nothing recorded."}
                  </p>
                : <div className="grid gap-2">
                    {data.merged.map(e => (
                      <div key={e.id} className="px-4 py-3 rounded-xl border border-slate-200/80 dark:border-white/10
                                                 bg-white dark:bg-white/[0.03]">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-[13.5px] font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {e.target || e.details}
                          </span>
                          <span className="text-[11.5px] font-mono text-slate-400 dark:text-slate-500">{e.repo}</span>
                          <span className="ml-auto text-[11.5px] tabular-nums text-slate-400 dark:text-slate-500">
                            {new Date(e.timestamp).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>}
              {data.pushes > 0 && (
                <p className="mt-3 text-[12px] text-slate-400 dark:text-slate-500">
                  Plus {data.pushes} direct {data.pushes === 1 ? "push" : "pushes"} in the same window.
                </p>
              )}
            </Panel>

            <Panel title="Still waiting" count={data.waiting.length}
              note="Yours that are open and not yet out.">
              {data.waiting.length === 0
                ? <p className="text-[13px] text-slate-500 dark:text-slate-400 px-1 py-2">
                    Nothing of yours is open.
                  </p>
                : <div className="grid gap-2">
                    {data.waiting.map(pr => (
                      <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer noopener"
                        className="block px-4 py-3 rounded-xl border border-slate-200/80 dark:border-white/10
                                   bg-white dark:bg-white/[0.03] hover:border-slate-300 dark:hover:border-white/20 transition-colors">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[13.5px] font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {pr.title}
                          </span>
                          <span className="text-[11.5px] font-mono text-slate-400 dark:text-slate-500 shrink-0">
                            {pr.repo}#{pr.number}
                          </span>
                        </div>
                      </a>
                    ))}
                  </div>}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

export default function MyWorkPage() {
  const { user } = useAuth();
  const [lens, setLens] = useState<Lens>("queue");
  const work = useMyWork();

  return (
    <Page user={user}>
      <PageHeader
        title="My work"
        subtitle="What is waiting on you, what is stopping you, and what went out."
        actions={<RefreshButton onRefresh={() => work.refetch()} />}
      />

      <div className="mb-5">
        <Segmented
          value={lens}
          onChange={v => setLens(v as Lens)}
          options={[
            ["queue", "Queue"],
            ["push", "Why can't I push?"],
            ["shipped", "What did I ship?"],
            ["board", "My cards"],
            ["alerts", "Notifications"],
          ]}
        />
      </div>

      {lens === "queue" && <Queue />}
      {lens === "push" && <PushCheck />}
      {lens === "shipped" && <Shipped />}
      {lens === "board" && <PersonalBoard />}
      {lens === "alerts" && <DevAlertSettings />}
    </Page>
  );
}
