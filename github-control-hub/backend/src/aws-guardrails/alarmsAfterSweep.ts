import { evaluateAlarms } from "../alarms/evaluate";
import { GUARDRAIL_PREFIX, guardrailRuleOf } from "../alarms/conditions";
import { computeWidgetRows } from "../alarms/widgetValues";
import { listGuardrails } from "./store";
import {
  listAlarms, getGroup, saveAlarmRuntime, claimTransition, getSecuritySettings,
} from "../services/alarmService";
import { publish } from "../services/notifyService";

/**
 * Re-check the guardrail alarms as soon as the findings behind them change.
 *
 * The findings table has several writers and only one is a clock: the sweep, a
 * CloudTrail event, a manual Run, an exclusion list being edited. Evaluating in
 * the same invocation as the write keeps the alarm from being older than the
 * data it reads.
 *
 * Safe as a second evaluator because `claimTransition` is a conditional write:
 * whoever moves an alarm from OK to ALARM owns that transition and sends, and
 * anybody else stays quiet. One notification per transition, however many
 * things are evaluating.
 *
 * Guardrail alarms only. Their reading is a scan of the table this invocation
 * just wrote; every other alarm buys its reading from GitHub, and triggering
 * those on each data change is what their intervals exist to bound.
 */
export async function evaluateGuardrailAlarms(): Promise<{ evaluated: number; fired: number }> {
  const all = await listAlarms();
  const mine = all.filter(a => a.widgetId.startsWith(GUARDRAIL_PREFIX) && a.enabled);
  if (mine.length === 0) return { evaluated: 0, fired: 0 };

  const summary = await evaluateAlarms({
    now: Date.now(),
    org: process.env.GITHUB_ORG ?? "",
    timezone: (await getSecuritySettings().catch(() => ({ timezone: "UTC" }))).timezone,

    // Only these. The pass is otherwise identical to the scheduled one, which
    // is the point: this is not a second implementation of alarms, it is the
    // same evaluator given a shorter list.
    listAlarms: async () => mine,

    // Due now, whatever their interval says. The interval answers "how often is
    // it worth looking", and something has just answered it.
    ignoreInterval: true,

    getWidget: async (id: string) => {
      const rule = guardrailRuleOf(id);
      const name = rule ? (await listGuardrails()).find(r => r.id === rule)?.name : undefined;
      return {
        id, type: "guardrail",
        title: rule ? `Guardrail: ${name ?? rule}` : "AWS guardrails",
      } as any;
    },
    topicArnFor: async (groupId: string) => (await getGroup(groupId))?.topicArn,
    computeRows: (widget) => computeWidgetRows(widget, {} as any),
    publish,
    saveRuntime: saveAlarmRuntime,
    claimTransition,
  });

  return { evaluated: summary.evaluated, fired: summary.fired };
}
