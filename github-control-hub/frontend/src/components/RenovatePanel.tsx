import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchRenovate, fetchRenovateDashboards, fetchDetectedDependencies,
  tickRenovateDashboard, setRenovateBot,
  type DashboardCategory, type RenovatePr, type RepoDashboard,
} from "../api/renovate";
import { usePermissions } from "../hooks/usePermissions";
import { useAccessRepos } from "../hooks/useAccess";
import {
  Spinner, Note, Button, SearchInput, Chip, Pill, Empty, ConfirmDialog,
  SURFACE, TYPE, INTENT, enter, type Intent,
} from "../design";
import { useOrgConfig } from "../hooks/useOrgConfig";
import { useMyAccess } from "../hooks/useMe";

/**
 * Everything Renovate is doing, as one operations queue.
 *
 * Three rewrites got here, and the third was rejected for the reason none of
 * them had considered: it was styled from scratch. Hand-mixed hex greys, 2px
 * radii, hard-coded 26px rows, bare rules, no shadow and no motion, dropped
 * into an app whose every other page is built from `SURFACE.card`, `INTENT`
 * and `TYPE`. On its own it was defensible. Next to the rest of the product it
 * read as a different application bolted on, which is what "sloppy" describes.
 *
 * `tokens.ts` states the agreed direction: saturated colour, depth and motion,
 * with colour only ever carrying meaning. The panel speaks that language now
 * and invents nothing of its own:
 *
 *   - **The five states are the app's five intents**, so "errored" is the same
 *     red as every other error in the product rather than a hue chosen here.
 *   - **Surfaces are `SURFACE.card` and `SURFACE.inset`**, so a repository
 *     block sits at the elevation a repository block sits at everywhere else.
 *   - **Type comes from `TYPE`**, so the count on this page carries the weight
 *     the count on every other page carries.
 *   - **Motion is `enter()`**, the staggered entrance the rest of the app uses,
 *     rather than nothing at all.
 *
 * The one idea worth keeping from the last attempt is the proportional bar.
 * Five equal tiles gave fourteen broken updates the same visual mass as two
 * thousand held back, which is backwards. So the bar carries the proportion
 * and the chips beneath it carry the counts and the filtering, because a bar
 * segment three pixels wide is not a control anybody can hit.
 */

type Lens = "errored" | "failing" | "waiting" | "ready" | "held";

/**
 * Which repositories are collapsed, for the life of the app rather than the
 * life of the component.
 *
 * The tab unmounts when somebody switches away from it, so ordinary state would
 * reset every time they came back and re-collapse everything they had just
 * opened. Module scope survives that and still resets when the app is
 * relaunched, which is exactly the span asked for: opened fresh, only the top
 * one is expanded; opened again in the same session, it is however it was left.
 *
 * `null` means this session has not opened the tab yet, which is what triggers
 * the one-time default below. An empty set is a real answer, "nothing is
 * collapsed", and the two must not be confused.
 */
let sessionShut: Set<string> | null = null;

/**
 * The collapsing section listing repositories Renovate has said nothing about.
 *
 * Kept in the same set as the repositories so both remember their state the
 * same way. A NUL byte cannot occur in a GitHub repository name, so this can
 * never collide with one.
 */
const QUIET_KEY = "\u0000quiet";

/**
 * Worst first, which is the order somebody works through them.
 *
 * `intent` rather than a colour, and that is the point: the queue borrows the
 * product's vocabulary for danger, warning, information and success instead of
 * teaching a second one that exists only on this screen.
 */
const LENSES: { id: Lens; label: string; intent: Intent }[] = [
  { id: "errored", label: "Errored", intent: "danger" },
  { id: "failing", label: "Failing", intent: "warn" },
  { id: "waiting", label: "Waiting on you", intent: "info" },
  { id: "ready", label: "Ready", intent: "good" },
  { id: "held", label: "Held back", intent: "neutral" },
];

const LENS = Object.fromEntries(LENSES.map(l => [l.id, l])) as Record<Lens, typeof LENSES[number]>;

/** Which lens a dashboard state belongs to, where it is not already a pull request. */
const LENS_OF: Record<DashboardCategory, Lens | null> = {
  errored: "errored", blocked: "errored",
  "pending-approval": "waiting", "pr-approval-required": "waiting",
  "rate-limited": "held", "awaiting-schedule": "held",
  "group-size-not-met": "held", "pending-checks": "held", other: "held",
  // Covered by the pull request it refers to, which knows whether it is ready.
  open: null,
};

