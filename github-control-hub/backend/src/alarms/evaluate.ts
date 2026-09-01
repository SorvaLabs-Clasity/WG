import {
  conditionsFor, intervalFor, isDue, isBreaching, metricValue, step,
  severityRank, newRows, rowsForMetric, type AlarmState,
} from "./conditions";
import { buildMessage, formatTimestamp, formatTimestampAcross } from "./message";
import type { WidgetLike, WidgetRows } from "./widgetValues";

/**
 * One pass over every alarm.
 *
 * Everything it touches is injected, so the whole decision, due, read,
 * compare, transition, send, can be driven from a test with no AWS, no
 * GitHub and no clock.
 */

export interface AlarmLike {
  id: string;
  widgetId: string;
  name: string;
  condition: any;
  groupId: string;
  subjectTemplate: string;
  bodyTemplate: string;
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  notifyOnRecovery: boolean;
  enabled: boolean;
  state: AlarmState;
  cleanStreak: number;
  lastCheckedAt?: string;
  /** For an "each" alarm: the rows it has already reported. */
  seenKeys?: string[];
}

export interface EvaluatorDeps {
  now: number;
  org: string;
  timezone?: string;
  listAlarms: () => Promise<AlarmLike[]>;
  getWidget: (id: string) => Promise<WidgetLike | undefined>;
  topicArnFor: (groupId: string) => Promise<string | undefined>;
  computeRows: (widget: WidgetLike) => Promise<WidgetRows>;
  /**
   * Send it, and say what each channel did.
   *
   * A single boolean could not tell "the email went and Teams failed" from
   * "everything went", so a broken Teams workflow left no trace anywhere: the
   * alarm recorded a successful firing and the tab had nothing to show.
   */
  publish: (topicArn: string, subject: string, body: string,
    teamsText?: { subject: string; body: string },
    renderFor?: (timeZones: string[], channel: "email" | "teams") => { subject: string; body: string },
  ) => Promise<boolean | {
    delivered: boolean; emailSent?: boolean; teamsSent?: boolean; teamsError?: string;
  }>;
  saveRuntime: (id: string, runtime: {
    state: AlarmState; cleanStreak: number; lastCheckedAt: string;
    lastValue?: number | null; lastFiredAt?: string; lastError?: string;
    /** A channel that was expected and did not arrive. Cleared on a clean send. */
    lastDeliveryError?: string;
    /**
     * What an "each" alarm should remember, when nothing was sent.
     *
     * A pass where a row cleared and recovery messages are switched off sends
     * nothing, so it never reaches the claim — and without writing the set
     * here, that row stays remembered for ever and its return is never
     * reported.
     */
    seenKeys?: string[];
  }) => Promise<void>;
  /**
   * Move this alarm from one state to another, and say whether this caller is
   * the one that did it.
   *
   * The seam that makes a notification happen once per transition rather than
   * once per evaluation, so an overrunning pass, or anything else that
   * evaluates on a data change, cannot produce a second message about one
   * event. Omitted by tests that are not about that.
   */
  claimTransition?: (id: string, from: AlarmState, to: AlarmState, at: string) => Promise<boolean>;
  /**
   * Record the rows an "each" alarm has reported, and say whether this caller
   * won the write. The equivalent of `claimTransition` for the kind of alarm
   * whose news is the set of rows rather than the state.
   */
  claimSeen?: (id: string, from: string[] | undefined, to: string[], at: string) => Promise<boolean>;
  /**
   * Evaluate now, whatever each alarm's interval says.
   *
   * For a pass triggered by the data changing rather than by a clock. The
   * interval answers "how often is this worth looking at", and something has
   * just answered it: the reading these alarms are made of was rewritten a
   * moment ago. Without this, a sweep landing two minutes after a tick would
   * evaluate nothing, which is the whole point of the trigger.
   *
   * Absent means the ordinary scheduled behaviour.
   */
  ignoreInterval?: boolean;
}

