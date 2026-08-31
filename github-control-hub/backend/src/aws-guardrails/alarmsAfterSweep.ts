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
 * The findings table has three writers, and only one of them is a clock: a
 * scheduled sweep every ten minutes, a CloudTrail event within seconds of a
 * resource changing, and somebody pressing Run or editing an exclusion list.
 * The alarm pass is a fourth thing on a fifth clock, so the tab could show a
 * bucket going red immediately while the alarm about it waited for the next
 * tick. Two answers to one question, from one table.
 *
 * This closes that: whatever rewrote the findings evaluates the alarms that
 * read them, in the same invocation, so the alarm is never older than the data.
 *
 * ## Why this is safe to have a second evaluator
 *
 * `claimTransition` is a conditional write. Whoever moves an alarm from OK to
 * ALARM owns that transition and sends; anybody else is told no and stays
 * quiet. So a notification happens once per transition rather than once per
 * evaluation, however many things are evaluating.
 *
 * That guarantee was needed before this existed. The alarm pass has a
 * five-minute timeout on a five-minute schedule, so an overrun already
 * overlapped the next run and could send twice.
 *
 * ## Why only guardrail alarms
 *
 * Their reading is a scan of the findings table this invocation just wrote:
 * no GitHub, no estate-wide AWS calls. Every other alarm buys its reading, and
 * evaluating those on every data change would multiply that cost by how often
 * the data changes, which is exactly what their intervals exist to bound.
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
