import { useEffect, useMemo, useRef, useState } from "react";
import { useDevAlerts, useSaveDevAlerts, useTestDevAlerts } from "../hooks/useMe";
import { Note, Button, Spinner, SURFACE } from "../design";
import { allZones, zoneLabel } from "../lib/zones";
import type { DigestPrefs, EventPrefs } from "../api/me";

/**
 * A developer's own notifications, to their own Teams.
 *
 * Two mechanisms with genuinely different jobs, so they are two sections rather
 * than one list of switches. Events interrupt you within seconds and are worth
 * it for a couple of things; the digest is the pile you work through once a day.
 * Presenting them together would invite people to tick everything as an event
 * and then mute the channel a week later.
 *
 * The webhook URL is write-only. It comes back from the server as a boolean,
 * never as the URL, because anybody who reads it can post into that channel for
 * as long as it exists.
 */

const DAYS = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"],
] as const;

/**
 * One section of the summary, with how far back it reaches.
 *
 * The limit sits on the row rather than in a settings block of its own: it is a
 * property of that section, and two hundred year-old pull requests crowding out
 * three from this week is a per-section problem.
 */
/**
 * The reviewer-cap choices, shared by the notification and the summary.
 *
 * One list because they are one rule asked in two places, and two lists is how
 * "only me" comes to mean something slightly different depending on which
 * screen you set it on.
 */
export const REVIEWER_LIMIT_OPTIONS: [string, string][] = [
  ["", "Any number of reviewers"],
  ["1", "Only when I am the only reviewer"],
  ["2", "Only me and at most one other"],
  ["3", "At most three of us"],
  ["4", "At most four of us"],
  ["5", "At most five of us"],
];

function IncludeRow({ label, checked, onChange, days, onDays, limit, onLimit }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
  days: number; onDays: (d: number) => void;
  /**
   * Only the review row has these. The other two sections are the reader's own
   * pull requests, where "how many reviewers" is not a reason to leave one out.
   */
  limit?: number | null;
  onLimit?: (v: number | null) => void;
}) {
  return (
    <div className="py-2.5">
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-3 cursor-pointer min-w-0 flex-1">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          className="w-4 h-4 rounded accent-slate-900 dark:accent-white shrink-0" />
        <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{label}</span>
      </label>
      <div className={`flex items-center gap-1.5 shrink-0 ${checked ? "" : "opacity-40 pointer-events-none"}`}>
        {/* Phrased as what gets dropped, not what gets kept.
            It read "quiet under 30 days", which is true, the filter keeps
            anything touched within the limit, but it describes the survivors
            while the reason anybody opens this menu is to cut a long list. Said
            that way round it was read as its own opposite.

            The words are hidden at "any age", because there is no limit to
            describe and "skip if quiet over any age" is not a sentence. */}
        {days > 0 && (
          <span className="text-[11.5px] text-slate-400 dark:text-slate-500">skip if quiet over</span>
        )}
        <select value={days} onChange={e => onDays(Number(e.target.value))}
          title="Anything untouched for longer than this is left out of the summary."
          className="text-[12px] py-1 pl-2 pr-6 rounded-lg bg-white dark:bg-white/[0.06]
                     border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200">
          {/* Zero first, because no limit is the default and the honest one:
              a summary that silently drops things nobody asked it to drop is
              worse than a long summary. */}
          <option value={0}>any age</option>
          {[3, 7, 14, 30, 60, 90].map(d => <option key={d} value={d}>{d} days</option>)}
        </select>
      </div>
    </div>

    {/* Under the row rather than beside it: a second dropdown on the same line
        made three controls in a row and none of them readable. Shown only for
        the section it applies to, and only while that section is included. */}
    {onLimit && checked && (
      <div className="flex items-center gap-1.5 mt-1.5 ml-7">
        <span className="text-[11.5px] text-slate-400 dark:text-slate-500">and only when</span>
        <select value={limit ?? ""} onChange={e => onLimit(e.target.value === "" ? null : Number(e.target.value))}
          title="Counts everybody still awaiting review, you included, and a team counts as one."
          className="text-[12px] py-1 pl-2 pr-6 rounded-lg bg-white dark:bg-white/[0.06]
                     border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200">
          {REVIEWER_LIMIT_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>{v === "" ? "any number are reviewing" : label.toLowerCase()}</option>
          ))}
        </select>
      </div>
    )}
    </div>
  );
}

