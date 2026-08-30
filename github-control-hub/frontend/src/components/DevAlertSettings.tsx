import { useEffect, useState } from "react";
import { useDevAlerts, useSaveDevAlerts, useTestDevAlerts } from "../hooks/useMe";
import { Note, Button, Spinner, SURFACE } from "../design";
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
function IncludeRow({ label, checked, onChange, days, onDays }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
  days: number; onDays: (d: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <label className="flex items-center gap-3 cursor-pointer min-w-0 flex-1">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          className="w-4 h-4 rounded accent-slate-900 dark:accent-white shrink-0" />
        <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{label}</span>
      </label>
      <div className={`flex items-center gap-1.5 shrink-0 ${checked ? "" : "opacity-40 pointer-events-none"}`}>
        <span className="text-[11.5px] text-slate-400 dark:text-slate-500">quiet under</span>
        <select value={days} onChange={e => onDays(Number(e.target.value))}
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
  );
}

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
  const [digest, setDigest] = useState<DigestPrefs | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeded once the server answers, then left alone: re-seeding on every fetch
  // would throw away half-typed edits when the query refetches underneath.
  useEffect(() => {
    if (data && !events) {
      setEvents(data.events);
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

  const patchEvents = (p: Partial<EventPrefs>) => {
    const next = { ...events, ...p };
    setEvents(next);
    commit({ events: next });
  };
  const patchDigest = (p: Partial<DigestPrefs>) => {
    const next = { ...digest, ...p };
    setDigest(next);
    commit({ digest: next });
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
              {/* A real time input rather than an hour dropdown. "Around nine"
                  and "nine o'clock" are different promises, and the second is
                  the one people mean. */}
              <input
                type="time"
                value={`${String(digest.hour).padStart(2, "0")}:${String(digest.minute ?? 0).padStart(2, "0")}`}
                onChange={e => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m)) patchDigest({ hour: h, minute: m });
                }}
                className={SURFACE.input}
              />
              {/* Said where the time is chosen, because the checking interval is
                  not something anybody can infer from a time field. */}
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                Checked every five minutes, so it arrives within five minutes of this.
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                Timezone
              </label>
              <input value={digest.timeZone} onChange={e => setDigest({ ...digest, timeZone: e.target.value })}
                onBlur={() => patchDigest({ timeZone: digest.timeZone })}
                placeholder="America/New_York" className={SURFACE.input} />
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
              />
            ))}
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
              Age is time since the last commit, so something touched this morning is never
              old however long ago it was opened.
            </p>
          </div>

          {/* Otherwise the only evidence a summary went out is having received
              it, and its absence is indistinguishable from it being broken. */}
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-3">
            {data.lastDigestAt
              ? <>Last summary sent {new Date(data.lastDigestAt).toLocaleString()}. One per day,
                  so the next is tomorrow at this time. Changing the time above sends today's
                  at the new one.</>
              : <>No summary has been sent yet.</>}
          </p>

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
