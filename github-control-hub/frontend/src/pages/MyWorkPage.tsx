import React, { useEffect, useMemo, useState } from "react";
import { idleLabel } from "../lib/idle";
import { ago } from "../lib/ago";
import { useAuth } from "../App";
import { useMyWork, usePushCheck, useShipped } from "../hooks/useMe";
import { useAccessRepos } from "../hooks/useAccess";
import {
  Page, PageHeader, Note, Pill, Empty, Spinner, Segmented,
  SURFACE, TYPE, RefreshButton, LoadFailed,
} from "../design";
import UserAvatar from "../components/UserAvatar";
import type { MyPull, Waiting, PushRule, PushCheck as PushCheckData, ShipEntry } from "../api/me";
import { useOrgConfig } from "../hooks/useOrgConfig";
import DevAlertSettings from "../components/DevAlertSettings";
import PersonalBoard from "../components/PersonalBoard";
import MyAlarmsPanel from "../components/MyAlarmsPanel";

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

type Lens = "queue" | "push" | "shipped" | "board" | "myalarms" | "alerts";

/** How each waiting-state reads, and how loud it should be. */
const WAITING: Record<Waiting, { label: string; tone: string; rail: string }> = {
  nobody:    { label: "Ready to merge", tone: "text-forest", rail: "bg-forest" },
  you:       { label: "On you",         tone: "text-ochre",  rail: "bg-ochre" },
  reviewers: { label: "On reviewers",   tone: "text-indigo", rail: "bg-indigo" },
  checks:    { label: "Checks running", tone: "text-ink-3",  rail: "bg-rule-strong" },
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
      className="group relative flex items-start gap-3.5 pl-5 pr-4 py-4 no-underline
                 hover:bg-ink/[0.035] transition-colors"
    >
      {/* The marginal rule, not a dot. It runs the height of the row, so a
          column of them reads as a stacked bar of what the day is made of
          before any of the text has been read. */}
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${w.rail}`} aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5">
          <span className="display text-[1.0625rem] leading-snug text-ink truncate">
            {pr.title}
          </span>
          {pr.isDraft && <Pill intent="neutral">draft</Pill>}
          <span className="ml-auto shrink-0 caps tabular-nums">
            {pr.idleDays < 1 ? "today" : idleLabel(pr.idleDays)}
          </span>
        </div>

        <div className="dateline mt-2 min-w-0">
          {showAuthor && <span className="flex items-center"><UserAvatar login={pr.author} size={15} /></span>}
          <span className={`caps ${w.tone}`}>{REASON[pr.reason] ?? pr.reason}</span>
          <span className="font-mono text-[0.75rem] truncate">{pr.repo}#{pr.number}</span>
          {pr.approvals > 0 && <span>{pr.approvals} approved</span>}
          {pr.pending.length > 0 && (
            <span className="truncate">waiting on {pr.pending.slice(0, 3).join(", ")}</span>
          )}
        </div>
      </div>
    </a>
  );
}

/**
 * A card with a heading, a line, and the thing.
 *
 * The generic Block gave a heading and nothing else, so eight of them read as
 * eight identical grey rectangles. This is the treatment the Activity cards
 * already use, a rule under the heading rather than a tinted title bar, which
 * was chrome doing the work a line does.
 */
function Panel({ title, count, note, action, children }: {
  title: string; count?: number; note?: string;
  /** A control belonging to this panel, on the heading line. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col border border-rule bg-paper">
      <div className="px-5 pt-4">
        <div className="flex items-baseline gap-2.5">
          <h3 className="caps text-ink">{title}</h3>
          {count !== undefined && (
            <span className="figure text-[1rem] text-ink-3">{count}</span>
          )}
          {action && <div className="ml-auto self-baseline">{action}</div>}
        </div>
        {note && <p className="standfirst text-[0.75rem] mt-1">{note}</p>}
        <div className="border-t-2 border-ink mt-3" />
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/** Rows share one surface, divided by hairlines, rather than floating apart. */
function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-rule">{children}</div>;
}

/** How many rows a panel shows before it starts paging. */
const PAGE = 6;

/**
 * A page of rows, and the controls only when there is more than one.
 *
 * Somebody with sixty open pull requests should not get a panel sixty rows tall
 * beside one that is three: the taller one pushes the other off the screen, and
 * the page stops being something you can take in at a glance, which was the
 * whole point of two columns.
 *
 * The page resets when the list changes underneath. Sitting on page four of a
 * list that now has one page shows nothing, which reads as everything having
 * been dealt with.
 */
function Paged<T>({ items, render, keyOf, perPage = PAGE, bare }: {
  items: T[];
  render: (item: T) => React.ReactNode;
  keyOf: (item: T) => string;
  perPage?: number;
  /** Skip the hairline-divided wrapper, for content that groups itself. */
  bare?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, pages - 1);
  const shown = items.slice(current * perPage, current * perPage + perPage);

  useEffect(() => { setPage(0); }, [items.length]);

  const rows = shown.map(item => <React.Fragment key={keyOf(item)}>{render(item)}</React.Fragment>);

  return (
    <>
      {bare ? <div className="p-5 grid gap-4">{rows}</div> : <Rows>{rows}</Rows>}
      {pages > 1 && (
        <div className="flex items-baseline justify-between gap-4 px-5 py-3 border-t border-rule">
          <span className="caps tabular-nums">
            {current * perPage + 1}&ndash;{current * perPage + shown.length} of {items.length}
          </span>
          <div className="flex items-baseline gap-4">
            <button onClick={() => setPage(current - 1)} disabled={current === 0}
              className="textlink caps" aria-label="Previous">← Previous</button>
            <button onClick={() => setPage(current + 1)} disabled={current >= pages - 1}
              className="textlink caps" aria-label="Next">Next →</button>
          </div>
        </div>
      )}
    </>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="standfirst px-5 py-10 text-[0.8438rem] text-center">{children}</p>;
}

/**
 * The one number that decides whether the day needs rearranging.
 *
 * Three equal boxes said all three mattered equally, which is how a dashboard
 * ends up with nothing to look at first. What other people are waiting on you
 * for leads. It is the only one where somebody else is blocked, and the other
 * two are supporting facts at supporting size, on one surface divided by
 * hairlines rather than floating apart as peers.
 */
/**
 * How many people are still on this review, the reader among them.
 *
 * `pending` already includes the reader, unlike the webhook payload the same
 * cap is applied to elsewhere, so nothing is added here. The backend's
 * services/reviewerLimit carries the rule in full; this is the browser's copy
 * of one line of it, applied to rows the page already has rather than by
 * asking for them again.
 */
function reviewerCount(pr: { pending?: string[] }): number | null {
  return pr.pending ? pr.pending.length : null;
}

/**
 * The queue's own cap on how many reviewers before a review stops being yours.
 *
 * Kept in this browser rather than in the account's preferences, deliberately:
 * the notification and summary caps are rules about when to interrupt somebody,
 * and this is a rule about what to look at right now. They are set in different
 * places because they answer different questions, and somebody narrowing their
 * screen for an afternoon should not thereby stop being told about reviews.
 */
const QUEUE_LIMIT_KEY = "mywork.reviewerLimit";

function readQueueLimit(): number | null {
  try {
    const raw = localStorage.getItem(QUEUE_LIMIT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch {
    // Private windows and blocked site data both throw here. No cap is the
    // honest fallback: it shows more rather than silently hiding work.
    return null;
  }
}

function Headline({ mergeable, onYou, toReview }: {
  mergeable: number; onYou: number; toReview: number;
}) {
  const clear = toReview === 0;
  return (
    <div className="mb-7">
      {/* The state's ink as a rule rather than a tint behind the number: amber
          while people are waiting, forest when nobody is. */}
      <div className={`h-[3px] w-full ${clear ? "bg-forest" : "bg-ochre"}`} aria-hidden="true" />
      <div className="grid gap-0 sm:grid-cols-[1.4fr_1fr_1fr] columned pt-5">
        <div className="pr-8">
          <p className="caps">Waiting on you</p>
          <p className={`figure text-[clamp(3rem,6vw,4.25rem)] mt-3 ${clear ? "text-ink-4" : "text-ochre"}`}>
            {toReview}
          </p>
          <p className="standfirst text-[0.8125rem] mt-3 max-w-[34ch]">
            {clear
              ? "Nobody is blocked on a review from you."
              : `${toReview === 1 ? "One pull request is" : `${toReview} pull requests are`} blocked until you look.`}
          </p>
        </div>

        <MiniStat icon="ph-git-merge" tone="text-forest"
          label="Ready to merge" value={mergeable}
          foot={mergeable ? "nothing is in the way" : "none waiting to go out"} />
        <MiniStat icon="ph-wrench" tone="text-ochre"
          label="Need your attention" value={onYou}
          foot={onYou ? "conflicts, checks or a stale base" : "none of yours are stuck"} />
      </div>
      <div className="border-t border-rule mt-6" />
    </div>
  );
}

function MiniStat({ icon, label, value, foot, tone }: {
  icon: string; label: string; value: number; foot: string; tone: string;
}) {
  return (
    <div className="px-0 sm:px-8 py-4 sm:py-0">
      <p className="caps flex items-baseline gap-2">
        <i className={`${icon} ph-bold text-[0.8125rem] ${value === 0 ? "text-ink-4" : tone}`} aria-hidden="true" />
        {label}
      </p>
      <p className={`figure text-[2.5rem] mt-3 ${value === 0 ? "text-ink-4" : "text-ink"}`}>{value}</p>
      <p className="standfirst text-[0.75rem] mt-2 truncate">{foot}</p>
    </div>
  );
}

function Queue() {
  // Above the early returns below, where a hook would be React error #310 in
  // production. The lazy form so localStorage is read once rather than on
  // every render. repro-hookorder guards the rule.
  const [queueLimit, setQueueLimit] = useState<number | null>(readQueueLimit);
  const { data, isLoading, isError, error, refetch } = useMyWork();

  if (isLoading) return <Spinner label="Reading your queue" />;
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

  /**
   * The reviews this cap leaves, and how many it took away.
   *
   * Plain expressions rather than hooks: the guards above return early, and a
   * hook after one of them is React error #310.
   *
   * A row whose reviewer list could not be read is kept, the same way the
   * notification sends rather than withholds: hiding a review on the strength
   * of a number nobody could see is how somebody misses one.
   */
  const visibleToReview = queueLimit === null
    ? data.toReview
    : data.toReview.filter(pr => {
        const n = reviewerCount(pr);
        return n === null || n <= queueLimit;
      });
  const hiddenToReview = data.toReview.length - visibleToReview.length;

  return (
    <>
      {/* Applied once, above both, because a counter that disagrees with the
          list under it is worse than either being wrong on its own. */}
      <Headline mergeable={data.mergeable} onYou={data.onYou} toReview={visibleToReview.length} />

      {data.truncated && (
        <Note intent="warn">
          The pull request walk stopped at its page limit, so this may be missing
          the oldest few. Everything shown is real; the list is what may be short.
        </Note>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Waiting on you" count={visibleToReview.length}
          note="Reviews other people are blocked on."
          action={
            /* On the panel it filters, so the number and the control that
               changed it are never read apart. */
            <select value={queueLimit ?? ""}
              onChange={e => {
                const next = e.target.value === "" ? null : Number(e.target.value);
                setQueueLimit(next);
                try {
                  if (next === null) localStorage.removeItem(QUEUE_LIMIT_KEY);
                  else localStorage.setItem(QUEUE_LIMIT_KEY, String(next));
                } catch { /* Not being able to remember it does not stop it working now. */ }
              }}
              title="Counts everybody still awaiting review, you included."
              className="caps bg-transparent border-0 border-b border-rule-strong py-1 pr-5
                         text-ink-2 hover:text-ink focus:outline-none focus:border-ink transition-colors">
              <option value="">any number reviewing</option>
              <option value="1">only me reviewing</option>
              <option value="2">me and at most one other</option>
              <option value="3">at most three of us</option>
              <option value="4">at most four of us</option>
              <option value="5">at most five of us</option>
            </select>
          }>
          {visibleToReview.length === 0
            ? <Quiet>
                {hiddenToReview > 0
                  /* Never a bare "nothing to do" when a filter is why: that
                     reads as an empty queue and is the one wrong impression
                     this panel can give. */
                  ? `Nothing matches. ${hiddenToReview} ${hiddenToReview === 1 ? "review has" : "reviews have"} more reviewers than that.`
                  : "Nobody is waiting on a review from you."}
              </Quiet>
            : <Paged items={visibleToReview} keyOf={pr => pr.url}
                render={pr => <PullRow pr={pr} showAuthor />} />}
          {visibleToReview.length > 0 && hiddenToReview > 0 && (
            <p className="standfirst text-[0.75rem] px-5 py-3 border-t border-rule">
              {hiddenToReview} more {hiddenToReview === 1 ? "review has" : "reviews have"} more
              reviewers than that.
            </p>
          )}
        </Panel>

        <Panel title="Your pull requests" count={data.mine.length}
          note="Most idle first, since those are the forgotten ones.">
          {data.mine.length === 0
            ? <Quiet>You have nothing open.</Quiet>
            : <Paged items={data.mine} keyOf={pr => pr.url}
                render={pr => <PullRow pr={pr} />} />}
        </Panel>
      </div>

      {data.cachedAt && (
        <p className="caps mt-5 pt-3 border-t border-rule">
          Collected {new Date(data.cachedAt).toLocaleString()}
        </p>
      )}
    </>
  );
}

/**
 * The answer to "why can't I push", as a verdict rather than a form.
 *
 * The first attempt was a pair of inputs above two bulleted lists, which is a
 * settings screen wearing a question's clothes. What somebody wants here is the
 * shape of an answer: can I or can't I, what is in the way, and who can move
 * it. So the verdict is the largest thing on screen, the rules read as gates
 * rather than as prose, and the people who can let you through have faces.
 */

const GATE_ICON: Record<string, string> = {
  "Pull request required": "ph-git-pull-request",
  "Pushes are restricted": "ph-lock-key",
  "No force pushing": "ph-arrow-u-up-left",
  "Commits must be signed": "ph-seal-check",
  "Linear history": "ph-line-segments",
};

const NEED_ICON: Record<string, string> = {
  "Code owner review": "ph-user-check",
  "Conversations resolved": "ph-chats-circle",
  "Merge method": "ph-git-merge",
  "Deployed first": "ph-rocket-launch",
  "Someone else must approve last": "ph-users-three",
  "No approval required": "ph-lock-simple-open",
};

function iconFor(label: string, gate: "push" | "merge"): string {
  if (GATE_ICON[label]) return GATE_ICON[label];
  if (NEED_ICON[label]) return NEED_ICON[label];
  if (/approval/i.test(label)) return "ph-thumbs-up";
  if (/check/i.test(label)) return "ph-check-square";
  return gate === "push" ? "ph-prohibit" : "ph-arrow-fat-line-right";
}

/** One rule, as a gate you have to get through. */
function GateRow({ rule, tone }: { rule: PushRule; tone: "block" | "need" }) {
  const block = tone === "block";
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <span className={`mt-0.5 w-8 h-8 shrink-0 grid place-items-center border ${
        block ? "border-crimson-edge bg-crimson-wash text-crimson"
              : "border-indigo-edge bg-indigo-wash text-indigo"}`}>
        <i className={`ph-bold ${iconFor(rule.label, rule.gate)} text-[0.9375rem]`} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="display text-[1.0625rem] leading-snug text-ink">{rule.label}</div>
        <div className="standfirst text-[0.7812rem] mt-1">{rule.detail}</div>
      </div>
    </div>
  );
}

/**
 * The headline, which is the whole point of the screen.
 *
 * Four states, and they are genuinely different answers rather than shades of
 * one: nothing protects it, you are exempt, you cannot push but can open a
 * pull request, and the rules could not be read at all. The last is the one
 * that must never look like the first.
 */
function Verdict({ data }: { data: PushCheckData }) {
  const blocked = (data.cannotPushBecause?.length ?? 0) > 0;
  const unknown = !!data.unreadable || !data.reachable;

  const look = unknown
    ? { wash: "bg-ochre", icon: "ph-question", tint: "text-ochre",
        title: "Cannot say", sub: data.message ?? "The rules could not be read." }
    : data.protected === false
      ? { wash: "bg-forest", icon: "ph-lock-simple-open", tint: "text-forest",
          title: "You can push", sub: `Nothing protects ${data.branch}.` }
      : data.canBypass
        ? { wash: "bg-ochre", icon: "ph-shield-star", tint: "text-ochre",
            title: "You can push anyway", sub: data.bypassNote ?? "" }
        : blocked
          ? { wash: "bg-crimson", icon: "ph-prohibit", tint: "text-crimson",
              title: "You cannot push directly", sub: `Open a pull request into ${data.branch} instead.` }
          : { wash: "bg-forest", icon: "ph-check-circle", tint: "text-forest",
              title: "Nothing blocks you", sub: `${data.branch} is protected, but not against you.` };

  return (
    <div className="mb-2">
      <span className={`block h-[3px] w-full ${look.wash}`} aria-hidden="true" />
      <div className="flex items-start gap-5 pt-5">
        <span className={`w-12 h-12 grid place-items-center shrink-0 border border-rule-strong ${look.tint}`}>
          <i className={`ph-fill ${look.icon} text-[1.375rem]`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className={`display text-[clamp(1.75rem,3.2vw,2.375rem)] leading-tight ${look.tint}`}>
            {look.title}
          </h2>
          <p className="standfirst text-[0.875rem] mt-2 max-w-[62ch]">{look.sub}</p>
          <div className="dateline mt-3 font-mono text-[0.75rem]">
            <span>{data.repo}</span>
            <span>{data.branch}</span>
          </div>
        </div>
      </div>
      <div className="border-t border-rule mt-6" />
    </div>
  );
}

function PushCheck() {
  /**
   * Names only, from the access map rather than from GitHub.
   *
   * This box wants a list of repository names to autocomplete against, and it
   * used to get them from the repository list, which is a live walk of the
   * organization one hundred at a time with no cache behind it: five or six
   * sequential GitHub requests, every time somebody opened this tab, to fill a
   * `datalist`. The access map is derived from the stored graph, is held for
   * five minutes, already answers exactly this question, and costs GitHub
   * nothing.
   */
  const { data: names = [] } = useAccessRepos(true);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const { data, isFetching, isError, error } = usePushCheck(repo, branch);
  const blocks = data?.cannotPushBecause ?? [];
  const needs = data?.mergeNeeds ?? [];

  return (
    <div className="grid gap-6">
      {/* The question, kept to one line so it does not read as a settings form. */}
      <div className="flex flex-wrap items-end gap-8 border-t-2 border-ink pt-5">
        <div className="flex-1 min-w-[14rem]">
          <label className="caps block mb-1">Repository</label>
          <input list="mywork-repos" value={repo} onChange={e => setRepo(e.target.value)}
            placeholder="Start typing a name" className="field-line display text-[1.125rem]" />
          <datalist id="mywork-repos">{names.map(n => <option key={n} value={n} />)}</datalist>
        </div>
        <div className="w-[11rem]">
          <label className="caps block mb-1">Branch</label>
          <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="main"
            className="field-line display text-[1.125rem]" />
        </div>
      </div>

      {!repo && (
        <p className="standfirst text-[0.9375rem] py-12 text-center max-w-[48ch] mx-auto">
          Pick a repository and branch. This says what will happen before you try it,
          and who can let you through if something is in the way.
        </p>
      )}

      {repo && isFetching && <Spinner label="Reading the rules" />}
      {repo && isError && <Note intent="danger">{(error as Error)?.message ?? "Could not read the rules."}</Note>}

      {data && !isFetching && (
        <>
          <Verdict data={data} />

          {data.reachable && !data.unreadable && data.protected && (
            <div className="grid gap-6 lg:grid-cols-2">
              {blocks.length > 0 && (
                <Panel title="In the way of a direct push" count={blocks.length}>
                  <div className="divide-y divide-rule">
                    {blocks.map(r => <GateRow key={r.label} rule={r} tone="block" />)}
                  </div>
                </Panel>
              )}

              <Panel title="What a pull request will need" count={needs.length}
                note={needs.length === 0 ? undefined : "Every one of these, before it can merge."}>
                {needs.length === 0
                  ? <Quiet>Nothing beyond opening it.</Quiet>
                  : <div className="divide-y divide-rule">
                      {needs.map(r => <GateRow key={r.label} rule={r} tone="need" />)}
                    </div>}
              </Panel>
            </div>
          )}

          {(data.approvers?.length ?? 0) > 0 && (
            <Panel title="Who can let you through" count={data.approvers!.length}
              note="Admins can change the rule as well as satisfy it.">
              <div className="flex flex-wrap gap-x-7 gap-y-3 p-5">
                {data.approvers!.map(p => (
                  <span key={p.login} className="inline-flex items-center gap-2.5">
                    <UserAvatar login={p.login} size={20} />
                    <span className="text-[0.8125rem] text-ink">{p.login}</span>
                    {p.role === "admin" && <Pill intent="neutral">admin</Pill>}
                  </span>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What went out, as a record of output rather than two lists.
 *
 * The number leads, because "eleven things in thirty days" is the answer and
 * the rows are the evidence. Merges are grouped by day so the shape of a
 * fortnight is visible without reading a single title, and what is still open
 * sits beside it rather than below. Those are two halves of one question, not
 * a list and an appendix.
 */
/**
 * Where a merged row points on github.com.
 *
 * Null rather than a guess. A row written before the pull request number was
 * recorded, or one that is about a push rather than a pull request, has nothing
 * to link to, and `/pull/undefined` is a worse outcome than plain text: it
 * looks clickable, and lands on a 404.
 */
function githubLinkFor(entry: ShipEntry, org: string): string | null {
  if (!org || !entry.repo) return null;
  return entry.prNumber
    ? `https://github.com/${org}/${entry.repo}/pull/${entry.prNumber}`
    : `https://github.com/${org}/${entry.repo}`;
}