/** A select with no chrome of its own, for sitting inside a shared field. */
const BARE_SELECT = "bg-transparent border-0 p-0 pr-4 text-[13px] font-semibold tabular-nums "
  + "text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-0 cursor-pointer";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The wall clock in someone else's timezone, or null if the zone is unknown. */
function zoneNow(timeZone: string): { hour: number; minute: number; day: number } | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone, hour: "numeric", minute: "2-digit", hour12: false, weekday: "short",
      }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return {
      // Midnight formats as "24" here, and reading it as hour 24 would put
      // every midnight comparison a day out.
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
      day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday)),
    };
  } catch {
    return null;
  }
}

/**
 * When the next summary actually arrives, said in full.
 *
 * The rule it describes is not guessable from the controls: a time already
 * past today means tomorrow, and a day that is switched off is skipped. Both
 * were previously things somebody found out by not receiving anything.
 */
function nextRun(digest: DigestPrefs): string | null {
  const now = zoneNow(digest.timeZone);
  if (!now) return null;

  const chosen = digest.hour * 60 + (digest.minute ?? 0);
  const allowed = digest.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : digest.days;
  if (allowed.length === 0) return null;

  let ahead = chosen > now.hour * 60 + now.minute ? 0 : 1;
  while (!allowed.includes((now.day + ahead) % 7) && ahead < 8) ahead++;

  const when = ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : `on ${DAY_NAMES[(now.day + ahead) % 7]}`;
  return `${when} at ${clockLabel(digest.hour, digest.minute ?? 0)}`;
}

