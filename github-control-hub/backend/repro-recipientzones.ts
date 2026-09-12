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
import { formatTimestamp, formatTimestampAcross } from "./src/alarms/message";
import { whyNotDue, defaults } from "./src/services/devAlertService";
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
      formatTimestamp(t, "America/New_York") === "Aug 30, 2026 at 10:30 AM EDT",
      formatTimestamp(t, "America/New_York"));

    // The locale is load-bearing, not incidental: en-GB and en-CA render
    // American zones as "GMT-4", which is correct and is not what anybody
    // there calls it. This was why notifications did not say EDT.
    check("  because the formatter asks in a locale that has abbreviations",
      /"en-US"/.test(fs.readFileSync("./src/alarms/message.ts", "utf8")),
      "en-GB gives GMT-4 where en-US gives EDT");

    check("  on a twelve-hour clock",
      / (AM|PM) /.test(formatTimestamp(t, "America/New_York")),
      "14:30 is not how the people receiving these read a time");

    check("  with a named month, which cannot be read the wrong way round",
      /^Aug 30, 2026/.test(formatTimestamp(t, "America/New_York")),
      "08-09 is two different days depending on where you learned to write dates");

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

  // ── one email, every clock on it ────────────────────────────────────
  //
  // Teams is called once per address and gets each person's own zone. Email is
  // one publish to one topic and hands every subscriber the same body, so the
  // choice is not whose zone but how many. Naming them all is the only answer
  // that is right for everybody.
  {
    const t = "2026-08-30T14:30:00Z";
    check("one zone reads as one zone",
      formatTimestampAcross(t, ["America/New_York"]) === "Aug 30, 2026 at 10:30 AM EDT",
      formatTimestampAcross(t, ["America/New_York"]));

    check("  and several are all named, the group's first",
      formatTimestampAcross(t, ["America/New_York", "America/Los_Angeles"])
        === "Aug 30, 2026 at 10:30 AM EDT (7:30 AM PDT)",
      formatTimestampAcross(t, ["America/New_York", "America/Los_Angeles"]));

    // The date once. Repeating it invites reading the second clock as a second
    // event, which on a date boundary is exactly the confusion to avoid.
    check("  carrying the date once, and the clock for the rest",
      (formatTimestampAcross(t, ["America/New_York", "Asia/Tokyo"]).match(/2026/g) ?? []).length === 1,
      formatTimestampAcross(t, ["America/New_York", "Asia/Tokyo"]));

    check("  with duplicates dropped, so one place reads plainly",
      formatTimestampAcross(t, ["UTC", "UTC"]) === formatTimestampAcross(t, ["UTC"]),
      "most groups are in one place and should not see it written twice");

    check("  and an unknown zone left out rather than breaking the line",
      formatTimestampAcross(t, ["America/New_York", "Not/AZone"])
        === "Aug 30, 2026 at 10:30 AM EDT",
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

    const ny = one.renderFor(["America/New_York"], "email");
    check("  which writes the same event on a different clock",
      ny.body === "2 failing at Aug 30, 2026 at 10:30 AM EDT", ny.body);

    // The reading is the fact; the clock is the reader's. Two people must never
    // be told different numbers about one event.
    const tokyo = one.renderFor(["Asia/Tokyo"], "email");
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

    check("a person's own zone wins over the group's",
      /const exact = zones\[address\];/.test(notify)
      && /\|\| group\.timeZone;/.test(notify),
      "theirs, then the group's, and only then the organization's");

    check("  matched however they were capitalised",
      /k\.toLowerCase\(\) === address\.toLowerCase\(\)/.test(notify),
      "one person typed into two groups two ways is still one person");

    check("  and each card is built for that person",
      /people\.map\(\(address: string\) => sendToPerson\(flowUrl, address, cardFor\(address\)\)\)/.test(notify),
      "one render for everybody is what made this an organization-wide setting");

    check("email uses the group's zone, since it has only one",
      /renderFor\(emailZones, "email"\)/.test(notify),
      "one publish reaches every subscriber with one body");

    // A per-person email zone would be a control that silently did nothing.
    check("  and the email carries every zone rather than picking one",
      /const emailZones = group && renderFor \? zonesOf\(group\) : \[\]/.test(notify),
      "SNS gives every subscriber the same body, so one chosen zone is wrong for the rest");

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

  // ── cancelling an invitation nobody has accepted ────────────────────
  //
  // AWS cannot withdraw a pending subscription: it has no ARN to unsubscribe
  // and simply expires after three days. So the X reported success, did
  // nothing, and left the person in the list.
  {
    const notify = fs.readFileSync("./src/services/notifyService.ts", "utf8");
    const routes = fs.readFileSync("./src/routes/alarms.ts", "utf8");

    check("cancelling a pending invitation is recorded, not silently dropped",
      /if \(subscriptionArn === "PendingConfirmation"\) \{/.test(routes)
      && /revokedPending: revoked/.test(routes),
      "removeMember returned early for these, and the caller said Removed");

    check("  identified by the address, since the ARN names everybody waiting",
      /req\.query\.email/.test(routes),
      '"PendingConfirmation" is the same string for every unconfirmed row');

    check("  and refuses rather than guessing when it is missing",
      /Cancelling an unconfirmed invitation needs the address/.test(routes),
      "cancelling the wrong person is worse than not cancelling");

    check("a revoked invitation disappears from the list",
      /if \(denied\.has\(endpoint\.toLowerCase\(\)\)\)/.test(notify),
      "the row staying put is what made the button look broken");

    // The half that makes the list true rather than cosmetic. Without it,
    // somebody removed from a group could click a two-day-old link and start
    // receiving its alarms while showing on nobody's screen.
    check("  and one confirmed afterwards is unsubscribed on sight",
      /if \(confirmed\) \{[\s\S]{0,220}removeMember\(arn\)/.test(notify),
      "hiding a subscriber who still receives mail is worse than showing them");

    check("  while a failure there keeps them hidden rather than back on screen",
      /catch\(err =>[\s\S]{0,140}Could not unsubscribe revoked/.test(notify),
      "a transient error must not undo the removal in the UI");

    check("adding somebody back clears the record",
      /revokedPending: \(group\.revokedPending \?\? \[\]\)\s*\n?\s*\.filter/.test(routes),
      "otherwise their new invitation is hidden and then cancelled behind them");
  }

  // ── zones are named the way a message names them ────────────────────
  {
    const zones = fs.readFileSync("../frontend/src/lib/zones.ts", "utf8");

    check("a zone with letters is labelled by them",
      /return \/\^GMT\[\+-\]\/\.test\(name\) \|\| name === "" \? "" : name;/.test(zones),
      "`short` gives an offset where there is no abbreviation, and that is not a code");

    check("  and the offset is always included",
      /timeZoneName: "shortOffset"/.test(zones),
      "a code alone does not say how far from anywhere else it is");

    check("  with the city kept, so four hundred zones stay tellable apart",
      /\[code, offset, city\]\.filter\(Boolean\)\.join\(" · "\)/.test(zones),
      "dozens of rows reading EDT with no way to pick the right one");

    // One definition, used by both lists, or they drift into two vocabularies
    // for the same thing.
    for (const f of [
      "../frontend/src/components/ZonePicker.tsx",
      "../frontend/src/components/DevAlertSettings.tsx",
    ]) {
      check(`  and ${f.split("/").pop()} uses it`,
        /from "\.\.\/lib\/zones"/.test(fs.readFileSync(f, "utf8")),
        "two labellers is two answers to the same question");
    }
  }

  // ── the rows survive a long address ─────────────────────────────────
  //
  // `truncate` cannot shrink a flex item that has no `min-w-0`: the item will
  // not go below its content width. So one very long address grew the row and
  // pushed the zone picker and the remove button off the end of it, and the
  // class that was supposed to prevent exactly that could not act.
  {
    const panel = fs.readFileSync("../frontend/src/components/EmailGroupsPanel.tsx", "utf8");
    const truncated = fs.readFileSync("../frontend/src/components/Truncated.tsx", "utf8");

    check("both columns clip the address rather than let it push",
      (panel.match(/<Truncated text=/g) ?? []).length === 2,
      { found: (panel.match(/<Truncated text=/g) ?? []).length, expected: 2 });

    check("  which shrinks, because truncate alone cannot",
      /min-w-0 flex-1 truncate/.test(truncated),
      "a flex item will not go below its content width without min-w-0");

    // The column, not only the text in it. grid-cols-2 is minmax(auto, 1fr),
    // and that `auto` sizes a column to its content: the card was being pushed
    // out from a level above the one being truncated.
    /**
     * Asserted on the property, not on the paint.
     *
     * This used to match the column's whole class string including a literal
     * `#151a23`, so re-theming the app failed a test about grid sizing. The
     * thing that matters is `min-w-0` on both columns; what colour they are is
     * the theme's business and changes whenever somebody picks a new one.
     */
    check("  and so does the column holding it",
      (panel.match(/p-5 min-w-0/g) ?? []).length === 2,
      "an auto-sized grid column grows past its share whatever is inside it");

    check("  with the full address on hover",
      /createPortal\(/.test(truncated) && /role="tooltip"/.test(truncated),
      "clipping without a way to read the whole thing hides the row's subject");

    // Rendered into the body, because the card has rounded corners and so
    // overflow:hidden, which would clip a bubble to the row it explains.
    check("  from outside the card, which would otherwise clip it",
      /document\.body,/.test(truncated),
      "a tooltip clipped to its own row is no tooltip");

    // Asked of the browser rather than guessed from a length. A character cap
    // is wrong in both directions: it hides the end of an address that fitted,
    // and lets a shorter one overflow a narrower column.
    check("  and only when the text is actually cut off",
      /el\.scrollWidth <= el\.clientWidth/.test(truncated),
      "a bubble over text you can already read is noise");

    // With the address taking the slack, a margin pushing from the other side
    // is what fights it.
    // Scoped to the member rows. The channel header's count and the
    // organization control legitimately push right; a row must not, because
    // the address is already taking the slack.
    const memberRows = (panel.match(/<li key=\{[\s\S]*?<\/li>/g) ?? []).join("\n");
    check("  with nothing else in a row claiming the free space",
      memberRows.length > 0 && !/ml-auto/.test(memberRows),
      "two things claiming the slack is what broke the row in the first place");
  }

  // ── the default is named as a time, not as a level ──────────────────
  //
  // The pickers read "Organization default" and "Group default": three levels
  // to hold in your head, and a person's row saying "Group default" under a
  // group that had no zone of its own pointed at something equally empty. The
  // question is what time the message will say.
  {
    const picker = fs.readFileSync("../frontend/src/components/ZonePicker.tsx", "utf8");
    const panel = fs.readFileSync("../frontend/src/components/EmailGroupsPanel.tsx", "utf8");

    check("the empty option names the zone that applies",
      /Default · \$\{zoneShort\(inheritZone\)\}/.test(picker),
      "naming the level leaves the reader to resolve the chain themselves");

    check("  and every picker says it the same way",
      !/inherit="Organization default"/.test(panel) && !/Group default/.test(panel),
      "two wordings for one idea is what made this read as two systems");

    // The chain has to be resolved where it is known, not by the control.
    check("a person falls back to their group, and a group to the organization",
      /inheritZone=\{group\.timeZone \|\| orgZone\}/.test(panel)
      && /const orgZone = security\?\.timezone \|\| "UTC";/.test(panel),
      "an unset group is not an answer, so a row cannot stop there");
  }

  // ── daylight saving, which nothing here has to be told about ────────
  //
  // What is stored is an IANA zone name, never an offset, and the offset and
  // the abbreviation are both resolved at the moment of formatting. So the
  // clocks changing is not an event this app handles; it is a fact `Intl`
  // already knows on the day.
  //
  // Storing "GMT-5" instead would have been correct for four months a year.
  {
    const NY = "America/New_York";
    const on = (iso: string) => formatTimestamp(iso, NY);

    check("the same zone is EST in winter and EDT in summer",
      on("2026-01-15T15:00:00Z").endsWith("EST") && on("2026-07-15T15:00:00Z").endsWith("EDT"),
      { winter: on("2026-01-15T15:00:00Z"), summer: on("2026-07-15T15:00:00Z") });

    // The 2026 US transitions are 8 March and 1 November.
    check("  changing on the day, not at some rounded boundary",
      on("2026-03-07T15:00:00Z").endsWith("EST") && on("2026-03-09T15:00:00Z").endsWith("EDT"),
      { before: on("2026-03-07T15:00:00Z"), after: on("2026-03-09T15:00:00Z") });

    check("  and back again in the autumn",
      on("2026-10-31T15:00:00Z").endsWith("EDT") && on("2026-11-02T15:00:00Z").endsWith("EST"),
      { before: on("2026-10-31T15:00:00Z"), after: on("2026-11-02T15:00:00Z") });

    check("  with the hour moving too, not just the label",
      on("2026-01-15T15:00:00Z").includes("10:00 AM")
      && on("2026-07-15T15:00:00Z").includes("11:00 AM"),
      "an abbreviation that changes while the clock does not is worse than neither");

    // The other half: a summary set for nine in the morning has to stay at nine
    // in the morning, which is a different instant in UTC either side of the
    // change. This is why the schedule is compared in local time rather than by
    // storing an offset when it was set.
    const person: any = {
      org: "o", login: "a", teamsAddress: "a@b.c",
      events: { reviewRequested: true, changesRequested: true },
      digest: { ...defaults("a").digest, enabled: true, hour: 9, minute: 0, timeZone: NY, days: [] },
    };
    check("a 9am summary is due at 9am local in winter",
      whyNotDue(person, Date.parse("2026-01-15T14:00:00Z")) === null,
      whyNotDue(person, Date.parse("2026-01-15T14:00:00Z")));

    check("  and at 9am local in summer, which is a different hour in UTC",
      whyNotDue(person, Date.parse("2026-07-15T13:00:00Z")) === null,
      whyNotDue(person, Date.parse("2026-07-15T13:00:00Z")));

    check("  so the UTC hour that worked in winter does not in summer",
      whyNotDue(person, Date.parse("2026-07-15T14:00:00Z")) !== null,
      "a schedule pinned to an offset drifts by an hour twice a year");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
