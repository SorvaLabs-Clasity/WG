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
  nobody:    { label: "Ready to merge", tone: "text-emerald-600 dark:text-emerald-400", rail: "bg-emerald-500" },
  you:       { label: "On you",         tone: "text-amber-600 dark:text-amber-400",     rail: "bg-amber-500" },
  reviewers: { label: "On reviewers",   tone: "text-sky-600 dark:text-sky-400",         rail: "bg-sky-500" },
  checks:    { label: "Checks running", tone: "text-slate-400 dark:text-slate-500",     rail: "bg-slate-300 dark:bg-paper-3" },
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
                 hover:bg-slate-50/80 dark:hover:bg-ink/[0.035] transition-colors"
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
            {pr.idleDays < 1 ? "today" : idleLabel(pr.idleDays)}
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
    <section className={`${SURFACE.card} overflow-hidden flex flex-col`}>
      <div className="px-5 pt-4">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-ink">{title}</h3>
          {count !== undefined && (
            <span className="text-[12px] font-bold tabular-nums text-slate-300 dark:text-slate-600">{count}</span>
          )}
          {action && <div className="ml-auto self-center">{action}</div>}
        </div>
        {note && <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">{note}</p>}
        <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3" />
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/** Rows share one surface, divided by hairlines, rather than floating apart. */
function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-slate-100 dark:divide-ink/[0.06]">{children}</div>;
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
        <div className="flex items-center justify-between gap-3 px-5 py-2.5
                        border-t border-slate-100 dark:border-ink/[0.06]">
          <span className="text-[11.5px] tabular-nums text-slate-400 dark:text-slate-500">
            {current * perPage + 1}&ndash;{current * perPage + shown.length} of {items.length}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(current - 1)} disabled={current === 0}
              className="w-7 h-7 grid place-items-center rounded-lg text-slate-500 dark:text-slate-400
                         hover:bg-slate-100 dark:hover:bg-ink/[0.08] disabled:opacity-25 disabled:hover:bg-transparent"
              aria-label="Previous">
              <i className="ph-bold ph-caret-left text-[12px]" />
            </button>
            <button onClick={() => setPage(current + 1)} disabled={current >= pages - 1}
              className="w-7 h-7 grid place-items-center rounded-lg text-slate-500 dark:text-slate-400
                         hover:bg-slate-100 dark:hover:bg-ink/[0.08] disabled:opacity-25 disabled:hover:bg-transparent"
              aria-label="Next">
              <i className="ph-bold ph-caret-right text-[12px]" />
            </button>
          </div>
        </div>
      )}
    </>
  );
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
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] mb-5">
      <div className={`${SURFACE.card} relative overflow-hidden px-6 py-5`}>
        {/* Tinted by the answer, so the direction reads before the number
            does: amber when people are waiting, green when nobody is. */}
        <div aria-hidden="true"
          className={`pointer-events-none absolute -right-16 -top-16 w-56 h-56 rounded-full blur-2xl opacity-[0.16]
            ${clear ? "bg-emerald-500" : "bg-amber-500"}`} />

        <div className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Waiting on you</div>
        <div className="flex items-end gap-3 mt-2.5">
          <span className={`text-[52px] font-semibold tabular-nums leading-[0.85] tracking-[-0.04em]
            ${clear ? "text-slate-300 dark:text-slate-600" : "text-slate-900 dark:text-ink"}`}>
            {toReview}
          </span>
          {!clear && (
            <span className="mb-1.5 inline-flex items-center px-2 py-1 rounded-lg text-[12px] font-bold
                             bg-amber-500/10 text-amber-700 dark:text-amber-400">
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
                       gap-px bg-slate-200/70 dark:bg-ink/[0.07]`}>
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
    <div className="bg-white dark:bg-paper px-5 py-4 flex items-center gap-4">
      <i className={`${icon} ph-fill text-[19px] ${value === 0 ? "text-slate-300 dark:text-slate-600" : tone}`}
         aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-[22px] font-semibold tabular-nums leading-none
            ${value === 0 ? "text-slate-300 dark:text-slate-600" : "text-slate-900 dark:text-ink"}`}>
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
  // Above the early returns below, where a hook would be React error #310 in
  // production. The lazy form so localStorage is read once rather than on
  // every render. repro-hookorder guards the rule.
  const [queueLimit, setQueueLimit] = useState<number | null>(readQueueLimit);
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

      <div className="grid gap-4 lg:grid-cols-2">
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
              className="text-[12px] py-1 pl-2 pr-6 rounded-lg bg-white dark:bg-ink/[0.06]
                         border border-slate-200 dark:border-ink/10 text-slate-600 dark:text-slate-300">
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
            <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-2">
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
        <p className="mt-4 text-[11.5px] text-slate-400 dark:text-slate-500">
          Collected {new Date(data.cachedAt).toLocaleString()}.
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
    <div className="flex items-start gap-3.5 px-5 py-3.5">
      <span className={`mt-[1px] w-8 h-8 rounded-xl shrink-0 grid place-items-center ${
        block
          ? "bg-rose-50 dark:bg-rose-500/10 text-rose-500 dark:text-rose-400"
          : "bg-sky-50 dark:bg-sky-500/10 text-sky-500 dark:text-sky-400"}`}>
        <i className={`ph-bold ${iconFor(rule.label, rule.gate)} text-[15px]`} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">{rule.label}</div>
        <div className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{rule.detail}</div>
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
    ? { wash: "bg-amber-400", icon: "ph-question", tint: "text-amber-600 dark:text-amber-400",
        title: "Cannot say", sub: data.message ?? "The rules could not be read." }
    : data.protected === false
      ? { wash: "bg-emerald-500", icon: "ph-lock-simple-open", tint: "text-emerald-600 dark:text-emerald-400",
          title: "You can push", sub: `Nothing protects ${data.branch}.` }
      : data.canBypass
        ? { wash: "bg-amber-400", icon: "ph-shield-star", tint: "text-amber-600 dark:text-amber-400",
            title: "You can push anyway", sub: data.bypassNote ?? "" }
        : blocked
          ? { wash: "bg-rose-500", icon: "ph-prohibit", tint: "text-rose-600 dark:text-rose-400",
              title: "You cannot push directly", sub: `Open a pull request into ${data.branch} instead.` }
          : { wash: "bg-emerald-500", icon: "ph-check-circle", tint: "text-emerald-600 dark:text-emerald-400",
              title: "Nothing blocks you", sub: `${data.branch} is protected, but not against you.` };

  return (
    <div className={`${SURFACE.card} relative overflow-hidden px-6 py-6`}>
      <div aria-hidden="true"
        className={`pointer-events-none absolute -right-20 -top-24 w-64 h-64 rounded-full blur-3xl opacity-[0.15] ${look.wash}`} />
      <div className="flex items-start gap-4">
        <span className={`w-12 h-12 rounded-2xl grid place-items-center shrink-0
                          bg-white dark:bg-ink/[0.06] border border-slate-200/80 dark:border-ink/10 ${look.tint}`}>
          <i className={`ph-fill ${look.icon} text-[22px]`} aria-hidden="true" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-ink leading-tight">
            {look.title}
          </h2>
          <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1 max-w-[62ch] leading-relaxed">
            {look.sub}
          </p>
          <div className="flex items-center gap-1.5 mt-3">
            <span className="text-[11px] font-mono px-2 py-1 rounded-lg bg-slate-100 dark:bg-ink/[0.07]
                             text-slate-600 dark:text-slate-300">{data.repo}</span>
            <i className="ph-bold ph-caret-right text-[10px] text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <span className="text-[11px] font-mono px-2 py-1 rounded-lg bg-slate-100 dark:bg-ink/[0.07]
                             text-slate-600 dark:text-slate-300">{data.branch}</span>
          </div>
        </div>
      </div>
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
    <div className="grid gap-4">
      {/* The question, kept to one line so it does not read as a settings form. */}
      <div className={`${SURFACE.card} p-4 flex flex-wrap items-end gap-3`}>
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500 mb-1.5">
            Repository
          </label>
          <input list="mywork-repos" value={repo} onChange={e => setRepo(e.target.value)}
            placeholder="Start typing a name" className={SURFACE.input} />
          <datalist id="mywork-repos">{names.map(n => <option key={n} value={n} />)}</datalist>
        </div>
        <div className="w-[180px]">
          <label className="block text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500 mb-1.5">
            Branch
          </label>
          <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="main" className={SURFACE.input} />
        </div>
      </div>

      {!repo && (
        <div className={`${SURFACE.card} px-6 py-14 text-center`}>
          <i className="ph-duotone ph-git-branch text-[34px] text-slate-300 dark:text-slate-600" aria-hidden="true" />
          <p className="text-[13.5px] text-slate-500 dark:text-slate-400 mt-3 max-w-[46ch] mx-auto leading-relaxed">
            Pick a repository and branch. This says what will happen before you try it,
            and who can let you through if something is in the way.
          </p>
        </div>
      )}

      {repo && isFetching && <div className="py-20 flex justify-center"><Spinner /></div>}
      {repo && isError && <Note intent="danger">{(error as Error)?.message ?? "Could not read the rules."}</Note>}

      {data && !isFetching && (
        <>
          <Verdict data={data} />

          {data.reachable && !data.unreadable && data.protected && (
            <div className="grid gap-4 lg:grid-cols-2">
              {blocks.length > 0 && (
                <Panel title="In the way of a direct push" count={blocks.length}>
                  <div className="divide-y divide-slate-100 dark:divide-ink/[0.06]">
                    {blocks.map(r => <GateRow key={r.label} rule={r} tone="block" />)}
                  </div>
                </Panel>
              )}

              <Panel title="What a pull request will need" count={needs.length}
                note={needs.length === 0 ? undefined : "Every one of these, before it can merge."}>
                {needs.length === 0
                  ? <Quiet>Nothing beyond opening it.</Quiet>
                  : <div className="divide-y divide-slate-100 dark:divide-ink/[0.06]">
                      {needs.map(r => <GateRow key={r.label} rule={r} tone="need" />)}
                    </div>}
              </Panel>
            </div>
          )}

          {(data.approvers?.length ?? 0) > 0 && (
            <Panel title="Who can let you through" count={data.approvers!.length}
              note="Admins can change the rule as well as satisfy it.">
              <div className="flex flex-wrap gap-2 p-5">
                {data.approvers!.map(p => (
                  <span key={p.login}
                    className="inline-flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full
                               bg-slate-50 dark:bg-ink/[0.05] border border-slate-200/80 dark:border-ink/10">
                    <UserAvatar login={p.login} size={20} />
                    <span className="text-[12.5px] font-semibold text-slate-700 dark:text-slate-200">{p.login}</span>
                    {p.role === "admin" && (
                      <span className="text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded
                                       bg-slate-900 dark:bg-white text-reverse dark:text-slate-900">admin</span>
                    )}
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
        <span className="text-[11.5px] text-slate-400 dark:text-slate-500 tabular-nums">
          {data?.computedAt && (
            <>
              <i className="ph-bold ph-clock-counter-clockwise mr-1 text-[11px]" aria-hidden="true" />
              counted {ago(data.computedAt)}
              {data.refreshing && <span className="ml-1 opacity-60">(refreshing)</span>}
            </>
          )}
        </span>
        <Segmented value={String(days)} onChange={v => setDays(Number(v))}
          options={[["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]} />
      </div>

      {isLoading && <div className="py-20 flex justify-center"><Spinner /></div>}
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

          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <div className={`${SURFACE.card} relative overflow-hidden px-6 py-5`}>
              <div aria-hidden="true"
                className={`pointer-events-none absolute -right-16 -top-16 w-56 h-56 rounded-full blur-2xl opacity-[0.16]
                  ${data.merged.length > 0 ? "bg-emerald-500" : "bg-slate-400"}`} />
              <div className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
                Merged in {data.days} days
              </div>
              <div className="flex items-end gap-3 mt-2.5">
                <span className={`text-[52px] font-semibold tabular-nums leading-[0.85] tracking-[-0.04em]
                  ${data.merged.length === 0 ? "text-slate-300 dark:text-slate-600" : "text-slate-900 dark:text-ink"}`}>
                  {data.merged.length}
                </span>
                {data.pushes > 0 && (
                  <span className="mb-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-bold
                                   bg-slate-100 dark:bg-ink/[0.07] text-slate-500 dark:text-slate-400">
                    <i className="ph-bold ph-arrow-fat-line-up text-[12px]" aria-hidden="true" />
                    {data.pushes} direct
                  </span>
                )}
              </div>
              <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-2.5">
                {data.merged.length === 0
                  ? (data.detailedLogging ? "Nothing merged in this window." : "Nothing recorded.")
                  : `Across ${byDay.length} ${byDay.length === 1 ? "day" : "days"}.`}
              </p>
            </div>

            <div className={`${SURFACE.card} overflow-hidden grid gap-px bg-slate-200/70 dark:bg-ink/[0.07]`}>
              <MiniStat icon="ph-calendar-check" tone="text-violet-600 dark:text-violet-400"
                label="Active days" value={byDay.length}
                foot={byDay.length ? "days you shipped something" : "no merges in the window"} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <Panel title="What went out" count={data.merged.length} note="Grouped by the day it merged.">
              {byDay.length === 0
                ? <Quiet>{data.detailedLogging ? "Nothing merged in this window." : "Nothing recorded."}</Quiet>
                : <Paged items={byDay} keyOf={day => day.label} perPage={4} bare
                    render={day => (
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
                            {day.label}
                          </span>
                          <span className="flex-1 h-px bg-slate-200/70 dark:bg-ink/[0.07]" />
                          <span className="text-[11px] tabular-nums text-slate-300 dark:text-slate-600">
                            {day.rows.length}
                          </span>
                        </div>
                        <div className="grid gap-1.5">
                          {day.rows.map((e: ShipEntry) => {
                            const href = githubLinkFor(e, org);
                            const inner = (
                              <>
                                <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100 truncate">
                                  {e.target || e.details}
                                </span>
                                <span className="ml-auto text-[11px] font-mono text-slate-400 dark:text-slate-500 shrink-0">
                                  {e.repo}{e.prNumber ? `#${e.prNumber}` : ""}
                                </span>
                              </>
                            );
                            const shape = "flex items-baseline gap-2.5 pl-3 border-l-2 border-emerald-400/70";
                            // Plain text when there is nowhere to go. Something
                            // that looks clickable and lands on a 404 is worse
                            // than something that does not look clickable.
                            return href ? (
                              <a key={e.id} href={href} target="_blank" rel="noreferrer noopener"
                                className={`${shape} group/ship rounded-r hover:bg-slate-50 dark:hover:bg-ink/[0.04] transition-colors`}>
                                {inner}
                                <i className="ph-bold ph-arrow-square-out text-[11px] text-slate-300 dark:text-slate-600
                                              opacity-0 group-hover/ship:opacity-100 transition-opacity shrink-0"
                                   aria-hidden="true" />
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

      <div className="mb-5">
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
