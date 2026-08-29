import { useState } from "react";

/**
 * How to get a Teams webhook, for people who have never made one.
 *
 * Behind a disclosure rather than printed inline: it is eight steps somebody
 * reads once and never again, and leaving it open turns a one-field form into a
 * page of instructions. Beside the field rather than in a tooltip, because a
 * tooltip cannot be read while typing into the thing it describes.
 *
 * Written for a **chat**, not a channel. Both work and the app accepts either,
 * but these notifications are addressed to a person, a daily list of what is
 * waiting on you does not belong in a team channel where everybody sees it, and
 * defaulting people into that is how a useful message becomes an annoying one.
 */
export default function TeamsSetupHelp({ scope = "chat" }: {
  /**
   * A chat is somebody's own notifications; a channel is a group's. The steps
   * differ only in where the workflow is created, but which one is right is
   * decided by who the message is for.
   */
  scope?: "chat" | "channel";
}) {
  const [open, setOpen] = useState(false);
  const chat = scope === "chat";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[12px] font-semibold
                   text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white
                   transition-colors"
      >
        <span className="w-[17px] h-[17px] rounded-full grid place-items-center text-[11px] font-black
                         border border-current leading-none">i</span>
        Where do I get this?
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-slate-200 dark:border-white/10
                        bg-slate-50/70 dark:bg-white/[0.03] p-4">
          <p className="text-[12.5px] text-slate-600 dark:text-slate-300 leading-relaxed">
            Teams retired the old “Incoming Webhook” connector. The replacement is a
            <span className="font-semibold"> Workflow</span>, which you create once and
            it gives you a URL to paste here.
          </p>

          <ol className="mt-3 grid gap-2.5">
            {(chat
              ? [
                  <>Open Teams and go to <span className="font-semibold">Chat</span> in the left rail.</>,
                  <>Open the chat you want the messages in. To keep them private, search your
                    own name and pick yourself, Teams lets you message yourself, and that chat
                    is visible to nobody else.</>,
                  <>Click the <span className="font-semibold">⋯</span> at the top of the chat,
                    then <span className="font-semibold">Workflows</span>.</>,
                  <>Choose the template <span className="font-semibold">“Post to a chat when a
                    webhook request is received”</span>. If you do not see it, search
                    “webhook” in the template list.</>,
                  <>Click <span className="font-semibold">Next</span>. Teams shows which account
                    the workflow will run as, that is you, and it is what posts the messages.</>,
                  <>Pick the chat from the dropdown, then click
                    <span className="font-semibold"> Add workflow</span>.</>,
                  <>Copy the <span className="font-semibold">URL</span> it shows you. This is the
                    only time it is shown in full.</>,
                  <>Paste it into the field here and save.</>,
                ]
              : [
                  <>Open Teams and go to <span className="font-semibold">Teams</span> in the left rail.</>,
                  <>Find the channel these notifications should go to.</>,
                  <>Click the <span className="font-semibold">⋯</span> next to the channel name,
                    then <span className="font-semibold">Workflows</span>.</>,
                  <>Choose <span className="font-semibold">“Post to a channel when a webhook
                    request is received”</span>.</>,
                  <>Click <span className="font-semibold">Next</span> and confirm the account the
                    workflow runs as.</>,
                  <>Pick the team and channel, then
                    <span className="font-semibold"> Add workflow</span>.</>,
                  <>Copy the <span className="font-semibold">URL</span>. This is the only time it
                    is shown in full.</>,
                  <>Paste it here and save.</>,
                ]
            ).map((step, i) => (
              <li key={i} className="flex gap-3 text-[12.5px] text-slate-600 dark:text-slate-300 leading-relaxed">
                <span className="shrink-0 w-5 h-5 rounded-full grid place-items-center text-[10.5px] font-bold
                                 bg-slate-900 dark:bg-white text-white dark:text-slate-900 tabular-nums">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/10 grid gap-1.5">
            <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
              The URL looks like{" "}
              <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-slate-200/70 dark:bg-white/[0.08]">
                https://prod-<span className="opacity-60">NN</span>.<span className="opacity-60">region</span>.logic.azure.com/workflows/…
              </code>
            </p>
            {/* The two things that actually go wrong, rather than a general
                troubleshooting section nobody reads. */}
            <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
              If <span className="font-semibold">Workflows</span> is missing from the menu, your
              organization has restricted Power Automate, an admin has to allow it. If the URL is
              rejected here, check you copied the whole thing, including everything after the
              question mark.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
