import { useState } from "react";
import TeamsFlowPanel from "./TeamsFlowPanel";
import {
  useEmailGroups, useCreateGroup, useDeleteGroup,
  useAddGroupMember, useRemoveGroupMember, useTestGroup,
  useAddGroupTeams, useRemoveGroupTeams,
  useSetRecipientTimeZone, useSetGroupTimeZone,
  useSecuritySettings, useSaveSecuritySettings,
} from "../hooks/useAlarms";
import { Empty, Spinner, Note, Button, SURFACE, TYPE } from "../design";
import type { EmailGroup } from "../api/alarms";
import ZonePicker from "./ZonePicker";
import Truncated from "./Truncated";

/**
 * Who gets told, and by which channel.
 *
 * A group is one list of people and two ways of reaching them. The page this
 * replaces stacked those as a heading, a bulleted list of addresses, a second
 * heading, a second list, and two bare text fields, which read as one form
 * that happened to be about two things, and gave no sense of how many people
 * were actually behind a name.
 *
 * So each group leads with its reach: how many will actually receive something.
 * That number is the point of the whole screen, and it is not the number of
 * rows, an address that never confirmed its subscription receives nothing, and
 * counting it is how an alarm nobody got looks delivered.
 *
 * The two channels sit side by side as peers rather than one above the other,
 * because neither is the primary and a group with only Teams is as valid as a
 * group with only email.
 */

/** Members who will actually receive something. Pending ones will not. */
function reachOf(g: EmailGroup): { live: number; pending: number } {
  const live = g.members.filter(m => m.confirmed).length;
  return { live: live + (g.teamsRecipients ?? []).length, pending: g.members.length - live };
}

function ChannelHeader({ icon, label, count, tone }: {
  icon: string; label: string; count: number; tone: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <i className={`${icon} text-[14px] ${tone}`} aria-hidden="true" />
      <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span className="ml-auto text-[11px] tabular-nums text-slate-300 dark:text-slate-600">{count}</span>
    </div>
  );
}

