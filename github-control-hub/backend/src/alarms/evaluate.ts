import {
  conditionsFor, intervalFor, isDue, isBreaching, metricValue, step,
  severityRank, type AlarmState,
} from "./conditions";
import { buildMessage, formatTimestamp } from "./message";
import type { WidgetLike, WidgetRows } from "./widgetValues";

/**
 * One pass over every alarm.
 *
 * Everything it touches is injected, so the whole decision — due, read,
 * compare, transition, send — can be driven from a test with no AWS, no
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
  publish: (topicArn: string, subject: string, body: string) => Promise<boolean>;
  saveRuntime: (id: string, runtime: {
    state: AlarmState; cleanStreak: number; lastCheckedAt: string;
    lastValue?: number | null; lastFiredAt?: string; lastError?: string;
  }) => Promise<void>;
}

export interface EvaluationSummary {
  considered: number;
  evaluated: number;
  skippedNotDue: number;
  fired: number;
  recovered: number;
  unreadable: number;
  publishFailures: number;
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
    fired: 0, recovered: 0, unreadable: 0, publishFailures: 0,
  };

  const alarms = await deps.listAlarms();
  const nowIso = new Date(deps.now).toISOString();

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    summary.considered++;

    const widget = await deps.getWidget(alarm.widgetId);
    if (!widget) {
      // The widget was deleted and the alarm outlived it. Recorded so the UI
      // can say so, and deliberately not fired — an alarm about nothing is
      // not an emergency.
      summary.unreadable++;
      await deps.saveRuntime(alarm.id, {
        state: alarm.state, cleanStreak: alarm.cleanStreak, lastCheckedAt: nowIso,
        lastError: "The widget this alarm watches no longer exists",
      });
      continue;
    }

    if (!isDue(alarm.lastCheckedAt, intervalFor(widget), deps.now)) {
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
      const topicArn = await deps.topicArnFor(alarm.groupId);
      if (!topicArn) {
        summary.publishFailures++;
        console.error(`[Alarm] ${alarm.name}: email group ${alarm.groupId} is missing, nothing sent`);
      } else {
        const { subject, body } = buildMessage(alarm.subjectTemplate, alarm.bodyTemplate, {
          widget: widget.title || alarm.name,
          metric: metricLabel(widget, alarm.condition),
          value: displayValue(alarm.condition, value),
          threshold: thresholdText(alarm.condition),
          state: fire === "alarm" ? "ALARM" : "OK",
          org: deps.org,
          time: formatTimestamp(nowIso, deps.timezone),
        });
        const ok = await deps.publish(topicArn, subject, body);
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