export interface EvaluationSummary {
  considered: number;
  evaluated: number;
  skippedNotDue: number;
  fired: number;
  recovered: number;
  unreadable: number;
  publishFailures: number;
  /** Fired, and the Teams half did not arrive. */
  teamsFailures?: number;
  /**
   * Transitions another evaluator had already claimed.
   *
   * Normally zero. Anything else means two passes overlapped, which is worth
   * seeing in the log rather than inferring from an absence of duplicate
   * emails nobody was going to notice.
   */
  duplicatesAvoided: number;
}

function thresholdText(condition: any): string {
  if (condition?.kind === "severity") return String(condition.atLeast);
  // An "each" condition has no limit, and `String(undefined)` put the word
  // "undefined" in the message where a number belonged. Alarms written before
  // the wording below existed still carry the count template, so this has to
  // read sensibly inside "your limit is …" rather than be left empty.
  if (condition?.kind === "each") return "any";
  return String(condition?.threshold);
}

function metricLabel(widget: WidgetLike, condition: any): string {
  // Both keys, for the same reason the validator needs both: one metric is
  // offered twice and matching on the name alone labels the message with
  // whichever reading happened to be declared first.
  const spec = conditionsFor(widget)
    .find(s => s.metric === condition?.metric && s.kind === condition?.kind)
    ?? conditionsFor(widget).find(s => s.metric === condition?.metric);
  return spec?.label ?? String(condition?.metric ?? "value");
}

/** A severity metric's reading is a rank; the email should say the word. */
function displayValue(condition: any, value: number | null): string {
  if (value === null) return "";
  if (condition?.kind !== "severity") return String(value);
  const name = (["", "low", "medium", "high", "critical"] as const)[value];
  return name || String(value);
}

/** What a row is about, for a message that has to name it. */
function subjectOf(row: any): string {
  return String(row?.repo ?? row?.user ?? row?.team ?? row?.resourceId ?? "");
}

