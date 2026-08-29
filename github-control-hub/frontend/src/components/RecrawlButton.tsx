import { Button } from "../design";
import { confirmRebuild } from "../lib/confirmRebuild";
import { useGraphAggregation, useTriggerAggregation } from "../hooks/useGraph";

/**
 * The one Full GitHub recrawl button, used on Access and on Overview.
 *
 * There were two, written separately, and they were already drifting: the same
 * action with the same warning has to behave the same in both places or
 * somebody learns that the rules depend on which tab they are standing on.
 *
 * Three things it gets from the server rather than from local state:
 *
 * **Whether a walk is running**, anybody's walk, including the nightly one.
 * This used to be `mutation.isPending`, which lives in one component on one
 * machine: switching tabs and back cleared it, and nobody else ever saw it. A
 * recrawl is an organization-wide event and now reads as one.
 *
 * **Whether another may be started.** At most one an hour across the whole
 * organization, counted from whichever walk ran last, scheduled or manual.
 *
 * **How long is left**, so a refusal is a number rather than a shrug.
 */
export default function RecrawlButton({ className = "" }: { className?: string }) {
  const { data: status } = useGraphAggregation();
  const trigger = useTriggerAggregation();

  const recrawl = status?.recrawl;
  const edgeCount = status?.aggregation?.edgeCount;

  // `trigger.isPending` still matters for the moment between the click and the
  // server admitting it started: the polled state has not caught up yet, and a
  // button that does nothing visible for ten seconds reads as broken.
  const running = recrawl?.running || trigger.isPending;
  const blocked = !running && recrawl?.allowed === false;

  const label = running
    ? "Recrawling, this takes a few minutes…"
    : blocked
      ? `Recrawl available in ${recrawl!.waitMinutes} min`
      : "Full GitHub recrawl";

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

  return (
    <div className={className}>
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
      {trigger.isError ? (
        <p className="mt-1.5 text-[12px] text-amber-700 dark:text-amber-300 max-w-[44ch]">
          {(trigger.error as any)?.message || "Could not start a recrawl."}
        </p>
      ) : why ? (
        <p className="mt-1.5 text-[12px] text-slate-500 dark:text-slate-400 max-w-[44ch]">
          {why}
        </p>
      ) : null}
    </div>
  );
}
