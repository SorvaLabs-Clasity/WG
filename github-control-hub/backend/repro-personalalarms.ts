import fs from "node:fs";
import { activityPulse } from "./src/services/activitySearch";
import { matches } from "./src/services/activitySearch";

/**
 * Regression test: somebody's own alarms, and the line around them.
 *
 * Two things could go badly wrong here and both are quiet. A personal alarm
 * leaking into the organization's screens exposes what one person watches and
 * where they read it. A personal route accepting a group id would turn "alert
 * me about my card" into "make this app mail anyone", which is the exact
 * capability the admin gate on the organization router exists to hold.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const meAlarms = fs.readFileSync("./src/routes/meAlarms.ts", "utf8");
const orgAlarms = fs.readFileSync("./src/routes/alarms.ts", "utf8");
const service = fs.readFileSync("./src/services/alarmService.ts", "utf8");
const server = fs.readFileSync("./src/server.ts", "utf8");

(async () => {
  console.log("\nthe destination is never something the request chooses");
  {
    // The whole safety argument rests on this. A group id accepted here is a
    // way to point an alarm at an organization topic, or at somebody else's.
    check("the personal route resolves the group from the session",
      /getOrCreatePersonalGroup\(req\.user!\.login\)/.test(meAlarms));
    check("  and never reads one from the body",
      !/req\.body[^\n]*groupId/.test(meAlarms) && !/groupId,\s*$/m.test(meAlarms),
      "a supplied group id undoes every narrowing on this route");
    // The real shape of that hole: handing the body straight to the update,
    // which is what the organization route does behind its admin gate.
    check("  editing names the fields it writes rather than passing the body",
      !/updateAlarm\([^)]*req\.body/.test(meAlarms),
      "spreading the body would let groupId and owner through one request later");
    check("    and groupId is not among them",
      !/groupId[,:]/.test(meAlarms.slice(meAlarms.indexOf('const updated = await updateAlarm'),
                                         meAlarms.indexOf('router.delete("/:id"'))));
  }

  console.log("\nan alarm is only yours if what is stored says so");
  {
    check("ownership is read from the record, not the request",
      /alarm\.owner\.toLowerCase\(\) !== req\.user!\.login\.toLowerCase\(\)/.test(meAlarms));
    // Not 403: saying "you may not touch that" confirms it exists.
    check("  somebody else's alarm answers as absent, not as forbidden",
      /res\.status\(404\)/.test(meAlarms) && !/status\(403\)/.test(meAlarms));
    check("  and the card must be one you own",
      /ownsWidget\(req\.user!\.login/.test(meAlarms));
  }

  console.log("\nthe organization's screens do not show anybody's own");
  {
    check("the org alarm list is the org's alarms", /listOrgAlarms\(\)/.test(orgAlarms));
    check("  the org group list is the org's groups", /listOrgGroups\(\)/.test(orgAlarms));
    check("  an org alarm cannot be pointed at a personal destination",
      /if \(target\.owner\)/.test(orgAlarms),
      "otherwise an administrator can mail one person's private inbox");
    check("  editing a personal alarm from the org route is refused",
      /if \(existing\.owner\) return res\.status\(404\)/.test(orgAlarms));
    check("  as is deleting one",
      /if \(!existing \|\| existing\.owner\) return res\.status\(404\)/.test(orgAlarms));
    check("  and deleting somebody's personal destination",
      /if \(group\.owner\) return res\.status\(404\)/.test(orgAlarms));
  }

  console.log("\none destination per person, made when it is first needed");
  {
    check("a personal group is found by its owner",
      /g\.owner && g\.owner\.toLowerCase\(\) === login\.toLowerCase\(\)/.test(service));
    check("  and created only when there is not one",
      /if \(mine\) return mine;/.test(service));
    // Reusing the group machinery is the point: one delivery path, already
    // tested, rather than a second way to send an email.
    check("  reusing the group the organization's alarms already use",
      /createGroupRecord\(name, topicArn, login, login\)/.test(service));
  }

  console.log("\nthe personal route is not behind the admin gate, on purpose");
  {
    check("it is mounted separately", /api\/me\/alarms/.test(server));
    check("  and does not pull in the gated router",
      !/requireAdmin/.test(meAlarms),
      "the gate is about mailing the organization, which this route cannot do");
    // The one real capability left, and it is bounded.
    check("  the number of addresses is capped",
      /MAX_PERSONAL_EMAILS = \d+/.test(meAlarms) && /MAX_PERSONAL_TEAMS = \d+/.test(meAlarms));
    check("  and an unsubscribe is bound to your own topic",
      /subscriptionArn\.startsWith\(`\$\{group\.topicArn\}:`\)/.test(meAlarms),
      "an ARN from elsewhere would unsubscribe a stranger from a group you do not own");
  }

  console.log("\npersonal changes are recorded, and marked");
  {
    const widgets = fs.readFileSync("./src/services/widgetService.ts", "utf8");
    check("a personal widget change is flagged from the stored record",
      /personal: !!widget\.owner/.test(widgets) && /personal: !!updated\.owner/.test(widgets)
        && /personal: !!existing\.owner/.test(widgets),
      "a caller that forgot to pass it would file a personal change as an org one");
    check("  and a personal alarm change too",
      /personal: !!alarm\.owner/.test(service) && /personal: !!updated\.owner/.test(service));

    // They still count. The point is a distinction in the feed, not a hole in
    // the history.
    const row = {
      action: "config.updated", actor: "ada", target: "alarm",
      timestamp: new Date().toISOString(), personal: true,
    } as any;
    const orgRow = { ...row, personal: undefined };
    check("a personal row matches an unfiltered feed", matches(row, {}));
    check("  is kept by 'only'", matches(row, { personal: "only" }));
    check("  is dropped by 'hide'", !matches(row, { personal: "hide" }));
    check("  while an organization row is the other way round",
      !matches(orgRow, { personal: "only" }) && matches(orgRow, { personal: "hide" }));

    // Statistics counts them: somebody asking "how much changed this week"
    // should see their own board changes in the total.
    const now = Date.now();
    const pulse = await activityPulse(168, 24, "UTC", {
      query: async () => ({
        items: [
          { ...row, id: "1", timestamp: new Date(now - 3_600_000).toISOString() },
          { ...orgRow, id: "2", timestamp: new Date(now - 3_600_000).toISOString() },
        ] as any[],
        next: undefined,
      }),
    });
    check("  and Statistics counts both", pulse.total === 2, pulse.total);
  }

  console.log("\nthe feed says which is which");
  {
    const page = fs.readFileSync("../frontend/src/pages/ActivityPage.tsx", "utf8");
    check("a personal row carries a chip", /{entry\.personal && \(/.test(page));
    check("  and can be filtered to or away",
      /personalMode !== "all" \? \{ personal: personalMode \}/.test(page));
    // A filter left out of the query key never refetches and looks exactly
    // like a broken backend.
    check("    with the filter in the query key",
      /importantKinds, personalMode\]/.test(page),
      "a filter missing from the dependency array does nothing at all");
    check("  the control appears where those rows land",
      /category === "app" \|\| category === "all"/.test(page));

    const labels = fs.readFileSync("../frontend/src/lib/activityCategories.ts", "utf8");
    check('  and the stream is called "App"', /app: "App",/.test(labels));
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
