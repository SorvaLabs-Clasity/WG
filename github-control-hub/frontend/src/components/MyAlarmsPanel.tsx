import { useState } from "react";
import {
  useMyAlarms, useDeleteMyAlarm, useMyDestination,
  useAddMyEmail, useRemoveMyEmail, useAddMyTeams, useRemoveMyTeams, useSetMyTimeZone,
} from "../hooks/useAlarms";
import { useWidgets } from "../hooks/useWidgets";
import AlarmModal from "./AlarmModal";
import { Button, Empty, Note, Spinner, SURFACE, TYPE } from "../design";
import { allZones, zoneLabel } from "../lib/zones";
import type { WidgetAlarm } from "../api/alarms";

/**
 * Somebody's own alarms, and the one place their addresses are kept.
 *
 * Two panels rather than a destination on each alarm: four alarms with four
 * copies of the same address is four things to change when somebody's email
 * changes, and three of them get forgotten. The alarms say what they watch; the
 * panel below says where every one of them lands.
 *
 * Nothing here is an organization setting. These alarms watch cards only their
 * owner can see and are delivered to addresses only they chose, which is why
 * they do not appear in the shared Alarms tab and why an administrator cannot
 * read them.
 */
export default function MyAlarmsPanel() {
  const { data: alarms, isLoading } = useMyAlarms();
  const { data: widgets } = useWidgets("personal");
  const remove = useDeleteMyAlarm();

  const [editing, setEditing] = useState<{ widgetId: string; alarm?: WidgetAlarm } | null>(null);
  const [adding, setAdding] = useState(false);

  const cards = widgets ?? [];
  const list = alarms ?? [];
  const titleOf = (id: string) => cards.find(w => w.id === id)?.title;

  if (isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>;

  return (
    <div className="grid gap-5">
      <section>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-[12.5px] text-slate-500 dark:text-slate-400 max-w-[70ch]">
            Alarms on your own cards. Only you can see them, and they go to the
            addresses below rather than to an organization group.
          </p>
          {cards.length > 0 && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <i className="ph-bold ph-plus mr-1.5 text-[12px]" />Add an alarm
            </Button>
          )}
        </div>

        {cards.length === 0 ? (
          <Empty
            title="No cards to watch yet"
            body="An alarm watches one of your own cards. Add a card under My widgets first, then come back and set a threshold on it."
          />
        ) : list.length === 0 ? (
          <Empty
            title="No alarms yet"
            body="Pick one of your cards and a number that matters to you. Nobody else is told, and nobody else has to agree that the number is the right one."
            action={<Button variant="primary" onClick={() => setAdding(true)}>Add your first alarm</Button>}
          />
        ) : (
          <div className="grid gap-2.5">
            {list.map(a => (
              <AlarmRow key={a.id} alarm={a} widgetTitle={titleOf(a.widgetId)}
                onEdit={() => setEditing({ widgetId: a.widgetId, alarm: a })}
                onRemove={() => {
                  if (confirm(`Delete "${a.name}"? You will stop being told about it.`)) {
                    remove.mutate(a.id);
                  }
                }} />
            ))}
          </div>
        )}
      </section>

      <Destination />

      {(adding || editing) && (
        <AlarmModal
          isOpen
          personal
          widgetId={editing?.widgetId ?? cards[0]?.id ?? ""}
          existing={editing?.alarm ?? null}
          onClose={() => { setAdding(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function AlarmRow({ alarm, widgetTitle, onEdit, onRemove }: {
  alarm: WidgetAlarm; widgetTitle?: string; onEdit: () => void; onRemove: () => void;
}) {
  const firing = alarm.state === "ALARM";
  return (
    <div className={`${SURFACE.card} px-4 py-3 flex items-center gap-3`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${
        !alarm.enabled ? "bg-slate-300 dark:bg-paper-3"
          : firing ? "bg-rose-500" : "bg-emerald-500"}`}
        title={!alarm.enabled ? "Paused" : firing ? "Firing" : "Clear"} />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-slate-900 dark:text-ink truncate">
            {alarm.name}
          </span>
          {!alarm.enabled && (
            <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>paused</span>
          )}
        </div>
        <p className="text-[11.5px] text-slate-400 dark:text-slate-500 truncate mt-0.5">
          {/* Named rather than an id: the card is the thing they recognise, and
              a deleted one is worth saying out loud, because the alarm goes on
              existing and never fires again. */}
          {widgetTitle ?? "a card that no longer exists"}
          {alarm.intervalMinutes ? ` · checked every ${alarm.intervalMinutes} min` : ""}
          {alarm.lastError ? ` · ${alarm.lastError}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <button type="button" onClick={onEdit} title="Edit" aria-label={`Edit ${alarm.name}`}
          className="w-7 h-7 rounded-lg grid place-items-center text-slate-400
                     hover:text-slate-900 dark:hover:text-ink
                     hover:bg-slate-100 dark:hover:bg-ink/[0.08] transition-colors">
          <i className="ph-bold ph-pencil-simple text-[12.5px]" aria-hidden="true" />
        </button>
        <button type="button" onClick={onRemove} title="Delete" aria-label={`Delete ${alarm.name}`}
          className="w-7 h-7 rounded-lg grid place-items-center text-slate-400
                     hover:text-rose-600 dark:hover:text-rose-400
                     hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors">
          <i className="ph-bold ph-trash text-[12.5px]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Where every one of this person's alarms is delivered. */
function Destination() {
  const { data } = useMyDestination();
  const addEmail = useAddMyEmail();
  const removeEmail = useRemoveMyEmail();
  const addTeams = useAddMyTeams();
  const removeTeams = useRemoveMyTeams();
  const setZone = useSetMyTimeZone();

  const [email, setEmail] = useState("");
  const [teams, setTeams] = useState("");
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<unknown>, clear: () => void) => {
    setError("");
    try { await fn(); clear(); }
    catch (e) { setError((e as Error).message); }
  };

  const emails = data?.emails ?? [];

  return (
    <section className={`${SURFACE.card} overflow-hidden`}>
      <div className="px-5 pt-4">
        <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-ink">
          Where your alarms go
        </h3>
        <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5 max-w-[75ch]">
          One list for all of them. Only you receive these, and only you can see
          this list.
        </p>
        <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3" />
      </div>

      <div className="p-5 grid gap-5">
        <div>
          <p className={`${TYPE.label} text-slate-400 dark:text-slate-500 mb-2`}>Email</p>
          {emails.length > 0 && (
            <div className="grid gap-1.5 mb-2.5">
              {emails.map(m => (
                <div key={m.endpoint}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg
                             bg-slate-50 dark:bg-ink/[0.04] min-w-0">
                  <i className={`ph-bold text-[12px] shrink-0 ${
                    m.confirmed ? "ph-check-circle text-emerald-500" : "ph-clock text-amber-500"}`}
                    aria-hidden="true" />
                  <span className="font-mono text-[12.5px] text-slate-700 dark:text-slate-200 truncate"
                    title={m.endpoint}>
                    {m.endpoint}
                  </span>
                  {!m.confirmed && (
                    <span className="text-[10.5px] font-semibold text-amber-700 dark:text-amber-400 shrink-0">
                      not confirmed
                    </span>
                  )}
                  <button type="button" aria-label={`Remove ${m.endpoint}`}
                    onClick={() => run(
                      () => removeEmail.mutateAsync({ arn: m.subscriptionArn, email: m.endpoint }),
                      () => {})}
                    className="ml-auto shrink-0 w-6 h-6 rounded grid place-items-center text-slate-400
                               hover:text-rose-600 dark:hover:text-rose-400 transition-colors">
                    <i className="ph-bold ph-x text-[10px]" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com" className={SURFACE.input} />
            <Button disabled={!email.trim() || addEmail.isPending}
              onClick={() => run(() => addEmail.mutateAsync(email.trim()), () => setEmail(""))}>
              Add
            </Button>
          </div>
          {/* Said before they wait for it. AWS sends the confirmation, not this
              app, so it arrives from an address nobody recognises. */}
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
            AWS emails a confirmation link. Nothing is delivered until it is
            clicked, so an address that stays “not confirmed” is why an alarm
            went quiet.
          </p>
        </div>

        <div>
          <p className={`${TYPE.label} text-slate-400 dark:text-slate-500 mb-2`}>Microsoft Teams</p>
          {(data?.teams ?? []).length > 0 && (
            <div className="grid gap-1.5 mb-2.5">
              {(data?.teams ?? []).map(a => (
                <div key={a} className="flex items-center gap-2 px-3 py-2 rounded-lg
                                        bg-slate-50 dark:bg-ink/[0.04] min-w-0">
                  <i className="ph-bold ph-chat-teardrop-text text-[12px] text-violet-500 shrink-0"
                    aria-hidden="true" />
                  <span className="font-mono text-[12.5px] text-slate-700 dark:text-slate-200 truncate"
                    title={a}>{a}</span>
                  <button type="button" aria-label={`Remove ${a}`}
                    onClick={() => run(() => removeTeams.mutateAsync(a), () => {})}
                    className="ml-auto shrink-0 w-6 h-6 rounded grid place-items-center text-slate-400
                               hover:text-rose-600 dark:hover:text-rose-400 transition-colors">
                    <i className="ph-bold ph-x text-[10px]" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input type="email" value={teams} onChange={e => setTeams(e.target.value)}
              placeholder="your work email address" className={SURFACE.input} />
            <Button disabled={!teams.trim() || addTeams.isPending}
              onClick={() => run(() => addTeams.mutateAsync(teams.trim()), () => setTeams(""))}>
              Add
            </Button>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
            Your work email address, which is how Teams finds you. Delivery needs
            the organization's Teams workflow to be set up.
          </p>
        </div>

        <div>
          <p className={`${TYPE.label} text-slate-400 dark:text-slate-500 mb-2`}>Your timezone</p>
          <select
            value={data?.timeZone ?? ""}
            onChange={e => run(() => setZone.mutateAsync(e.target.value || null), () => {})}
            className={`${SURFACE.input} max-w-md`}
          >
            <option value="">Use the organization's timezone</option>
            {allZones().map(z => (
              <option key={z} value={z}>{zoneLabel(z)}</option>
            ))}
          </select>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
            Times in your Teams messages are written in this zone. Daylight
            saving is handled for you.
          </p>
        </div>

        {error && <Note intent="danger">{error}</Note>}
      </div>
    </section>
  );
}