export async function evaluateAlarms(deps: EvaluatorDeps): Promise<EvaluationSummary> {
  const summary: EvaluationSummary = {
    considered: 0, evaluated: 0, skippedNotDue: 0,
    fired: 0, recovered: 0, unreadable: 0, publishFailures: 0, duplicatesAvoided: 0,
  };

  const alarms = await deps.listAlarms();
  const nowIso = new Date(deps.now).toISOString();

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    summary.considered++;

    const widget = await deps.getWidget(alarm.widgetId);
    if (!widget) {
      // The widget was deleted and the alarm outlived it. Recorded so the UI
      // can say so, and deliberately not fired, an alarm about nothing is
      // not an emergency.
      summary.unreadable++;
      await deps.saveRuntime(alarm.id, {
        state: alarm.state, cleanStreak: alarm.cleanStreak, lastCheckedAt: nowIso,
        lastError: "The widget this alarm watches no longer exists",
      });
      continue;
    }

    if (!deps.ignoreInterval && !isDue(alarm.lastCheckedAt, intervalFor(widget), deps.now)) {
      summary.skippedNotDue++;
      continue;
    }

    summary.evaluated++;
    const { rows, error } = await deps.computeRows(widget);
    const value = metricValue(alarm.condition?.metric, rows);

    // A reading that could not be taken is not a clean check.
    //
    // Letting it fall through would advance the recovery streak, so two
    // consecutive GitHub failures would resolve a genuinely firing alarm and
    // send an all-clear about a value nobody looked at. The state machine is
    // left exactly as it was and only the error is recorded.
    if (value === null) {
      summary.unreadable++;
      await deps.saveRuntime(alarm.id, {
        state: alarm.state, cleanStreak: alarm.cleanStreak, lastCheckedAt: nowIso,
        lastValue: null, lastError: error || "No reading",
      });
      continue;
    }

    const breaching = isBreaching(alarm.condition, value);
    let { runtime, fire } = step({ state: alarm.state, cleanStreak: alarm.cleanStreak }, breaching);

    /**
     * "Tell me about each new one" is not a state machine question.
     *
     * A count alarm speaks on the way from clean to not-clean and then stays
     * quiet however many more arrive, because the state is already ALARM. This
     * kind compares the rows against the ones it has already reported and
     * speaks about the difference, which is what somebody means by "alert me on
     * every finding".
     */
    let freshRows: any[] | null = null;
    let clearedKeys: string[] = [];
    let seenKeys: string[] | undefined;

    if (alarm.condition?.kind === "each") {
      // The rows this metric counts, not every row the check returned. The
      // number and the names have to describe the same set, or the message
      // announces something the count never included.
      const counted = rowsForMetric(
        alarm.condition.metric, Array.isArray(rows) ? rows : []);
      const each = newRows(counted, alarm.seenKeys);
      freshRows = each.fresh;
      clearedKeys = each.gone;

      /**
       * Symmetric with the arrivals, because anything else is a surprise.
       *
       * Told about each resource as it starts failing and then once about all
       * of them clearing would mean the all-clear never arrives while anything
       * else is still wrong — so a resource you fixed goes unacknowledged for as
       * long as an unrelated one stays broken. The state machine's recovery is
       * the right rule for a threshold and the wrong one here.
       *
       * Arrivals take the pass when both happen. The departures are held in the
       * remembered set rather than dropped, so they are announced next pass
       * instead of being lost to the same write.
       */
      if (each.fresh.length > 0) {
        fire = "alarm";
        seenKeys = each.seenAfterAlarm;
      } else if (each.gone.length > 0 && alarm.notifyOnRecovery) {
        fire = "recovery";
        seenKeys = each.seenAfterRecovery;
      } else {
        // Nothing new and nothing gone. Silent however long it has been
        // failing, which is the whole point of remembering.
        if (fire === "alarm") fire = null;
        seenKeys = each.seenAfterRecovery;
      }
    }

    let lastFiredAt: string | undefined;
    /**
     * A channel that was expected and did not arrive.
     *
     * Kept apart from `lastError`, which means "no reading could be taken" and
     * governs whether the alarm is trusted at all. This one is about delivery:
     * the reading was fine, the alarm fired, and one of the ways it was
     * supposed to reach somebody did not work.
     */
    let deliveryError: string | undefined;

    if (fire === "alarm" || (fire === "recovery" && alarm.notifyOnRecovery)) {
      /**
       * Claimed before anything is sent. Whoever wins the conditional write
       * owns this transition and sends; whoever loses says nothing. Checked
       * afterwards, the most it could do is report a duplicate already gone
       * out.
       *
       * A recovery is claimed the same way: `notifyOnRecovery` decides whether
       * to speak, and this decides who does.
       */
      /**
       * For an "each" alarm the transition is not what is being claimed.
       *
       * It commonly fires while already in ALARM, where there is no state
       * change to compete over, so the thing two passes would race on is the
       * remembered set. Claiming that instead means the winner is whoever
       * records having reported these rows, and the loser stays quiet — the
       * same guarantee, over the value that actually changes.
       */
      const claimed = alarm.condition?.kind === "each"
        ? (deps.claimSeen
          ? await deps.claimSeen(alarm.id, alarm.seenKeys, seenKeys ?? [], nowIso)
          : true)
        : deps.claimTransition
          ? await deps.claimTransition(alarm.id, alarm.state, runtime.state, nowIso)
          : true;

      if (!claimed) {
        // Somebody else is sending this one. The reading still happened, so the
        // check is recorded, but the state is theirs to write.
        summary.duplicatesAvoided++;
        await deps.saveRuntime(alarm.id, {
          state: runtime.state, cleanStreak: runtime.cleanStreak, lastCheckedAt: nowIso,
          lastValue: value,
        });
        continue;
      }

      const topicArn = await deps.topicArnFor(alarm.groupId);
      if (!topicArn) {
        summary.publishFailures++;
        console.error(`[Alarm] ${alarm.name}: email group ${alarm.groupId} is missing, nothing sent`);
      } else {
        // Everything except the time, which is the one value that differs by
        // who is reading it.
        /**
         * `items` names what changed, which is the whole message for an alarm
         * with no threshold.
         *
         * "Back to normal" without a name is unreadable on an alarm watching
         * twenty resources: it says something recovered and leaves the reader
         * to work out which. Empty for a threshold alarm, where the number is
         * the news and there is no subset to name.
         */
        const changed = alarm.condition?.kind === "each"
          ? (fire === "alarm"
            ? (freshRows ?? []).map(r => subjectOf(r)).filter(Boolean)
            : clearedKeys.map(k => k.split("\u0000")[0]).filter(Boolean))
          : [];

        const base = {
          widget: widget.title || alarm.name,
          metric: metricLabel(widget, alarm.condition),
          value: displayValue(alarm.condition, value),
          threshold: thresholdText(alarm.condition),
          state: fire === "alarm" ? "ALARM" : "OK",
          org: deps.org,
          items: changed.length ? [...new Set(changed)].slice(0, 20).join(", ") : "",
          count: changed.length || undefined,
          // Which direction, in words. "OK" and "ALARM" are precise and mean
          // nothing in the middle of a sentence.
          change: alarm.condition?.kind === "each"
            ? (fire === "alarm" ? "started failing" : "back to normal")
            : "",
        };
        const varsFor = (zones: string[]) => ({ ...base, time: formatTimestampAcross(nowIso, zones) });
        const vars = varsFor(deps.timezone ? [deps.timezone] : []);
        const { subject, body } = buildMessage(alarm.subjectTemplate, alarm.bodyTemplate, vars);

        // Rendered from the same variables, so the two channels can never
        // report different numbers for one firing. Only built when a Teams
        // template was actually written: unset means send the email wording,
        // and rendering it here anyway would leave nothing for `publish` to
        // tell the two cases apart by.
        const teamsText = (alarm.teamsSubjectTemplate || alarm.teamsBodyTemplate)
          ? buildMessage(
              alarm.teamsSubjectTemplate || alarm.subjectTemplate,
              alarm.teamsBodyTemplate || alarm.bodyTemplate,
              vars)
          : undefined;

        /**
         * The same firing, written for a reader in `zone`.
         *
         * Only {{time}} changes. Every other value is the one reading this
         * alarm took, so two people in two countries cannot be told different
         * numbers about the same event, only the same event at their own
         * clock.
         */
        const renderFor = (zones: string[], channel: "email" | "teams") => {
          const v = varsFor(zones);
          return channel === "teams" && (alarm.teamsSubjectTemplate || alarm.teamsBodyTemplate)
            ? buildMessage(
                alarm.teamsSubjectTemplate || alarm.subjectTemplate,
                alarm.teamsBodyTemplate || alarm.bodyTemplate, v)
            : buildMessage(alarm.subjectTemplate, alarm.bodyTemplate, v);
        };

        const result = await deps.publish(topicArn, subject, body, teamsText, renderFor);
        // A test may still hand back a plain boolean; the shape is what the
        // real one reports.
        const ok = typeof result === "boolean" ? result : result.delivered;
        if (ok) lastFiredAt = nowIso;
        else summary.publishFailures++;

        // Recorded even when the email went, because half a delivery reported
        // as a success is how a broken Teams workflow stays invisible.
        if (typeof result !== "boolean" && result.teamsError) {
          deliveryError = result.teamsError;
          summary.teamsFailures = (summary.teamsFailures ?? 0) + 1;
          console.warn(`[Alarm] ${alarm.name}: Teams did not deliver: ${result.teamsError}`);
        }
      }
      if (fire === "alarm") summary.fired++;
      else summary.recovered++;
    } else if (fire === "recovery") {
      // Recovered, but this alarm does not want the all-clear email.
      summary.recovered++;
    }

    await deps.saveRuntime(alarm.id, {
      state: runtime.state,
      cleanStreak: runtime.cleanStreak,
      lastCheckedAt: nowIso,
      lastValue: value,
      ...(deliveryError ? { lastDeliveryError: deliveryError } : { lastDeliveryError: undefined }),
      // Only when nothing was sent. A pass that spoke already wrote the set
      // through the claim, and writing it again here unconditionally would
      // overwrite whichever pass won that race.
      ...(alarm.condition?.kind === "each" && !lastFiredAt && seenKeys
        ? { seenKeys } : {}),
      ...(lastFiredAt ? { lastFiredAt } : {}),
    });
  }

  return summary;
}

/** Exported for the security-alert path, which shares the severity ordering. */
export function meetsMinimumSeverity(severity: string, minimum: string): boolean {
  return severityRank(severity) >= severityRank(minimum);
}
