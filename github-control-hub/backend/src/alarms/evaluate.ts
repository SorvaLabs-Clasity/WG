import {
  conditionsFor, intervalFor, isDue, isBreaching, metricValue, step,
  severityRank, type AlarmState,
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
}

export interface EvaluatorDeps {
  now: number;
  org: string;
  timezone?: string;
  listAlarms: () => Promise<AlarmLike[]>;
  getWidget: (id: string) => Promise<WidgetLike | undefined>;
  topicArnFor: (groupId: string) => Promise<string | undefined>;
  computeRows: (widget: WidgetLike) => Promise<WidgetRows>;
  publish: (topicArn: string, subject: string, body: string,
    teamsText?: { subject: string; body: string },
    renderFor?: (timeZones: string[], channel: "email" | "teams") => { subject: string; body: string },
  ) => Promise<boolean>;
  saveRuntime: (id: string, runtime: {
    state: AlarmState; cleanStreak: number; lastCheckedAt: string;
    lastValue?: number | null; lastFiredAt?: string; lastError?: string;
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
  return condition?.kind === "severity" ? String(condition.atLeast) : String(condition?.threshold);
}

function metricLabel(widget: WidgetLike, condition: any): string {
  const spec = conditionsFor(widget).find(s => s.metric === condition?.metric);
  return spec?.label ?? String(condition?.metric ?? "value");
}

/** A severity metric's reading is a rank; the email should say the word. */
function displayValue(condition: any, value: number | null): string {
  if (value === null) return "";
  if (condition?.kind !== "severity") return String(value);
  const name = (["", "low", "medium", "high", "critical"] as const)[value];
  return name || String(value);
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
    const { runtime, fire } = step({ state: alarm.state, cleanStreak: alarm.cleanStreak }, breaching);

    let lastFiredAt: string | undefined;

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
      const claimed = deps.claimTransition
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
        const base = {
          widget: widget.title || alarm.name,
          metric: metricLabel(widget, alarm.condition),
          value: displayValue(alarm.condition, value),
          threshold: thresholdText(alarm.condition),
          state: fire === "alarm" ? "ALARM" : "OK",
          org: deps.org,
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

        const ok = await deps.publish(topicArn, subject, body, teamsText, renderFor);
        if (ok) lastFiredAt = nowIso;
        else summary.publishFailures++;
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
      ...(lastFiredAt ? { lastFiredAt } : {}),
    });
  }

  return summary;
}

/** Exported for the security-alert path, which shares the severity ordering. */
export function meetsMinimumSeverity(severity: string, minimum: string): boolean {
  return severityRank(severity) >= severityRank(minimum);
}