function Shipped() {
  const { data: orgConfig } = useOrgConfig();
  const org = orgConfig?.org || "";
  const [days, setDays] = useState(7);
  const { data, isLoading, isError, error, refetch } = useShipped(days);

  /** Merges grouped by calendar day, newest first. */
  const byDay = useMemo(() => {
    const out: { label: string; rows: typeof data extends undefined ? never : any[] }[] = [];
    for (const e of data?.merged ?? []) {
      const d = new Date(e.timestamp);
      const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(e);
      else out.push({ label, rows: [e] });
    }
    return out;
  }, [data]);

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        {/* Said, because it is stored rather than asked for. This is served
            from a row the scheduled pass keeps warm, so without a stamp a
            reader who merged something a minute ago reads its absence as the
            merge not having been recorded. */}
        <span className="text-[0.7188rem] text-slate-400 dark:text-slate-500 tabular-nums">
          {data?.computedAt && (
            <>
              <i className="ph-bold ph-clock-counter-clockwise mr-1 text-[0.6875rem]" aria-hidden="true" />
              counted {ago(data.computedAt)}
              {data.refreshing && <span className="ml-1 opacity-60">(refreshing)</span>}
            </>
          )}
        </span>
        <Segmented value={String(days)} onChange={v => setDays(Number(v))}
          options={[["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]} />
      </div>

      {isLoading && <Spinner label="Reading what you shipped" />}
      {isError && <LoadFailed what="your shipping history" error={error as Error} onRetry={() => refetch()} />}

      {data && (
        <>
          {/* Said before the list, not after it: an explanation below the rows is
              read after somebody has already drawn the wrong conclusion. */}
          {!data.detailedLogging && (
            <Note intent="warn">
              Merges are not being recorded. Detailed logging is off for this organization,
              so nothing below can show what went out. Turning it on starts from then,
              not retroactively.
            </Note>
          )}

          <div className="mb-7">
            <span className={`block h-[3px] w-full ${data.merged.length > 0 ? "bg-forest" : "bg-rule-strong"}`}
              aria-hidden="true" />
            <div className="grid gap-0 sm:grid-cols-[1.35fr_1fr] columned pt-5">
              <div className="pr-8">
                <p className="caps">Merged in {data.days} days</p>
                <p className={`figure text-[clamp(3rem,6vw,4.25rem)] mt-3 ${
                  data.merged.length === 0 ? "text-ink-4" : "text-forest"}`}>
                  {data.merged.length}
                </p>
                <div className="dateline mt-3">
                  {data.pushes > 0 && <span>{data.pushes} pushed directly</span>}
                  <span>
                    {data.merged.length === 0
                      ? (data.detailedLogging ? "Nothing merged in this window." : "Nothing recorded.")
                      : `Across ${byDay.length} ${byDay.length === 1 ? "day" : "days"}.`}
                  </span>
                </div>
              </div>

              <MiniStat icon="ph-calendar-check" tone="text-indigo"
                label="Active days" value={byDay.length}
                foot={byDay.length ? "days you shipped something" : "no merges in the window"} />
            </div>
            <div className="border-t border-rule mt-6" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
            <Panel title="What went out" count={data.merged.length} note="Grouped by the day it merged.">
              {byDay.length === 0
                ? <Quiet>{data.detailedLogging ? "Nothing merged in this window." : "Nothing recorded."}</Quiet>
                : <Paged items={byDay} keyOf={day => day.label} perPage={4} bare
                    render={day => (
                      <div>
                        <div className="flex items-baseline gap-3 mb-2.5">
                          <span className="caps text-ink">{day.label}</span>
                          <span className="flex-1 border-t border-rule translate-y-[-3px]" />
                          <span className="figure text-[0.8125rem] text-ink-3">{day.rows.length}</span>
                        </div>
                        <div className="grid gap-1.5">
                          {day.rows.map((e: ShipEntry) => {
                            const href = githubLinkFor(e, org);
                            const inner = (
                              <>
                                <span className="display text-[0.9375rem] text-ink truncate">
                                  {e.target || e.details}
                                </span>
                                <span className="ml-auto text-[0.6875rem] font-mono text-ink-3 shrink-0">
                                  {e.repo}{e.prNumber ? `#${e.prNumber}` : ""}
                                </span>
                              </>
                            );
                            const shape = "flex items-baseline gap-2.5 pl-3 py-1 border-l-2 border-forest no-underline";
                            // Plain text when there is nowhere to go. Something
                            // that looks clickable and lands on a 404 is worse
                            // than something that does not look clickable.
                            return href ? (
                              <a key={e.id} href={href} target="_blank" rel="noreferrer noopener"
                                className={`${shape} group/ship hover:bg-ink/[0.035] transition-colors`}>
                                {inner}
                                <span className="caps shrink-0 opacity-0 group-hover/ship:opacity-100 transition-opacity"
                                  aria-hidden="true">Open</span>
                              </a>
                            ) : (
                              <div key={e.id} className={shape}>{inner}</div>
                            );
                          })}
                        </div>
                      </div>
                    )} />}
            </Panel>

          </div>
        </>
      )}
    </div>
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

      <div className="mb-7">
        <Segmented
          value={lens}
          onChange={v => setLens(v as Lens)}
          options={[
            ["queue", "Queue"],
            ["push", "Why can't I push?"],
            ["shipped", "What did I ship?"],
            ["board", "My widgets"],
            ["myalarms", "My alarms"],
            ["alerts", "Notifications"],
          ]}
        />
      </div>

      {lens === "queue" && <Queue />}
      {lens === "push" && <PushCheck />}
      {lens === "shipped" && <Shipped />}
      {lens === "board" && <PersonalBoard />}
      {lens === "myalarms" && <MyAlarmsPanel />}
      {lens === "alerts" && <DevAlertSettings />}
    </Page>
  );
}