const clockLabel = (h: number, m: number) =>
  `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;

function Row({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: string; checked: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 py-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded accent-slate-900 dark:accent-white"
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-slate-800 dark:text-slate-100">{label}</span>
        {hint && <span className="block text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

export default function DevAlertSettings() {
  const { data, isLoading } = useDevAlerts();
  const save = useSaveDevAlerts();
  const test = useTestDevAlerts();

  const [address, setAddress] = useState("");
  const [events, setEvents] = useState<EventPrefs | null>(null);
  const [reviewerLimit, setReviewerLimit] = useState<number | null>(null);
  const [digest, setDigest] = useState<DigestPrefs | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Save shortly after somebody stops, rather than on every keystroke.
   *
   * A request per keystroke makes the time field lag under its own saves, and
   * has a consequence past the UI: changing the time decides whether today's
   * summary is still owed, so dragging through 10:15, 10:20, 10:25 asks that
   * question three times. Only where somebody stopped is a real answer.
   */
  const queued = useRef<any>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Above the loading return, so the hook count does not change between the
  // spinner and the form. Grouped by region, and labelled the same way as the
  // pickers in Alarms, so one zone reads identically wherever it appears.
  const current = digest?.timeZone ?? data?.digest?.timeZone ?? "UTC";
  const zones = useMemo(() => {
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const id of allZones(current)) {
      const [region, ...rest] = id.split("/");
      const key = rest.length ? region : "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id, label: zoneLabel(id) });
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [current]);

  // A pending save must not be dropped by unmounting the tab.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Seeded once the server answers, then left alone: re-seeding on every fetch
  // would throw away half-typed edits when the query refetches underneath.
  useEffect(() => {
    if (data && !events) {
      setEvents(data.events);
      setReviewerLimit(data.reviewerLimit ?? null);
      setDigest(data.digest);
      setAddress(data.teamsAddress ?? "");
    }
  }, [data, events]);

  if (isLoading || !data || !events || !digest) {
    return <div className="py-16 flex justify-center"><Spinner /></div>;
  }

  const commit = async (body: any) => {
    setSaved(false);
    await save.mutateAsync(body);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const queue = (body: any) => {
    queued.current = { ...queued.current, ...body };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const body = queued.current;
      queued.current = null;
      if (body) commit(body);
    }, 600);
  };

  const patchEvents = (p: Partial<EventPrefs>) => {
    const next = { ...events, ...p };
    setEvents(next);
    commit({ events: next });
  };
  const patchDigest = (p: Partial<DigestPrefs>) => {
    const next = { ...digest, ...p };
    setDigest(next);
    queue({ digest: next });
  };

  return (
    <div className="grid gap-4">
      {/* ── where it goes ─────────────────────────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
            Where to reach you
          </h3>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            Your work email, the one you sign in to Teams with. Messages arrive as a
            direct message from the Power Automate bot.
          </p>
          <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
        </div>

        <div className="p-5">
          {/* Two different things can be missing, and only one of them is
              something this person can fix. */}
          {!data.teamsReady && (
            <div className="mb-3">
              <Note intent="warn">
                Teams delivery has not been set up for this organization yet. An administrator
                does that once, in Alarms, and then this works for everybody. You can fill in
                your address now, but nothing will arrive until they have.
              </Note>
            </div>
          )}

          {data.lastError && (
            <div className="mb-3">
              <Note intent="danger">
                Last delivery failed: {data.lastError}
                {data.lastErrorAt && ` (${new Date(data.lastErrorAt).toLocaleString()})`}
              </Note>
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="email" value={address} onChange={e => setAddress(e.target.value)}
              placeholder="you@company.com"
              className={SURFACE.input}
            />
            <Button variant="primary"
              disabled={!address.trim() || address.trim() === data.teamsAddress || save.isPending}
              onClick={() => commit({ teamsAddress: address.trim() })}>
              Save
            </Button>
          </div>

          {save.isError && (
            <div className="mt-3"><Note intent="danger">{(save.error as Error)?.message}</Note></div>
          )}

          <div className="flex items-center gap-3 mt-4 flex-wrap">
            <Button onClick={() => test.mutate()}
              disabled={!data.teamsAddress || !data.teamsReady || test.isPending}>
              {test.isPending ? "Sending…" : "Send a test now"}
            </Button>
            {/* Power Automate answers before it runs the flow, so a queued
                request is not a delivered message. */}
            {test.isSuccess && (
              test.data?.queued ? (
                <span className="text-[12.5px] font-semibold text-amber-700 dark:text-amber-500">
                  Accepted by Power Automate. If nothing arrives, ask an administrator to check
                  the flow's run history.
                </span>
              ) : (
                <span className="text-[12.5px] font-semibold text-emerald-600 dark:text-emerald-400">
                  Delivered. Check Teams.
                </span>
              )
            )}
            {test.isError && (
              <span className="text-[12.5px] font-semibold text-rose-600 dark:text-rose-400">
                {(test.error as Error)?.message}
              </span>
            )}
            {data.lastSentAt && !test.isPending && (
              <span className="text-[11.5px] text-slate-400 dark:text-slate-500 ml-auto">
                Last delivered {new Date(data.lastSentAt).toLocaleString()}
              </span>
            )}
          </div>

          {!data.teamsAddress && (
            <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-3">
              Nothing is sent until an address is saved, whatever is ticked below.
            </p>
          )}
        </div>
      </section>

      {/* ── the moments worth interrupting for ────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
            Tell me straight away
          </h3>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            Arrives within seconds. Kept short on purpose. A message that is not worth
            reading immediately teaches you to ignore the ones that are.
          </p>
          <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
        </div>
        <div className="px-5 pb-4">
          <Row
            label="Somebody asks me to review"
            hint="Only when you are named. A request to a team names nobody, so it notifies nobody."
            checked={events.reviewRequested}
            onChange={v => patchEvents({ reviewRequested: v })}
          />

          {/* Only where it can apply. A limit under a switch that is off is a
              control for something that is not happening. */}
          {events.reviewRequested && (
            <div className="pl-1 pb-3 -mt-1">
              <label className="block text-[11.5px] text-slate-500 dark:text-slate-400 mb-1.5">
                Only when the review is mine to do
              </label>
              <select
                value={reviewerLimit ?? ""}
                onChange={e => {
                  const next = e.target.value === "" ? null : Number(e.target.value);
                  setReviewerLimit(next);
                  commit({ reviewerLimit: next });
                }}
                className={`${SURFACE.input} max-w-sm`}
              >
                <option value="">Every request, however many people were asked</option>
                <option value="1">Only when I am the only reviewer</option>
                <option value="2">Only me and at most one other</option>
                <option value="3">At most three of us</option>
                <option value="4">At most four of us</option>
                <option value="5">At most five of us</option>
              </select>
              {/* The counting rule, said once. Somebody choosing "only me" and
                  then not hearing about a request to themselves and a team
                  would reasonably call that broken. */}
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
                Counts everybody still awaiting review, you included, and a team
                counts as one. A request whose reviewer list cannot be read is
                sent rather than withheld. Anything skipped here is still in the
                daily summary.
              </p>
            </div>
          )}
          <Row
            label="Somebody requests changes on mine"
            hint="Needs the pull_request_review event ticked on the GitHub App. Without it this stays quiet."
            checked={events.changesRequested}
            onChange={v => patchEvents({ changesRequested: v })}
          />
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-2">
            “Ready to merge” and “checks went red” are not single events. They are conclusions
            drawn from several, so they live in the summary below rather than as switches here
            that would never quite fire.
          </p>
        </div>
      </section>

      {/* ── the daily pile ───────────────────────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
                Send me a summary
              </h3>
              <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                One message, at an hour you choose, in your own timezone.
              </p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <input type="checkbox" checked={digest.enabled}
                onChange={e => patchDigest({ enabled: e.target.checked })}
                className="w-4 h-4 rounded accent-slate-900 dark:accent-white" />
              <span className="text-[12.5px] font-semibold text-slate-700 dark:text-slate-200">On</span>
            </label>
          </div>
          <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
        </div>

        <div className={`px-5 pb-5 ${digest.enabled ? "" : "opacity-45 pointer-events-none"}`}>
          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                At
              </label>
              {/* Three controls in one field, rather than three inputs.
                  As three full inputs they were three lots of `px-3.5` borders
                  and padding in a half-width column, so the last of them, PM,
                  was clipped off the edge and the choice could not be made at
                  all. Bare controls inside one bordered box read as a single
                  time field and fit. */}
              <div className="inline-flex items-center gap-0.5 rounded-xl border border-slate-200
                              dark:border-white/10 bg-white dark:bg-white/[0.06] px-2 py-1.5
                              focus-within:ring-2 focus-within:ring-slate-900/10 dark:focus-within:ring-white/25">
                <select
                  aria-label="Hour"
                  value={((digest.hour + 11) % 12) + 1}
                  onChange={e => {
                    const twelve = Number(e.target.value) % 12;
                    patchDigest({ hour: digest.hour < 12 ? twelve : twelve + 12 });
                  }}
                  className={BARE_SELECT}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(h =>
                    <option key={h} value={h}>{h}</option>)}
                </select>

                <span className="text-[13px] font-bold text-slate-400 dark:text-slate-500">:</span>

                <select
                  aria-label="Minute"
                  value={digest.minute ?? 0}
                  onChange={e => patchDigest({ minute: Number(e.target.value) })}
                  className={BARE_SELECT}>
                  {/* Only the ticks the pass actually runs on. */}
                  {Array.from({ length: 12 }, (_, i) => i * 5).map(m =>
                    <option key={m} value={m}>{String(m).padStart(2, "0")}</option>)}
                </select>

                <div className="flex ml-1.5 rounded-lg overflow-hidden border border-slate-200 dark:border-white/10">
                  {(["AM", "PM"] as const).map(half => {
                    const on = (half === "AM") === (digest.hour < 12);
                    return (
                      <button key={half} type="button"
                        onClick={() => patchDigest({ hour: (digest.hour % 12) + (half === "AM" ? 0 : 12) })}
                        className={`px-2 py-1 text-[11px] font-bold leading-none transition-colors ${
                          on
                            ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900"
                            : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.05]"}`}>
                        {half}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
                The pass runs every five minutes on the clock, so these are the times it can keep.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                Timezone
              </label>
              {/* Was a text field, which is the wrong control for a value with
                  one correct spelling: "EST" or "New York" is not a zone, and
                  an unrecognised one is not rejected anywhere downstream, it
                  quietly becomes UTC and the summary turns up at the wrong
                  hour. Every zone the browser knows, so there is nothing to
                  spell. */}
              <select
                value={digest.timeZone}
                onChange={e => patchDigest({ timeZone: e.target.value })}
                className={SURFACE.input}>
                {zones.map(([region, entries]) => (
                  <optgroup key={region} label={region}>
                    {entries.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
                  </optgroup>
                ))}
              </select>
              {(() => {
                const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const clock = zoneNow(digest.timeZone);
                return (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {clock && (
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                        {clockLabel(clock.hour, clock.minute)} there now
                      </span>
                    )}
                    {here && here !== digest.timeZone && (
                      <button type="button" onClick={() => patchDigest({ timeZone: here })}
                        className="text-[11px] font-semibold text-slate-500 dark:text-slate-400
                                   underline underline-offset-2 hover:text-slate-900 dark:hover:text-white">
                        Use this computer's ({here.split("/").pop()?.replace(/_/g, " ")})
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              On
            </label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(([n, label]) => {
                const on = digest.days.length === 0 || digest.days.includes(n);
                return (
                  <button key={n} type="button"
                    onClick={() => {
                      // An empty list means every day, so the first click has to
                      // start from all-selected rather than from nothing.
                      const base = digest.days.length === 0 ? DAYS.map(d => d[0] as number) : digest.days;
                      const next = base.includes(n) ? base.filter(d => d !== n) : [...base, n];
                      patchDigest({ days: next });
                    }}
                    className={`px-2.5 py-1.5 rounded-lg text-[12px] font-bold border transition-colors ${
                      on
                        ? "border-slate-900 dark:border-white bg-slate-900 dark:bg-white text-white dark:text-slate-900"
                        : "border-slate-200 dark:border-white/15 text-slate-500 dark:text-slate-400"}`}>
                    {label}
                  </button>
                );
              })}
            </div>
            {digest.days.length === 0 && (
              <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-1.5">Every day.</p>
            )}
          </div>

          <div className="mt-4">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Include
            </label>
            {([
              ["toReview", "Reviews waiting on me"],
              ["mergeable", "Mine that are ready to merge"],
              ["mine", "My other open pull requests"],
            ] as const).map(([key, label]) => (
              <IncludeRow
                key={key} label={label}
                checked={digest.include[key]}
                onChange={v => patchDigest({ include: { ...digest.include, [key]: v } })}
                days={digest.maxAgeDays?.[key] ?? 0}
                onDays={d => patchDigest({ maxAgeDays: { ...digest.maxAgeDays, [key]: d } })}
                {...(key === "toReview"
                  ? { limit: digest.reviewerLimit ?? null,
                      onLimit: (v: number | null) => patchDigest({ reviewerLimit: v }) }
                  : {})}
              />
            ))}
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
              A limit keeps anything touched within it and leaves out the rest. Age is time
              since the last commit, so something touched this morning is never old however
              long ago it was opened.
            </p>
          </div>

          {/* Otherwise the only evidence a summary went out is having received
              it, and its absence is indistinguishable from it being broken.
              The next one is stated outright because the rule behind it is not
              visible in the controls: a time that has already gone today means
              tomorrow, not in a few minutes. */}
          <div className="mt-3 flex items-baseline gap-2 flex-wrap">
            {(() => {
              const next = nextRun(digest);
              return next ? (
                <span className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">
                  Next summary {next}.
                </span>
              ) : null;
            })()}
            <span className="text-[11.5px] text-slate-400 dark:text-slate-500">
              {data.lastDigestAt
                ? `Last one sent ${new Date(data.lastDigestAt).toLocaleString()}.`
                : "None sent yet."}
            </span>
          </div>

          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
            <Row
              label="Skip it when there is nothing to say"
              hint="On by default. A daily “you have nothing” is how a channel gets muted, and then the useful ones stop being read too."
              checked={digest.skipWhenEmpty}
              onChange={v => patchDigest({ skipWhenEmpty: v })}
            />
          </div>
        </div>
      </section>

      {saved && (
        <p className="text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">Saved.</p>
      )}
    </div>
  );
}
