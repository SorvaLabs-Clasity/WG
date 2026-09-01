import fs from "node:fs";
import path from "node:path";
import { evaluateAlarms } from "./src/alarms/evaluate";

/**
 * Regression test: a notification that half arrived says so.
 *
 * `publish` returned one boolean for two channels, and the caller read it as
 * "delivered". So an alarm whose email went and whose Teams message did not
 * recorded a clean firing: no error on the alarm, nothing on the tab, nothing
 * in the feed. The only evidence was the email that did arrive, which is the
 * one thing that makes somebody conclude the Teams half was never built.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

/** One firing, with publish reporting whatever the case under test needs. */
async function fire(outcome: any) {
  const saved: any[] = [];
  await evaluateAlarms({
    now: Date.now(), org: "acme",
    listAlarms: async () => [{
      id: "a1", widgetId: "w1", name: "A", condition: { kind: "count", metric: "query.rows", op: "gte", threshold: 1 },
      groupId: "g1", subjectTemplate: "s", bodyTemplate: "b",
      notifyOnRecovery: false, enabled: true, state: "OK", cleanStreak: 0,
    }] as any,
    getWidget: async () => ({ id: "w1", type: "query", title: "W" }) as any,
    topicArnFor: async () => "arn:topic",
    computeRows: async () => ({ rows: [{ repo: "api" }] }) as any,
    publish: async () => outcome,
    saveRuntime: async (_id: string, rt: any) => { saved.push(rt); },
    ignoreInterval: true,
  } as any);
  return saved[saved.length - 1] ?? {};
}

(async () => {
  console.log("\nthe half that failed is recorded");
  {
    const partial = await fire({
      delivered: true, emailSent: true, teamsSent: false,
      teamsError: "3 addresses expect Teams, but no Teams workflow is set up",
    });
    check("an alarm whose Teams half failed carries the reason",
      typeof partial.lastDeliveryError === "string"
        && partial.lastDeliveryError.includes("Teams workflow"),
      partial.lastDeliveryError);

    // Not lastError: that one means the reading could not be taken, and using
    // it here would make a healthy alarm look unreadable.
    check("  and it is not confused with a failed reading",
      partial.lastError === undefined, partial.lastError);
    check("  while the firing itself still counts as sent",
      typeof partial.lastFiredAt === "string", partial.lastFiredAt);
  }

  console.log("\na clean send clears it");
  {
    const clean = await fire({ delivered: true, emailSent: true, teamsSent: true });
    check("nothing is recorded when both channels took it",
      clean.lastDeliveryError === undefined, clean.lastDeliveryError);
    // Otherwise a workflow somebody fixed keeps showing the failure that made
    // them fix it.
    const service = fs.readFileSync(path.join(__dirname, "src/services/alarmService.ts"), "utf8");
    check("  and a stored one is deleted rather than left",
      /if \(runtime\.lastDeliveryError === undefined\) delete updated\.lastDeliveryError;/.test(service));
  }

  console.log("\nnobody asking for Teams is not a failure");
  {
    const noTeams = await fire({ delivered: true, emailSent: true, teamsSent: false });
    check("a group with no Teams addresses records nothing",
      noTeams.lastDeliveryError === undefined, noTeams.lastDeliveryError);
  }

  console.log("\nthe old shape still works");
  {
    // Tests and any caller that has not been widened hand back a plain boolean.
    const legacy = await fire(true);
    check("a boolean is still read as delivered",
      typeof legacy.lastFiredAt === "string", legacy);
  }

  console.log("\nthe two halves are reported separately at the source");
  {
    const notify = fs.readFileSync(path.join(__dirname, "src/services/notifyService.ts"), "utf8");
    check("publish reports each channel",
      /delivered: email \|\| teams\.sent/.test(notify) && /teamsSent: teams\.sent/.test(notify));
    check("  no recipients is distinguished from none arriving",
      /if \(people\.length === 0\) return \{ sent: false \};/.test(notify),
      "otherwise a group nobody uses for Teams reports a failure every firing");
    check("  and a missing workflow says how many were expecting it",
      /expect Teams, but no Teams workflow is set up/.test(notify));

    const page = fs.readFileSync(
      path.join(__dirname, "..", "frontend", "src", "pages", "AlarmsPage.tsx"), "utf8");
    check("the tab shows it", /Sent, but not delivered everywhere/.test(page));
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