const VERB: Record<DashboardCategory, string> = {
  errored: "Retry", blocked: "Recreate", "rate-limited": "Create",
  "pending-approval": "Approve", "pr-approval-required": "Approve",
  "group-size-not-met": "Create", "awaiting-schedule": "Run",
  "pending-checks": "Unpend", other: "Request", open: "Rebase",
};

const BULK_LABEL: Record<string, string> = {
  "create-all-rate-limited-prs": "Create all rate-limited",
  "approve-all-pending-prs": "Approve all pending",
  "create-all-awaiting-schedule-prs": "Run all scheduled",
  "rebase-all-open-prs": "Rebase all open",
  "create-config-migration-pr": "Open config migration",
  "manual job": "Run Renovate now",
};

/**
 * A request waiting to be confirmed.
 *
 * Held rather than acted on. Everything here instructs a bot that runs later,
 * on somebody else's repository, and several of them are bulk: "rebase all
 * open" on a repository with forty updates is forty force-pushes. None of that
 * is undoable from this screen.
 */
interface Pending {
  repo: string;
  issueNumber: number;
  marker: string;
  /** The button's own word, which is what the dialog confirms. */
  verb: string;
  /** What it is being done to, where that is one package rather than a repository. */
  subject?: string;
  intent: Intent;
}

/** Why a control is unavailable, said where somebody hovers it. */
const NO_WRITE = (repo: string) =>
  `You need write access to ${repo} to instruct Renovate there. `
  + "Asking it to act edits its dashboard issue, and this runs as you, not as the app.";

/**
 * What the confirmation says, per action.
 *
 * Kept apart from the button labels because they answer different questions.
 * The label says what the button does; this says what will actually happen,
 * which for every one of these is "a checkbox is ticked and a bot acts later".
 *
 * "Approve" gets its own paragraph. It is the most misreadable word on the
 * screen: it looks like approving a pull request and it is not one. It ticks
 * the box that tells Renovate it may go ahead and raise the update it is
 * holding back, and it carries no review, no approval and no merge.
 */
function explain(p: Pending): React.ReactNode {
  const what = p.subject
    ? <><span className="font-mono text-slate-700 dark:text-slate-200">{p.subject}</span> on </>
    : null;
  return (
    <>
      <p>
        This ticks a checkbox on {what}
        <span className="font-mono text-slate-700 dark:text-slate-200">{p.repo}</span>&#39;s Renovate
        dashboard issue. Renovate reads it on its next run, so nothing happens the moment this
        closes, and nothing here merges anything.
      </p>
      {/^approve$/i.test(p.verb) && (
        <p className="mt-2">
          This is not a pull request review. It tells Renovate it may raise the update it is
          holding back; whoever reviews and merges that pull request is unchanged.
        </p>
      )}
      {/all/i.test(p.verb) && (
        <p className="mt-2">
          This one applies to every matching update on the repository, not just one.
        </p>
      )}
    </>
  );
}

interface Row {
  repo: string;
  branch: string;
  title: string;
  /** The package, split out of Renovate's title for its own column. */
  name: string;
  lens: Lens;
  from?: string;
  to?: string;
  pr?: RenovatePr;
  marker?: string;
  verb?: string;
  requested?: boolean;
  issueNumber?: number;
}

/**
 * The version transition, pulled out of Renovate's own title.
 *
 * Its titles are "Update dependency lodash to v4.17.21" and "Update x from a to
 * b", so the package and the target are in there and worth their own columns.
 * Anything that does not match keeps its full title in the name column rather
 * than being mangled into one.
 */
function split(title: string): { name: string; from?: string; to?: string } {
  const from = /^Update (?:dependency )?(\S+) from (\S+) to (\S+)$/.exec(title);
  if (from) return { name: from[1], from: from[2], to: from[3] };
  const to = /^Update (?:dependency )?(\S+) to (\S+)$/.exec(title);
  if (to) return { name: to[1], to: to[2] };
  return { name: title };
}

/** What the row is waiting on, in the fewest words that say it. */
function stateOf(row: Row): string {
  if (!row.pr) return LENS[row.lens].label;
  const pr = row.pr;
  if (pr.checks === "SUCCESS") return "Checks passed";
  if (pr.checks === "FAILURE" || pr.checks === "ERROR") return "Checks failed";
  if (pr.mergeable === "CONFLICTING") return "Conflicts";
  if (pr.checks === "PENDING") return "Checks running";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "Review needed";
  return "Open";
}

