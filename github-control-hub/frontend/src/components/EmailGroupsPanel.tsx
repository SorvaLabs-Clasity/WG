import { useState } from "react";
import {
  useEmailGroups, useCreateGroup, useDeleteGroup,
  useAddGroupMember, useRemoveGroupMember, useTestGroup,
} from "../hooks/useAlarms";

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";
const cardClass =
  "bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5";

/**
 * Email groups, and the only place they can be created.
 *
 * Kept to this one page on purpose. A group is an SNS topic, and creating one
 * from two screens invites two half-remembered sets of recipients — the
 * Security tab chooses among these, it does not make them.
 *
 * Membership is read back from SNS rather than from our own table, so an
 * address that never clicked its confirmation link shows as pending. It
 * receives nothing, and listing it as a member would make a silently
 * undelivered alarm look delivered.
 */
export default function EmailGroupsPanel() {
  const { data: groups, isLoading } = useEmailGroups(true);
  const createGroup = useCreateGroup();
  const deleteGroup = useDeleteGroup();
  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();
  const testGroup = useTestGroup();

  const [newGroup, setNewGroup] = useState("");
  const [emailFor, setEmailFor] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function run(fn: () => Promise<any>, ok?: string) {
    setError(""); setNotice("");
    try {
      const res: any = await fn();
      setNotice(ok ?? res?.message ?? "Done");
    } catch (err: any) {
      setError(err?.message || "That did not work.");
    }
  }

  return (
    <div className="space-y-4">
      {(notice || error) && (
        <div className={`rounded-md px-4 py-3 text-sm ${error
          ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
          : "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"}`}>
          {error || notice}
        </div>
      )}

      <div className={cardClass}>
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Email groups</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-400">
          Each group is an AWS SNS topic. Everyone you add gets a one-time confirmation email from
          AWS and receives nothing until they click it.
        </p>

        <div className="mt-4 flex gap-2">
          <input value={newGroup} onChange={e => setNewGroup(e.target.value)}
            placeholder="Group name, e.g. Security on-call" className={inputClass} />
          <button
            onClick={() => run(async () => { await createGroup.mutateAsync(newGroup); setNewGroup(""); }, "Group created")}
            disabled={!newGroup.trim() || createGroup.isPending}
            className="shrink-0 px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-50">
            Add group
          </button>
        </div>

        {isLoading && <p className="mt-4 text-sm text-gray-500 dark:text-slate-400">Loading…</p>}
        {!isLoading && (groups ?? []).length === 0 && (
          <p className="mt-4 text-sm text-gray-500 dark:text-slate-400">
            No groups yet. An alarm needs one before it can tell anybody.
          </p>
        )}

        <div className="mt-4 space-y-4">
          {(groups ?? []).map(g => (
            <div key={g.id} className="rounded-md border border-gh-border dark:border-slate-700 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-gh-textBase dark:text-slate-100">{g.name}</div>
                <div className="flex gap-2">
                  <button onClick={() => run(() => testGroup.mutateAsync(g.id))}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5 text-gh-textBase dark:text-slate-200">
                    Send test
                  </button>
                  <button onClick={() => run(() => deleteGroup.mutateAsync({ id: g.id }), "Group deleted")}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                    Delete
                  </button>
                </div>
              </div>

              {g.membersError && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Could not read this group's members: {g.membersError}
                </p>
              )}

              <ul className="mt-3 space-y-1">
                {g.members.map(m => (
                  <li key={m.subscriptionArn + m.endpoint}
                    className="flex items-center justify-between text-sm text-gh-textBase dark:text-slate-300">
                    <span>
                      {m.endpoint}
                      {!m.confirmed && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">
                          pending — receives nothing yet
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => run(() => removeMember.mutateAsync({ id: g.id, subscriptionArn: m.subscriptionArn }), "Removed")}
                      className="text-xs text-gray-500 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400">
                      Remove
                    </button>
                  </li>
                ))}
                {g.members.length === 0 && !g.membersError && (
                  <li className="text-sm text-gray-500 dark:text-slate-400">Nobody yet.</li>
                )}
              </ul>

              <div className="mt-3 flex gap-2">
                <input type="email" placeholder="name@example.com" className={inputClass}
                  value={emailFor[g.id] ?? ""}
                  onChange={e => setEmailFor({ ...emailFor, [g.id]: e.target.value })} />
                <button
                  onClick={() => run(async () => {
                    const res = await addMember.mutateAsync({ id: g.id, email: emailFor[g.id] ?? "" });
                    setEmailFor({ ...emailFor, [g.id]: "" });
                    return res;
                  })}
                  disabled={!(emailFor[g.id] ?? "").trim()}
                  className="shrink-0 px-3 py-2 text-sm font-semibold rounded-md border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5 text-gh-textBase dark:text-slate-200 disabled:opacity-50">
                  Add
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
