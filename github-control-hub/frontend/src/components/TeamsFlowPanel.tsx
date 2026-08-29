import { useState } from "react";
import { useTeamsFlow, useSaveTeamsFlow } from "../hooks/useAlarms";
import { Note, Button, SURFACE } from "../design";

/**
 * The one Power Automate flow every Teams message goes through.
 *
 * Set once, by an administrator, and then nobody else opens Power Automate
 * again. The design this replaces asked each person to build their own flow and
 * paste their own URL: ten steps in a tool they do not otherwise use, per
 * person, with a destination that fails silently if one dropdown is wrong.
 *
 * The flow is a pipe. It reads who each message is for out of the request, so
 * one of them serves everybody, and what a person supplies is their address
 * rather than infrastructure.
 */
export default function TeamsFlowPanel() {
  const { data: flow } = useTeamsFlow();
  const save = useSaveTeamsFlow();

  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const configured = !!flow?.configured;

  const commit = async (value: string) => {
    setError("");
    try {
      await save.mutateAsync(value);
      setUrl("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className={`${SURFACE.card} overflow-hidden`}>
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <i className="ph-fill ph-chat-teardrop-text text-[15px] text-violet-500" aria-hidden="true" />
          <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
            Teams delivery
          </h3>
          <span className={`ml-auto text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded ${
            configured
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "bg-slate-100 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400"}`}>
            {configured ? "set up" : "not set up"}
          </span>
        </div>
        <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-1">
          One workflow, set up once. After this, anybody can be sent a Teams message by
          adding their address, and nobody else opens Power Automate.
        </p>
        <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
      </div>

      <div className="p-5">
        {configured ? (
          <Note intent="good">
            Teams delivery is working{flow?.setBy ? `, set up by ${flow.setBy}` : ""}
            {flow?.setAt ? ` on ${new Date(flow.setAt).toLocaleDateString()}` : ""}.
            {/* Never shown back. Anybody holding it can post as the flow, to
                anyone, which is a wider capability than any one webhook was. */}
            {" "}The URL is not shown here. Paste a new one to replace it.
          </Note>
        ) : (
          <Note intent="warn">
            Nothing can be sent to Teams until this is set up. Addresses can still be
            added to groups; they simply will not receive anything yet.
          </Note>
        )}

        <div className="flex gap-2 mt-3">
          <input
            type="url" value={url} onChange={e => setUrl(e.target.value)}
            placeholder={configured ? "Paste a new URL to replace the current one" : "Paste the workflow URL"}
            className={SURFACE.input}
          />
          <Button variant="primary" disabled={!url.trim() || save.isPending}
            onClick={() => commit(url.trim())}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {configured && (
            <Button onClick={() => {
              if (confirm("Remove it? Nobody receives Teams messages until a new one is set.")) commit("");
            }}>
              Remove
            </Button>
          )}
        </div>

        {error && <div className="mt-3"><Note intent="danger">{error}</Note></div>}

        <button
          type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="inline-flex items-center gap-1.5 mt-3 text-[12px] font-semibold
                     text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          <span className="w-[17px] h-[17px] rounded-full grid place-items-center text-[11px] font-black
                           border border-current leading-none">i</span>
          How to create it
        </button>

        {open && (
          <div className="mt-3 rounded-xl border border-slate-200 dark:border-white/10
                          bg-slate-50/70 dark:bg-white/[0.03] p-4">
            <p className="text-[12.5px] text-slate-600 dark:text-slate-300 leading-relaxed">
              You are building one workflow that can message anybody. Only one field changes:
              instead of a name typed into the flow, the Recipient reads who each message is for
              out of the request itself.
            </p>

            <ol className="mt-3 grid gap-2.5">
              {[
                <>In Teams, open any chat, click the <span className="font-semibold">⋯</span> at the
                  top, then <span className="font-semibold">Workflows</span>. Which chat does not
                  matter, the destination is set inside the flow. If the template list is short,
                  search <span className="font-semibold">webhook</span>.</>,
                <>Choose <span className="font-semibold">“Send webhook alerts to a chat”</span>.
                  When it asks for a recipient, put anyone, yourself is fine. It gets replaced in
                  step 5.</>,
                <>Click <span className="font-semibold">Add workflow</span>, then open the new flow
                  and click <span className="font-semibold">Edit</span>.</>,
                <>The template contains <span className="font-semibold">two</span> copies of the
                  posting step, one either side of an
                  <span className="font-semibold"> Attachments is null</span> condition. Configure
                  <span className="font-semibold"> both</span>: the one that runs is decided at
                  send time, and an unconfigured copy still holds a hard-coded thread id that
                  Graph rejects.</>,
                <>In each, set <span className="font-semibold">Post as</span> to
                  {" "}<span className="font-semibold">Flow bot</span> and
                  {" "}<span className="font-semibold">Post in</span> to
                  {" "}<span className="font-semibold">Chat with Flow bot</span>.</>,
                <>Clear the <span className="font-semibold">Recipient</span> field and paste this
                  expression in its place. This is the only change that matters, it is what makes
                  one flow able to message anybody:
                  <code className="block mt-1.5 font-mono text-[11px] p-2 rounded bg-slate-200/70 dark:bg-white/[0.08] overflow-x-auto">
                    triggerBody()?['recipient']
                  </code></>,
                <>Click into the empty <span className="font-semibold">Adaptive Card</span> field,
                  then pick <span className="font-semibold">Attachments Adaptive Card</span> from
                  the panel on the right, under
                  <span className="font-semibold"> When a Teams webhook request is received</span>.
                  It is the token the template provides for the card the app sends.</>,
                <>Save the flow, then copy its <span className="font-semibold">HTTP URL</span> from the
                  trigger step and paste it above.</>,
              ].map((step, i) => (
                <li key={i} className="flex gap-3 text-[12.5px] text-slate-600 dark:text-slate-300 leading-relaxed">
                  <span className="shrink-0 w-5 h-5 rounded-full grid place-items-center text-[10.5px] font-bold
                                   bg-slate-900 dark:bg-white text-white dark:text-slate-900 tabular-nums">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>

            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/10">
              {/* The failure that looks like success: Power Automate answers 202
                  before running the flow, so a wrong destination reports as sent
                  and delivers nothing. */}
              <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
                If a test says it was accepted but nothing arrives, open the flow's
                <span className="font-semibold"> Run history</span>. Power Automate accepts the
                request before it runs the flow, so a failure there cannot be seen from here.
                <span className="font-semibold"> “Call made for a thread which is not a
                ChatThread”</span> almost always means only one of the two posting steps was
                configured. If everybody's messages arrive for one person, a Recipient is still
                a name rather than the expression.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
