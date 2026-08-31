import { Button } from "../design";
import { confirmRebuild } from "../lib/confirmRebuild";
import { useGraphAggregation, useTriggerAggregation } from "../hooks/useGraph";

/**
 * The one Full GitHub recrawl button, used on Access and on Overview. Shared
 * so the same action cannot behave differently depending on which tab you are
 * standing on.
 *
 * Three things come from the server rather than local state, because a recrawl
 * is an organization-wide event and has to read as one: whether a walk is
 * running, including the nightly one; whether another may be started, at most
 * one an hour across the organization; and how long is left, so a refusal is a
 * number rather than a shrug.
 *
 * `dense` is for a toolbar, where a paragraph of explanation would set the
 * row's height and push the other buttons around. The same words stay
 * reachable on hover and focus, out of the flow.
 */
export default function RecrawlButton({ className = "", dense = false }: {
  className?: string; dense?: boolean;
}) {
  const { data: status } = useGraphAggregation();
  const trigger = useTriggerAggregation();

  const recrawl = status?.recrawl;
  const edgeCount = status?.aggregation?.edgeCount;

  // `trigger.isPending` still matters for the moment between the click and the
  // server admitting it started: the polled state has not caught up yet, and a
  // button that does nothing visible for ten seconds reads as broken.
  const running = recrawl?.running || trigger.isPending;
  const blocked = !running && recrawl?.allowed === false;

  // Shorter in a toolbar, where the button sits beside others and a sentence
  // for a label is what makes a row start wrapping.
  const label = running
    ? dense ? "Recrawling…" : "Recrawling, this takes a few minutes…"
    : blocked
      ? dense ? `Recrawl in ${recrawl!.waitMinutes} min` : `Recrawl available in ${recrawl!.waitMinutes} min`
      : dense ? "Full recrawl" : "Full GitHub recrawl";

  // Shown, not put in a tooltip. The reason a button is disabled has to be
  // readable before pressing it, and a disabled button does not reliably raise
  // the hover events a `title` needs anyway.
  const why = running
    ? recrawl?.startedBy
      ? `Started by ${recrawl.startedBy}. Everyone sees this while it runs.`
      : "Everyone sees this while it runs."
    : blocked
      ? `Last recrawled ${recrawl!.minutesSinceLast} min ago. At most one an hour `
        + `across the organization, counting the nightly one at 10pm Eastern.`
      : null;

  const note = trigger.isError
    ? (trigger.error as any)?.message || "Could not start a recrawl."
    : why;
  const noteIsError = trigger.isError;

  return (
    <div className={`${dense ? "relative group" : ""} ${className}`}>
      <Button
        /* Not the same shape as the refresh button people see elsewhere. That
           re-reads a stored answer; this re-reads the organization. */
        variant="caution"
        disabled={running || blocked}
        onClick={() => { if (confirmRebuild(edgeCount)) trigger.mutate(); }}
      >
        {label}
      </Button>

      {/* The server's own words when it refuses, which carry the numbers.
          Preferred over `why` because a refusal that arrived from the server is
          about this click, while `why` is about the state generally. */}
      {note && (dense ? (
        // Taken out of the flow entirely, so nothing here can resize the row
        // it sits in. The countdown itself is already on the button, which is
        // the part somebody needs without hovering.
        <div className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 w-[46ch] max-w-[80vw]
                        opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <p className={`rounded-lg px-2.5 py-2 text-[12px] leading-snug shadow-lg ring-1
                         bg-white dark:bg-slate-900 ring-slate-200 dark:ring-white/10 ${
            noteIsError
              ? "text-amber-700 dark:text-amber-300"
              : "text-slate-600 dark:text-slate-300"}`}>
            {note}
          </p>
        </div>
      ) : (
        <p className={`mt-1.5 text-[12px] max-w-[44ch] ${
          noteIsError
            ? "text-amber-700 dark:text-amber-300"
            : "text-slate-500 dark:text-slate-400"}`}>
          {note}
        </p>
      ))}
    </div>
  );
}