function Inventory({ repo, issueNumber, query }: { repo: string; issueNumber: number; query: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["renovate", "detected", repo, issueNumber],
    queryFn: () => fetchDetectedDependencies(repo, issueNumber),
    staleTime: 300_000,
  });

  if (isLoading) {
    return <p className="text-[13px] text-slate-400 dark:text-slate-500 px-1 py-2">Reading the dashboard…</p>;
  }

  const manifests = (data?.detected ?? [])
    .map(m => ({ ...m, packages: query ? m.packages.filter(p => p.toLowerCase().includes(query)) : m.packages }))
    .filter(m => m.packages.length > 0);

  if (manifests.length === 0) {
    return (
      <p className="text-[13px] text-slate-400 dark:text-slate-500 px-1 py-2">
        {query ? "Nothing here matches that." : "This dashboard lists no dependencies."}
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 pt-1">
      {manifests.map(m => (
        <div key={`${m.ecosystem} ${m.manifest}`} className={`${SURFACE.inset} rounded-xl px-3.5 py-3`}>
          <p className={`${TYPE.label} text-slate-400 dark:text-slate-500 truncate`} title={m.manifest}>
            {m.manifest}
          </p>
          <ul className="mt-2 space-y-1">
            {m.packages.map(pkg => (
              <li key={pkg} className="font-mono text-[12.5px] text-slate-600 dark:text-slate-300 truncate">
                {pkg}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function RenovatePanel() {
  const qc = useQueryClient();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;

  // Every repository in the organization, so the panel can say which ones
  // Renovate has never said anything about. From the stored access graph, held
  // five minutes, and free of GitHub requests.
  const { data: allRepos } = useAccessRepos(true);
  const { data: orgConfig } = useOrgConfig();
  const org = orgConfig?.org ?? "";
  const { data: myAccess } = useMyAccess();

  /**
   * Whether this person could actually carry out an action on a repository.
   *
   * Instructing Renovate means editing its dashboard issue, and the request
   * runs as the person pressing the button rather than as the app, so GitHub
   * refuses it without write access. Knowing that here turns a 403 nobody
   * expected into a control that says why it is unavailable.
   *
   * **Open when the answer is not known.** An unbuilt graph returns an empty
   * list, and reading that as "writes nowhere" would disable every button for
   * everybody. Unknown means do not narrow: GitHub is still the authority, and
   * the refusal now explains itself.
   */
  const canWrite = (repo: string): boolean => {
    if (!myAccess || myAccess.unknown) return true;
    return myAccess.writableRepos.includes(repo);
  };

  const prs = useQuery({
    queryKey: ["renovate", "details"], queryFn: () => fetchRenovate(true), staleTime: 120_000,
  });
  const dash = useQuery({
    queryKey: ["renovate", "dashboards"], queryFn: fetchRenovateDashboards, staleTime: 120_000,
  });

  const [lens, setLens] = useState<Lens | null>(null);
  const [raw, setRaw] = useState("");
  const [shut, setShutState] = useState<Set<string>>(() => sessionShut ?? new Set());
  const [invOpen, setInvOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [botDraft, setBotDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const saveBot = useMutation({
    mutationFn: (bot: string) => setRenovateBot(bot),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ["renovate"] }); },
  });

  /** Written to both, so switching tabs and back does not undo it. */
  const setShut = (next: Set<string>) => { sessionShut = next; setShutState(next); };

  /**
   * Every repository the queue has something to say about, in the order it is
   * drawn. Derived before the early returns below, because the effect that
   * reads it is a hook and hooks cannot live after a conditional return.
   */
  const queueRepos = useMemo(() => {
    const names = new Set<string>();
    for (const d of dash.data?.dashboards ?? []) names.add(d.repo);
    for (const p of prs.data?.prs ?? []) if (p.state === "open") names.add(p.repo);
    return [...names].sort();
  }, [dash.data, prs.data]);

  /**
   * The one-time default: everything collapsed except the first.
   *
   * Only when this session has not opened the tab before. Reapplying it on
   * every mount would throw away whatever somebody had just expanded the moment
   * they looked at another tab and came back.
   */
  useEffect(() => {
    if (sessionShut !== null || queueRepos.length === 0) return;
    setShut(new Set([...queueRepos.slice(1), QUIET_KEY]));
  }, [queueRepos]);

  if (prs.isLoading || dash.isLoading) return <Spinner />;
  if (prs.error && dash.error) return <Note intent="danger">Could not read anything from Renovate.</Note>;

  const bot = prs.data?.bot ?? dash.data?.bot ?? null;

  const botField = (
    <div className="flex flex-wrap gap-2 items-center">
      <input value={botDraft} onChange={e => setBotDraft(e.target.value)}
        placeholder="e.g. my-renovate"
        className={`${SURFACE.input} font-mono max-w-xs`} />
      <Button variant="primary" onClick={() => saveBot.mutate(botDraft)} disabled={!botDraft.trim()}>
        Save
      </Button>
    </div>
  );

  if (prs.data && !prs.data.configured) {
    return (
      <div className={`${SURFACE.card} p-6`} style={enter(0)}>
        <h3 className={`${TYPE.heading} text-slate-900 dark:text-ink`}>Renovate is not set up yet</h3>
        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-2 max-w-2xl leading-relaxed`}>
          A self-hosted Renovate raises its pull requests and keeps its dashboard as a GitHub App,
          and its authorship is the only way to find them. Type the name shown beside one of its
          pull requests. The <span className="font-mono text-[12.5px]">[bot]</span> suffix an App's
          login carries is added for you.
        </p>
        <div className="mt-4">
          {isAdmin ? botField : (
            <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400`}>
              An organization admin has to set the bot account.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (dash.data?.unknownBot || prs.data?.unknownBot) {
    return (
      <div className={`${SURFACE.card} p-6`} style={enter(0)}>
        <div className="flex items-center gap-2.5">
          <h3 className={`${TYPE.heading} text-slate-900 dark:text-ink`}>That bot was not found</h3>
          <Pill intent="warn">check the name</Pill>
        </div>
        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-2 max-w-2xl leading-relaxed`}>
          GitHub does not recognise <span className="font-mono text-slate-700 dark:text-slate-200">{bot}</span>.
          A self-hosted Renovate raises its work as a GitHub App, whose login carries a{" "}
          <span className="font-mono text-[12.5px]">[bot]</span> suffix that GitHub's own pages hide,
          so the name shown beside a pull request is not the name search wants.
        </p>
        {isAdmin && <div className="mt-4">{botField}</div>}
      </div>
    );
  }

  const dashboards: RepoDashboard[] = dash.data?.dashboards ?? [];
  const openPrs = (prs.data?.prs ?? []).filter(p => p.state === "open");

  // Joined on the branch, which is the key Renovate writes into both.
  const byBranch = new Map<string, RenovatePr>();
  for (const pr of openPrs) if (pr.headRefName) byBranch.set(`${pr.repo}|${pr.headRefName}`, pr);

  const lensOfPr = (pr: RenovatePr): Lens =>
    pr.readiness === "ready" ? "ready"
      : pr.readiness === "failing" || pr.readiness === "conflicting" ? "failing" : "held";

  const rows: Row[] = [];
  const claimed = new Set<string>();

  for (const d of dashboards) {
    for (const item of d.items) {
      const key = `${d.repo}|${item.branch}`;
      const pr = byBranch.get(key);
      const l = pr ? lensOfPr(pr) : LENS_OF[item.category];
      if (!l) continue;
      if (pr) claimed.add(key);
      rows.push({
        repo: d.repo, branch: item.branch, lens: l, ...split(item.title), title: item.title,
        pr, marker: `${item.action}-branch=${item.branch}`, verb: VERB[item.category],
        requested: item.checked, issueNumber: d.issueNumber,
      });
    }
  }
  // Pull requests on repositories with no dashboard. Dropping them would make a
  // repository without one look like a repository with no Renovate activity.
  for (const pr of openPrs) {
    const key = `${pr.repo}|${pr.headRefName ?? ""}`;
    if (claimed.has(key)) continue;
    rows.push({
      repo: pr.repo, branch: pr.headRefName ?? "", lens: lensOfPr(pr),
      ...split(pr.title), title: pr.title, pr,
    });
  }

  const counts = Object.fromEntries(
    LENSES.map(l => [l.id, rows.filter(r => r.lens === l.id).length])) as Record<Lens, number>;
  const total = rows.length;
  const repoCount = dashboards.length || new Set(rows.map(r => r.repo)).size;

  const query = raw.trim().toLowerCase();
  const visible = rows.filter(r =>
    (!lens || r.lens === lens)
    && (!query || `${r.repo} ${r.name} ${r.branch} ${r.title}`.toLowerCase().includes(query)));

  const groups = [...new Set(visible.map(r => r.repo))].sort().map(repo => ({
    repo,
    rows: visible.filter(r => r.repo === repo)
      .sort((a, b) => LENSES.findIndex(l => l.id === a.lens) - LENSES.findIndex(l => l.id === b.lens)),
    dashboard: dashboards.find(d => d.repo === repo),
  }));

  const act = async (repo: string, issueNumber: number, marker: string, what: string) => {
    setBusy(`${repo}|${marker}`); setNotice(null);
    try {
      const r = await tickRenovateDashboard(repo, issueNumber, marker);
      setNotice(r.ticked
        ? { ok: true, msg: `${what} requested on ${repo}. Renovate acts at its next run.` }
        : { ok: false, msg: r.reason ?? "Nothing to do." });
      qc.invalidateQueries({ queryKey: ["renovate", "dashboards"] });
    } catch (e: any) {
      setNotice({ ok: false, msg: e?.message ?? "Could not ask Renovate." });
    } finally { setBusy(null); }
  };

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); apply(next);
  };

  /**
   * Repositories Renovate has said nothing about.
   *
   * The sweep is a search for issues the bot wrote, so it can only ever return
   * repositories Renovate is already active on: a repository it has never
   * touched is invisible to it, which is why this list could not be built from
   * the sweep alone. The names come from the access map, which is derived from
   * the stored graph and costs GitHub nothing.
   *
   * Described as "nothing seen" rather than "Renovate is off", because the two
   * are not the same and this cannot tell them apart. Renovate can be perfectly
   * well onboarded with `dependencyDashboard` disabled, in which case it writes
   * no issue and, with no update currently open, looks exactly like a
   * repository it has never been near.
   */
  const active = new Set([...dashboards.map(d => d.repo), ...openPrs.map(p => p.repo)]);
  const quiet = (allRepos ?? []).filter(r => !active.has(r)).sort();
  const quietVisible = query ? quiet.filter(r => r.toLowerCase().includes(query)) : quiet;

  const stamp = dash.data?.computedAt ?? prs.data?.computedAt;
  const refreshing = dash.data?.refreshing || prs.data?.refreshing;
  const present = LENSES.filter(l => counts[l.id] > 0);
  // The figure takes the colour of the worst thing in the queue, so the number
  // says whether the queue is healthy before a word of it has been read.
  const worst = present[0]?.intent ?? "neutral";

  return (
    <div className="grid gap-5">

      {/* ── the queue at a glance ───────────────────────────────────────── */}
      <div className={`${SURFACE.card} overflow-hidden`} style={enter(0)}>
        <div className="px-6 pt-5 pb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Renovate queue</p>
            <div className="flex items-baseline gap-3 mt-1.5">
              <span className={`${TYPE.metricSm} ${INTENT[worst].figure}`}>
                {total.toLocaleString()}
              </span>
              <span className={`${TYPE.sub} text-slate-500 dark:text-slate-400`}>
                {total === 1 ? "update" : "updates"} across {repoCount}{" "}
                {repoCount === 1 ? "repository" : "repositories"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {bot && <Chip>{bot}</Chip>}
            {stamp && (
              <span className="text-[11.5px] text-slate-400 dark:text-slate-500 tabular-nums">
                read {new Date(stamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                {refreshing && <span className="ml-1 opacity-70">· refreshing</span>}
              </span>
            )}
            {isAdmin && (
              <Button variant="ghost" onClick={() => { setBotDraft(bot ?? ""); setEditing(!editing); }}>
                {editing ? "Cancel" : "Change bot"}
              </Button>
            )}
          </div>
        </div>

        {editing && isAdmin && <div className="px-6 pb-5 -mt-1">{botField}</div>}

        {total > 0 && (
          <div className="px-6 pb-5">
            {/* Widths are the counts, so the geometry is the distribution: two
                thousand held back and fourteen broken must not look alike. A
                floor keeps a tiny segment visible; it is read rather than
                clicked, because the chips below are the control. */}
            <div className="flex h-2.5 w-full rounded-full overflow-hidden gap-px" aria-hidden="true">
              {present.map(l => (
                <span key={l.id} style={{ flexGrow: counts[l.id] }}
                  className={`min-w-[3px] transition-opacity duration-200 ${INTENT[l.intent].mark}
                              ${lens && lens !== l.id ? "opacity-25" : "opacity-100"}`} />
              ))}
            </div>

            <div className="flex flex-wrap gap-2 mt-3.5">
              {present.map(l => {
                const on = lens === l.id;
                const t = INTENT[l.intent];
                return (
                  <button key={l.id} onClick={() => setLens(on ? null : l.id)} aria-pressed={on}
                    className={`inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-xl border
                                transition-all ${on
                                  ? `${t.soft} ${t.border} shadow-sm`
                                  : "border-transparent hover:bg-slate-100 dark:hover:bg-ink/[0.06]"}`}>
                    <span className={`w-2 h-2 rounded-full ${t.mark}`} />
                    <span className={`text-[13px] font-bold tabular-nums
                                      ${on ? t.text : "text-slate-700 dark:text-slate-200"}`}>
                      {counts[l.id].toLocaleString()}
                    </span>
                    <span className={`text-[12.5px] ${on ? t.text : "text-slate-500 dark:text-slate-400"}`}>
                      {l.label}
                    </span>
                  </button>
                );
              })}
              {lens && (
                <button onClick={() => setLens(null)}
                  className="px-3 py-1.5 text-[12.5px] font-bold text-slate-400 dark:text-slate-500
                             hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {notice && <Note intent={notice.ok ? "good" : "warn"}>{notice.msg}</Note>}

      {total > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={raw} onChange={setRaw}
            placeholder="Filter by repository, package or branch" />
          {(query || lens) && (
            <span className={`${TYPE.sub} text-slate-400 dark:text-slate-500 tabular-nums`}>
              {visible.length.toLocaleString()} of {total.toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* ── the queue itself, one card per repository ───────────────────── */}
      {groups.length === 0 ? (
        <Empty
          title={lens || query ? "Nothing matches that" : "Nothing outstanding"}
          body={lens || query
            ? "Clear the filter to see the rest of the queue."
            : "Renovate has nothing waiting on any repository it watches."}
          action={(lens || query)
            ? <Button onClick={() => { setLens(null); setRaw(""); }}>Clear filters</Button>
            : undefined}
        />
      ) : groups.map(({ repo, rows: group, dashboard }, gi) => {
        const open = query ? true : !shut.has(repo);
        const kinds = LENSES.filter(l => group.some(r => r.lens === l.id));
        return (
          <div key={repo} className={`${SURFACE.card} overflow-hidden`} style={enter(gi, 35, 300)}>

            {/* The heading does two jobs, so it is two controls rather than one.
                The name opens the repository on GitHub; the caret and the space
                beside it collapse the group. Nesting a link inside a button is
                not allowed, and making the whole bar a link would take the
                collapse away, which is the control somebody uses far more. */}
            <div className="flex items-center gap-3 px-6 py-4 group/head">
              <button onClick={() => toggle(shut, repo, setShut)} aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${repo}`}
                className="shrink-0 w-6 h-6 -ml-1 grid place-items-center rounded-lg
                           text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                           hover:bg-slate-100 dark:hover:bg-ink/[0.06] transition-colors">
                <i className={`ph-bold ph-caret-right text-[13px] transition-transform duration-200
                               ${open ? "rotate-90" : ""}`} aria-hidden="true" />
              </button>

              <a href={org ? `https://github.com/${org}/${repo}` : undefined}
                target="_blank" rel="noreferrer noopener"
                title={`Open ${repo} on GitHub`}
                className={`${TYPE.heading} font-mono text-slate-900 dark:text-ink truncate
                            hover:underline underline-offset-4 decoration-slate-300
                            dark:decoration-slate-600 transition-colors`}>
                {repo}
              </a>

              {/* One dot per state present, so a collapsed repository still
                  says whether anything inside it is broken. */}
              <span className="flex items-center gap-1 shrink-0">
                {kinds.map(l => (
                  <span key={l.id} title={l.label}
                    className={`w-1.5 h-1.5 rounded-full ${INTENT[l.intent].mark}`} />
                ))}
              </span>

              {/* The rest of the bar still collapses. Not reachable by keyboard
                  on purpose: the caret above already is, and two tab stops for
                  one action is noise for somebody using a screen reader. */}
              <button onClick={() => toggle(shut, repo, setShut)}
                tabIndex={-1} aria-hidden="true"
                className="flex-1 self-stretch min-w-[16px] cursor-pointer" />

              <span className="shrink-0">
                <Pill intent={kinds[0]?.intent ?? "neutral"}>{group.length}</Pill>
              </span>
            </div>

            {open && (
              <div className="px-4 pt-1 pb-4 grid gap-1.5">
                {group.map((r, i) => {
                  const t = INTENT[LENS[r.lens].intent];
                  const running = busy === `${r.repo}|${r.marker}`;
                  const href = r.pr?.url ?? dashboard?.url;
                  const writable = canWrite(repo);
                  return (
                    <div key={`${r.repo}|${r.branch}|${r.title}`} style={enter(i, 14, 200)}
                      className={`relative overflow-hidden rounded-xl ${SURFACE.inset}
                                  hover:border-slate-300 dark:hover:border-ink/20 transition-colors`}>
                      <span className={`absolute left-0 top-0 bottom-0 w-1 ${t.mark}`} aria-hidden="true" />

                      <div className="relative pl-4 pr-3.5 py-2.5 grid items-center gap-x-4 gap-y-1
                                      grid-cols-[minmax(0,1fr)_auto]
                                      lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_136px_auto]">

                        {/* Every row opens something. A row backed by a pull
                            request opens the pull request; one that exists only
                            on the dashboard opens the dashboard issue, which is
                            the only place it is written down. */}
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer noopener" title={r.title}
                            className={`${TYPE.mono} text-slate-800 dark:text-slate-100 truncate
                                        hover:underline underline-offset-4 decoration-slate-300
                                        dark:decoration-slate-600`}>
                            {r.name}
                          </a>
                        ) : (
                          <span className={`${TYPE.mono} text-slate-800 dark:text-slate-100 truncate`}
                            title={r.title}>
                            {r.name}
                          </span>
                        )}

                        {/* The transition, which is what the row is about. The
                            target carries the state colour, so the eye lands on
                            what it is moving to. */}
                        <span className="font-mono text-[12.5px] tabular-nums truncate
                                         order-3 lg:order-none col-span-2 lg:col-span-1">
                          {r.from && (
                            <>
                              <span className="text-slate-400 dark:text-slate-500">{r.from}</span>
                              <span className="text-slate-300 dark:text-slate-600 mx-1.5">&rarr;</span>
                            </>
                          )}
                          {r.to && <span className={`font-semibold ${t.text}`}>{r.to}</span>}
                        </span>

                        <span className={`text-[12.5px] font-semibold ${t.text} truncate
                                          order-2 lg:order-none justify-self-end lg:justify-self-start`}>
                          {stateOf(r)}
                        </span>

                        <span className="flex items-center justify-end gap-2
                                         order-4 lg:order-none col-span-2 lg:col-span-1">
                          {r.pr && (
                            <a href={r.pr.url} target="_blank" rel="noreferrer noopener"
                              className="font-mono text-[12px] tabular-nums text-slate-400 dark:text-slate-500
                                         hover:text-slate-900 dark:hover:text-ink transition-colors">
                              #{r.pr.number}
                            </a>
                          )}
                          {r.marker && r.issueNumber !== undefined && (
                            r.requested
                              ? <span className="caps">sent</span>
                              : <button disabled={busy !== null || !writable}
                                  title={writable ? undefined : NO_WRITE(repo)}
                                  onClick={() => setPending({
                                    repo: r.repo, issueNumber: r.issueNumber!, marker: r.marker!,
                                    verb: r.verb!, subject: r.name, intent: LENS[r.lens].intent,
                                  })}
                                  className={`px-2.5 py-1 rounded-lg text-[12px] font-bold transition-all
                                              ${t.soft} ${t.text} hover:shadow-sm
                                              disabled:opacity-40 disabled:cursor-not-allowed`}>
                                  {running ? "…" : r.verb}
                                </button>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}

                {dashboard && (
                  <div className="flex flex-wrap items-center gap-2 pt-2 px-1">
                    {dashboard.bulk.filter(b => !b.checked && BULK_LABEL[b.marker]).map(b => (
                      <button key={b.marker} disabled={busy !== null || !canWrite(repo)}
                        title={canWrite(repo) ? undefined : NO_WRITE(repo)}
                        onClick={() => setPending({
                          repo, issueNumber: dashboard.issueNumber, marker: b.marker,
                          verb: BULK_LABEL[b.marker], intent: "warn",
                        })}
                        className="px-2.5 py-1 rounded-lg text-[12px] font-bold
                                   text-slate-500 dark:text-slate-400
                                   hover:bg-slate-100 dark:hover:bg-ink/[0.06]
                                   hover:text-slate-900 dark:hover:text-ink
                                   disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                        {BULK_LABEL[b.marker]}
                      </button>
                    ))}
                    {dashboard.detectedPackages > 0 && (
                      <button onClick={() => toggle(invOpen, repo, setInvOpen)}
                        aria-expanded={invOpen.has(repo)}
                        className="ml-auto px-2.5 py-1 rounded-lg text-[12px] font-bold
                                   text-slate-500 dark:text-slate-400
                                   hover:bg-slate-100 dark:hover:bg-ink/[0.06]
                                   hover:text-slate-900 dark:hover:text-ink transition-all">
                        {invOpen.has(repo) ? "Hide" : "Show"} {dashboard.detectedPackages} dependencies
                      </button>
                    )}
                  </div>
                )}

                {dashboard && invOpen.has(repo) && (
                  <Inventory repo={repo} issueNumber={dashboard.issueNumber} query={query} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* ── what Renovate is not watching ──────────────────────────────────
          Hidden while a lens is selected: the lenses narrow the queue, and
          these repositories are not in it. */}
      {!lens && quiet.length > 0 && (() => {
        const open = !shut.has(QUIET_KEY);
        return (
          <div className={`${SURFACE.card} overflow-hidden`} style={enter(groups.length, 35, 300)}>
            <button onClick={() => toggle(shut, QUIET_KEY, setShut)} aria-expanded={open}
              className="w-full flex items-center gap-3 px-6 py-4 text-left
                         hover:bg-slate-50 dark:hover:bg-ink/[0.03] transition-colors">
              <i className={`ph-bold ph-caret-right text-slate-400 text-[13px] transition-transform
                             duration-200 ${open ? "rotate-90" : ""}`} aria-hidden="true" />
              <h3 className={`${TYPE.heading} text-slate-900 dark:text-ink`}>
                No Renovate activity
              </h3>
              <span className="ml-auto shrink-0"><Pill intent="neutral">{quiet.length}</Pill></span>
            </button>

            {open && (
              <div className="px-6 pt-1 pb-5">
                <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 leading-relaxed max-w-[80ch]`}>
                  Renovate has written no dashboard and has no update open on{" "}
                  {quiet.length === 1 ? "this repository" : "these repositories"}. That usually means
                  it has not been onboarded, but it is not proof: a repository configured with{" "}
                  <span className="font-mono text-[12.5px]">dependencyDashboard</span> turned off and
                  nothing currently outstanding looks the same from here.
                </p>

                {quietVisible.length === 0 ? (
                  <p className={`${TYPE.sub} text-slate-400 dark:text-slate-500 mt-4`}>
                    None of them match that filter.
                  </p>
                ) : (
                  <ul className="mt-4 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                    {quietVisible.map(repo => (
                      <li key={repo}
                        className={`${SURFACE.inset} rounded-xl px-3.5 py-2 font-mono text-[12.5px]
                                    text-slate-600 dark:text-slate-300 truncate`}
                        title={repo}>
                        {repo}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })()}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        busy={busy !== null}
        intent={pending?.intent ?? "info"}
        title={pending ? `${pending.verb}?` : ""}
        confirmLabel={pending?.verb ?? "Confirm"}
        body={pending ? explain(pending) : null}
        onConfirm={() => {
          if (!pending) return;
          const p = pending;
          // Held open until the request finishes, so the dialog is what shows
          // the work. Closed first, the button springs back to normal for the
          // second or two the call takes and reads as having done nothing.
          void act(p.repo, p.issueNumber, p.marker, p.verb).finally(() => setPending(null));
        }}
      />

      <p className={`${TYPE.sub} text-slate-400 dark:text-slate-500 leading-relaxed max-w-[80ch]`}>
        Acting here ticks a checkbox on the repository's dashboard issue, which is how a
        self-hosted Renovate is instructed. It acts at its next run, not immediately. Nothing
        here merges anything.
        {dashboards.length === 0 && (
          <> No dependency dashboards were found, so only pull requests are listed: Renovate keeps
          one per repository where its config sets <span className="font-mono">dependencyDashboard</span>.</>
        )}
      </p>
    </div>
  );
}