/** One field and one button, the same shape for both channels. */
function AddRow({ value, onChange, onAdd, placeholder, type, busy }: {
  value: string; onChange: (v: string) => void; onAdd: () => void;
  placeholder: string; type: "email" | "url"; busy?: boolean;
}) {
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (value.trim()) onAdd(); }}
      className="flex gap-2 mt-2.5"
    >
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${SURFACE.input} text-[13px] py-2`}
      />
      <button
        type="submit" disabled={!value.trim() || busy}
        className="shrink-0 w-9 h-9 grid place-items-center rounded-xl
                   bg-slate-900 dark:bg-white text-white dark:text-slate-900
                   hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
        title="Add"
      >
        <i className="ph-bold ph-plus text-[13px]" aria-hidden="true" />
      </button>
    </form>
  );
}

function GroupCard({ group, orgZone, onNotice, onError }: {
  group: EmailGroup;
  /** The organization's zone, so a row can name what it falls back to. */
  orgZone: string;
  onNotice: (s: string) => void; onError: (s: string) => void;
}) {
  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();
  const addTeams = useAddGroupTeams();
  const removeTeams = useRemoveGroupTeams();
  const deleteGroup = useDeleteGroup();
  const testGroup = useTestGroup();

  const [email, setEmail] = useState("");
  const [hook, setHook] = useState("");

  const reach = reachOf(group);
  const setPersonZone = useSetRecipientTimeZone();
  const setGroupZone = useSetGroupTimeZone();
  const teams = group.teamsRecipients ?? [];

  const run = async (fn: () => Promise<any>, ok?: string) => {
    onError(""); onNotice("");
    try {
      await fn();
      if (ok) onNotice(ok);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section className={`${SURFACE.card} overflow-hidden`}>
      <div className="px-5 pt-4 pb-3.5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-bold tracking-tight text-slate-900 dark:text-white truncate">
            {group.name}
          </h3>
          {/* The number that matters is who will actually receive something,
              which is not the number of rows below it. */}
          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
            {reach.live === 0
              ? <span className="text-amber-700 dark:text-amber-500">reaches nobody yet</span>
              : <>reaches <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {reach.live}</span> {reach.live === 1 ? "recipient" : "recipients"}</>}
            {reach.pending > 0 && (
              <span className="text-amber-700 dark:text-amber-500">
                {" "}· {reach.pending} not confirmed
              </span>
            )}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-1">
          <button
            onClick={() => run(() => testGroup.mutateAsync(group.id), `Test sent to "${group.name}".`)}
            disabled={reach.live === 0 || testGroup.isPending}
            title={reach.live === 0 ? "Nobody would receive it" : "Send a test to everyone in this group"}
            className="px-3 h-8 rounded-lg text-[12px] font-bold text-slate-600 dark:text-slate-300
                       hover:bg-slate-100 dark:hover:bg-white/[0.08] disabled:opacity-30 transition-colors"
          >
            {testGroup.isPending ? "Sending…" : "Test"}
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete "${group.name}"? Any alarm using it stops notifying anyone.`)) {
                run(() => deleteGroup.mutateAsync({ id: group.id }));
              }
            }}
            title="Delete group"
            className="w-8 h-8 grid place-items-center rounded-lg text-slate-400
                       hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
          >
            <i className="ph-bold ph-trash text-[13px]" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="h-px bg-slate-200/70 dark:bg-white/[0.07]" />

      {/* Two channels as peers. Neither is the primary, a group with only
          Teams is as valid as one with only email. */}
      <div className="grid md:grid-cols-2 gap-px bg-slate-200/70 dark:bg-white/[0.07]">
        {/* min-w-0 on the column, not only on the text inside it.
            `grid-cols-2` is minmax(auto, 1fr), and that `auto` minimum sizes a
            column to its content: one long unbroken address grew the column
            past its share and pushed the card out, which no amount of
            truncating inside it could prevent. */}
        <div className="bg-white dark:bg-[#151a23] p-5 min-w-0">
          <ChannelHeader icon="ph-fill ph-envelope-simple" label="Email"
            count={group.members.length} tone="text-sky-500" />

          {/* The zone this group's email leads with. Everybody's own zone is
              still named in the message: one SNS publish hands every subscriber
              the same body, so rather than picking one person's clock and being
              wrong for the rest, it carries them all. */}
          <div className="flex items-center gap-2 mb-2.5 pb-2.5 border-b border-slate-100 dark:border-white/[0.06]">
            <span className="text-[11.5px] text-slate-400 dark:text-slate-500 shrink-0">
              Times lead with
            </span>
            <ZonePicker
              value={group.timeZone}
              inheritZone={orgZone}
              onChange={zone => run(() => setGroupZone.mutateAsync({ id: group.id, timeZone: zone }))}
            />
            <span className="text-[11px] text-slate-300 dark:text-slate-600 truncate">
              others shown too
            </span>
          </div>

          {group.membersError ? (
            // Not the same as having none, and the difference decides whether
            // somebody adds an address that is already there.
            <p className="text-[12px] text-amber-700 dark:text-amber-500">
              Could not read the list: {group.membersError}
            </p>
          ) : group.members.length === 0 ? (
            <p className="text-[12.5px] text-slate-400 dark:text-slate-500">Nobody yet.</p>
          ) : (
            <ul className="grid gap-1">
              {group.members.map(m => (
                <li key={m.subscriptionArn}
                  className="group/row flex items-center gap-2 py-1 text-[12.5px]">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    m.confirmed ? "bg-emerald-500" : "bg-amber-400"}`} aria-hidden="true" />
                  {/* Clipped to the column, and readable in full on hover.
                      `truncate` alone did nothing: a flex item will not shrink
                      below its content without min-w-0, so one long address
                      grew the row and pushed the picker and the X off it. */}
                  <Truncated text={m.endpoint} className="text-slate-700 dark:text-slate-200" />
                  {!m.confirmed && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide
                                     text-amber-700 dark:text-amber-500">pending</span>
                  )}
                  {/* Their own zone, the same control as the Teams column.
                      One email cannot be written in two clocks, so it is
                      written in all of them and each person finds their own. */}
                  <ZonePicker
                    value={group.recipientZones?.[m.endpoint]}
                    inheritZone={group.timeZone || orgZone}
                    onChange={zone => run(() => setPersonZone.mutateAsync({
                      id: group.id, address: m.endpoint, timeZone: zone,
                    }))}
                    className="shrink-0"
                  />
                  <button
                    // The address goes too. An unconfirmed subscription has no
                    // ARN, so "PendingConfirmation" names everybody waiting
                    // rather than this one person.
                    onClick={() => run(() => removeMember.mutateAsync(
                      { id: group.id, subscriptionArn: m.subscriptionArn, email: m.endpoint }))}
                    title={m.confirmed ? "Remove" : "Cancel this invitation"}
                    className="shrink-0 w-6 h-6 grid place-items-center rounded-md text-slate-300 dark:text-slate-600
                               opacity-0 group-hover/row:opacity-100 focus:opacity-100
                               hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-all"
                  >
                    <i className="ph-bold ph-x text-[11px]" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <AddRow
            type="email" value={email} onChange={setEmail} busy={addMember.isPending}
            placeholder="name@example.com"
            onAdd={() => run(async () => {
              await addMember.mutateAsync({ id: group.id, email: email.trim() });
              setEmail("");
            }, "Added. They must confirm the subscription email before anything reaches them.")}
          />
          {/* Said where it is relevant rather than as a footnote: an address
              that never confirms receives nothing, silently. */}
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
            AWS sends a confirmation link. Until it is clicked, nothing arrives.
          </p>
        </div>

        <div className="bg-white dark:bg-[#151a23] p-5 min-w-0">
          <ChannelHeader icon="ph-fill ph-chat-teardrop-text" label="Microsoft Teams"
            count={teams.length} tone="text-violet-500" />

          {/* The counterpart to the email column's line, and it sits in the same
              place for the same reason: the two columns take the same setting
              and do different things with it, and that asymmetry is worth one
              sentence each rather than being left for somebody to discover. */}
          <div className="flex items-center gap-2 mb-2.5 pb-2.5 border-b border-slate-100 dark:border-white/[0.06]">
            <span className="text-[11.5px] text-slate-400 dark:text-slate-500">
              Each message uses its own recipient's zone
            </span>
          </div>

          {teams.length === 0 ? (
            <p className="text-[12.5px] text-slate-400 dark:text-slate-500">Nobody yet.</p>
          ) : (
            <ul className="grid gap-1">
              {/* Names, not "Channel 1". A group is a list of people, and the
                  destination now travels with each message rather than being
                  frozen into a pipe somebody had to build first. */}
              {teams.map(address => (
                <li key={address} className="group/row flex items-center gap-2 py-1 text-[12.5px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" aria-hidden="true" />
                  <Truncated text={address} className="text-slate-700 dark:text-slate-200" />
                  {/* Per person, because Teams is delivered per person: the
                      flow is called once per address, so each call can carry
                      that person's own rendering of the time. */}
                  <ZonePicker
                    value={group.recipientZones?.[address]}
                    inheritZone={group.timeZone || orgZone}
                    onChange={zone => run(() => setPersonZone.mutateAsync({
                      id: group.id, address, timeZone: zone,
                    }))}
                    className="shrink-0"
                  />
                  <button
                    onClick={() => run(() => removeTeams.mutateAsync({ id: group.id, address }))}
                    title="Remove"
                    className="shrink-0 w-6 h-6 grid place-items-center rounded-md text-slate-300 dark:text-slate-600
                               opacity-0 group-hover/row:opacity-100 focus:opacity-100
                               hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-all"
                  >
                    <i className="ph-bold ph-x text-[11px]" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <AddRow
            type="email" value={hook} onChange={setHook} busy={addTeams.isPending}
            placeholder="Their work email"
            onAdd={() => run(async () => {
              await addTeams.mutateAsync({ id: group.id, address: hook.trim() });
              setHook("");
            }, "Added. They will be sent a direct message in Teams.")}
          />
        </div>
      </div>
    </section>
  );
}

export default function EmailGroupsPanel() {
  const { data: groups, isLoading } = useEmailGroups(true);
  const createGroup = useCreateGroup();

  const [newGroup, setNewGroup] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // The organization's default zone. It is the same value the Security tab
  // writes, not a second one: two org defaults that could disagree is worse
  // than one in a place somebody has to go looking for.
  const { data: security } = useSecuritySettings(true);
  const saveSecurity = useSaveSecuritySettings();
  // The bottom of the chain. Never blank, because "what time will this say" has
  // to have an answer even when nobody has chosen one.
  const orgZone = security?.timezone || "UTC";

  if (isLoading) return <div className="py-20 flex justify-center"><Spinner /></div>;

  const list = groups ?? [];

  return (
    <div className="grid gap-4">
      {/* Above the groups, because nothing below it delivers to Teams until
          this is set, and a screen full of Teams fields over a missing pipe is
          how somebody adds twelve addresses that receive nothing. */}
      <TeamsFlowPanel />

      {/* The bottom of the fallback chain, and the only part of it that is not
          on a row somewhere below. A person's zone, then their group's, then
          this. Somebody added to a group with no zone of their own reads times
          in whatever this says. */}
      <div className={`${SURFACE.card} px-5 py-4`}>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
              Default timezone
            </h3>
            <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
              Used for anybody, and any group, that has not chosen one.
            </p>
          </div>
          <div className="ml-auto shrink-0">
            <ZonePicker
              value={security?.timezone && security.timezone !== "UTC" ? security.timezone : undefined}
              inheritZone="UTC"
              onChange={zone => {
                setError(""); setNotice("");
                saveSecurity.mutateAsync({ timezone: zone || "UTC" })
                  .then(() => setNotice("Default timezone saved."))
                  .catch((e: any) => setError(e?.message || "Could not save that."));
              }}
            />
          </div>
        </div>
      </div>

      <div className={`${SURFACE.card} px-5 py-4`}>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <label className={`${TYPE.label} block text-slate-400 dark:text-slate-500 mb-1.5`}>
              New group
            </label>
            <form
              onSubmit={e => {
                e.preventDefault();
                if (!newGroup.trim()) return;
                setError(""); setNotice("");
                createGroup.mutateAsync(newGroup.trim())
                  .then(() => { setNewGroup(""); setNotice("Group created."); })
                  .catch(err => setError((err as Error).message));
              }}
              className="flex gap-2"
            >
              <input
                value={newGroup} onChange={e => setNewGroup(e.target.value)}
                placeholder="e.g. Security on-call"
                className={SURFACE.input}
              />
              <Button variant="primary" type="submit" disabled={!newGroup.trim() || createGroup.isPending}>
                {createGroup.isPending ? "Creating…" : "Create"}
              </Button>
            </form>
          </div>
          <p className="text-[12px] text-slate-400 dark:text-slate-500 flex-1 min-w-[240px] pb-2.5">
            A group is a list of people an alarm tells. Anything that notifies a group,
            alarms, important events, pull request reminders, reaches every channel on it.
          </p>
        </div>
      </div>

      {error && <Note intent="danger">{error}</Note>}
      {notice && <Note intent="good">{notice}</Note>}

      {list.length === 0 ? (
        <Empty
          title="No groups yet"
          body="Create one above, then add the people who should hear about it, by email, in Teams, or both."
        />
      ) : (
        <div className="grid gap-4">
          {list.map(g => (
            <GroupCard key={g.id} group={g} orgZone={orgZone}
              onNotice={setNotice} onError={setError} />
          ))}
        </div>
      )}
    </div>
  );
}
