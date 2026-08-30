/**
 * Timestamps in the reader's own timezone, and the guardrail alarm that could
 * be created and then never edited.
 *
 * {{time}} was rendered once, in the organization's zone, and that zone is UTC
 * unless somebody changed it. So an alarm that fired at half past ten in the
 * morning told everybody it fired at half past two, and the only thing saying
 * otherwise was a "UTC" most people do not read.
 *
 * The two channels can do different amounts about it, and the difference is
 * not a matter of effort:
 *
 *   - **Teams** is called once per address, so each call can carry that
 *     person's own rendering. Per person is real here.
 *   - **Email** leaves as one SNS publish to one topic, which hands every
 *     subscriber the identical body. One zone per group is the finest this
 *     channel has, and pretending otherwise would be a setting that silently
 *     did nothing.
 *
 * Run:  npx tsx repro-recipientzones.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { formatTimestamp } from "./src/alarms/message";
import { evaluateAlarms } from "./src/alarms/evaluate";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  // ── the timestamp names its zone, in words people use ───────────────
  {
    const t = "2026-08-30T14:30:00Z";
    check("a time says which clock it is on",
      formatTimestamp(t, "America/New_York") === "2026-08-30 10:30 EDT",
      formatTimestamp(t, "America/New_York"));

    // The abbreviation, never the IANA name. "10:30 America/New_York" is the
    // database's name for the zone, not a thing anybody says.
    check("  as an abbreviation, not the zone's identifier",
      !formatTimestamp(t, "America/New_York").includes("America/"),
      formatTimestamp(t, "America/New_York"));

    check("  and it follows daylight saving rather than being fixed",
      formatTimestamp("2026-01-15T14:30:00Z", "America/New_York").endsWith("EST")
      && formatTimestamp(t, "America/New_York").endsWith("EDT"),
      "a zone abbreviation that never changes is wrong for half the year");

    // Not every zone has letters. A numeric offset is still an answer.
    check("  a zone with no abbreviation gives an offset",
      /GMT\+5:30$/.test(formatTimestamp(t, "Asia/Kolkata")),
      formatTimestamp(t, "Asia/Kolkata"));

    check("an unknown zone falls back rather than throwing",
      formatTimestamp(t, "Not/AZone").endsWith("UTC"),
      "a rejected timestamp would take the whole message with it");
  }

  // ── one firing, several clocks ──────────────────────────────────────
  {
    const sent: any[] = [];
    const alarm = {
      id: "a1", widgetId: "guardrail:r1", name: "Bucket policy", groupId: "g1",
      condition: { kind: "count", metric: "guardrail.violations", op: "gte", threshold: 1 },
      subjectTemplate: "[{{state}}] {{widget}}",
      bodyTemplate: "{{value}} failing at {{time}}",
      notifyOnRecovery: false, enabled: true, state: "OK" as const, cleanStreak: 0,
    };
    const deps: any = {
      now: Date.parse("2026-08-30T14:30:00Z"), org: "acme", timezone: "UTC",
      listAlarms: async () => [alarm],
      getWidget: async () => ({ id: "guardrail:r1", type: "guardrail", title: "Bucket policy" }),
      topicArnFor: async () => "arn:topic",
      computeRows: async () => ({ rows: [{ verdict: "violation" }, { verdict: "violation" }] }),
      publish: async (_t: string, subject: string, body: string, teamsText: any, renderFor: any) => {
        sent.push({ subject, body, renderFor }); return true;
      },
      saveRuntime: async () => {},
    };

    await evaluateAlarms(deps);
    const one = sent[0];

    check("the pre-rendered copy is the organization's zone",
      one?.body?.includes("UTC"), one?.body);

    check("  and a renderer is handed down for the rest",
      typeof one?.renderFor === "function",
      "without it nothing downstream can write the time any other way");

    const ny = one.renderFor("America/New_York", "email");
    check("  which writes the same event on a different clock",
      ny.body === "2 failing at 2026-08-30 10:30 EDT", ny.body);

    // The reading is the fact; the clock is the reader's. Two people must never
    // be told different numbers about one event.
    const tokyo = one.renderFor("Asia/Tokyo", "email");
    check("  changing only the time, never the reading",
      ny.body.startsWith("2 failing") && tokyo.body.startsWith("2 failing")
      && ny.body !== tokyo.body,
      { ny: ny.body, tokyo: tokyo.body });

    check("  and the subject, which carries no time here, is unchanged",
      ny.subject === one.subject, { a: ny.subject, b: one.subject });
  }

  // ── who gets which clock ────────────────────────────────────────────
  {
    const notify = fs.readFileSync("./src/services/notifyService.ts", "utf8");

    check("a Teams recipient's own zone wins",
      /group!\.recipientZones\?\.\[address\] \?\? group!\.timeZone/.test(notify),
      "theirs, then the group's, and only then whatever was already rendered");

    check("  and each card is built for that person",
      /people\.map\(\(address: string\) => sendToPerson\(flowUrl, address, cardFor\(address\)\)\)/.test(notify),
      "one render for everybody is what made this an organization-wide setting");

    check("email uses the group's zone, since it has only one",
      /renderFor\(group\.timeZone, "email"\)/.test(notify),
      "one publish reaches every subscriber with one body");

    // A per-person email zone would be a control that silently did nothing.
    check("  and there is no per-person email zone pretending to work",
      !/recipientZones[\s\S]{0,120}publishEmail/.test(notify),
      "SNS gives every subscriber the same body, so it could never take effect");

    const routes = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    check("a zone is checked against the runtime before it is stored",
      /knownZone\(raw\)/.test(routes),
      "an unknown zone is not an error downstream, it renders as UTC");

    check("  and clearing one is allowed, since empty means the group's",
      /raw === "" \|\| raw === null \|\| raw === undefined \? null : knownZone\(raw\)/.test(routes),
      "with no way back, the first wrong choice would be permanent");

    check("removing somebody takes their zone with them",
      /delete zones\[key\]/.test(routes),
      "left behind, it silently reattaches to the next person at that address");
  }

  // ── the guardrail alarm that could not be edited ────────────────────
  //
  // Creating one resolved its subject through `subjectFor`, which knows a
  // guardrail id is not a widget. Editing one called `getWidget` directly, got
  // undefined, and refused with "the widget this alarm watches no longer
  // exists" about a widget that had never existed. So every guardrail alarm
  // could be created and then never changed.
  {
    const routes = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    const put = routes.slice(routes.indexOf('router.put("/:id"'));

    check("editing an alarm resolves its subject the way creating one does",
      /const widget = await subjectFor\(existing\.widgetId\)/.test(put),
      "getWidget cannot resolve a guardrail id, and never could");

    check("  and says subject, not widget, since it may not be one",
      /The subject this alarm watches no longer exists/.test(put),
      "the message named a kind of thing the alarm was never watching");

    const post = routes.slice(routes.indexOf('router.post("/"'), routes.indexOf('router.get("/groups"'));
    check("  which is what creating one already did",
      /const widget = await subjectFor\(widgetId\)/.test(post),
      "the two paths disagreeing is the whole bug");

    // Still refused when the rule is genuinely gone: an alarm on a deleted rule
    // reads zero for ever, which looks exactly like compliance.
    check("a subject that really is gone is still refused",
      /found \? \{ id, type: "guardrail", title: `Guardrail: \$\{found\.name\}` \} : undefined/.test(routes),
      "watching a deleted rule reports all-clear for ever");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
