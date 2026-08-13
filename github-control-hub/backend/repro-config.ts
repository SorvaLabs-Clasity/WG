/**
 * Tests for carrying configuration between accounts, and for the webhook
 * silence indicator.
 *
 * The import is the dangerous half: it writes into a live account, and the two
 * things that would make it dangerous are writing during a dry run and
 * overwriting more than the bundle names. Both are asserted against a fake
 * writer that records every call, rather than against DynamoDB.
 */
process.env.GITHUB_ORG = "test-org";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const HOUR = 3_600_000;

(async () => {
  // ── webhook silence ────────────────────────────────────────────────
  {
    const { webhookHealth } = await import("./src/services/activityService");
    const now = Date.parse("2026-06-15T12:00:00Z");
    const ago = (h: number) => new Date(now - h * HOUR).toISOString();

    check("an event minutes ago reads as healthy",
      webhookHealth(ago(0.2), now).status === "healthy", webhookHealth(ago(0.2), now));
    check("  and so does one just under a day old",
      webhookHealth(ago(23.9), now).status === "healthy", webhookHealth(ago(23.9), now));
    check("a day of silence is called quiet, not broken",
      webhookHealth(ago(30), now).status === "quiet", webhookHealth(ago(30), now));
    check("three days of silence is called stale",
      webhookHealth(ago(80), now).status === "stale", webhookHealth(ago(80), now));
    check("  the boundary at 72h belongs to stale, not quiet",
      webhookHealth(ago(72), now).status === "stale", webhookHealth(ago(72), now));
    check("never having heard anything is not reported as failure",
      webhookHealth(null, now).status === "unknown", webhookHealth(null, now));
    check("  and carries no age it cannot know",
      webhookHealth(null, now).ageHours === null, webhookHealth(null, now));
    check("the age is rounded, not a float with sixteen digits",
      webhookHealth(ago(5.06), now).ageHours === 5.1, webhookHealth(ago(5.06), now));
  }

  // ── what a bundle carries ──────────────────────────────────────────
  {
    const { SECTION_ORDER, FORMAT } = await import("./src/routes/config");

    check("the format is 2, so an older build refuses a bundle it cannot read",
      FORMAT === 2, FORMAT);

    // The templates feature is gone. A bundle must stop claiming to carry it,
    // otherwise an import would report writing sections that no longer have a
    // writer behind them.
    const removed = ["templates", "ruleTemplates", "exclusions"]
      .filter(n => (SECTION_ORDER as readonly string[]).includes(n));
    check("no deleted section is still exported or imported", removed.length === 0, removed);
    check("  and what remains is the configuration that still exists",
      [...SECTION_ORDER].join() === "scanners,widgets,awsGuardrails,awsExclusions", SECTION_ORDER);
  }

  // ── importing a bundle ─────────────────────────────────────────────
  {
    const { applyBundle, SECTION_ORDER, FORMAT } = await import("./src/routes/config");

    const written: string[] = [];
    const writers = Object.fromEntries(
      SECTION_ORDER.map(name => [name, async (x: any) => { written.push(`${name}/${x.id}`); }])
    );

    const bundle = {
      format: FORMAT,
      // Listed out of SECTION_ORDER on purpose — sections are written in the
      // order the app decides, not the order the file happens to list them.
      widgets: [{ id: "w1" }],
      scanners: [{ id: "s1" }, { id: "s2" }],
      // A section a bundle from another account simply would not have.
      awsGuardrails: undefined,
    } as any;

    // Dry run.
    const dry = await applyBundle(bundle, true, writers);
    check("a dry run writes nothing at all", written.length === 0, written);
    check("  but still counts what it would write",
      dry.applied.scanners === 2 && dry.applied.widgets === 1, dry.applied);
    check("  and does not invent counts for sections the bundle omits",
      !("awsGuardrails" in dry.applied) && !("awsExclusions" in dry.applied), dry.applied);

    // For real.
    const real = await applyBundle(bundle, false, writers);
    check("applying writes each record once",
      written.length === 3, written);
    check("  sections land in SECTION_ORDER, not in the order the bundle lists them",
      written.indexOf("scanners/s1") < written.indexOf("widgets/w1"), written);
    check("  and the counts match what was actually written",
      Object.values(real.applied).reduce((a, b) => a + b, 0) === written.length, real.applied);
    check("  a clean import reports no errors", real.errors.length === 0, real.errors);
  }

  // ── a bundle that is partly junk ───────────────────────────────────
  {
    const { applyBundle, SECTION_ORDER } = await import("./src/routes/config");

    const written: string[] = [];
    const writers = Object.fromEntries(
      SECTION_ORDER.map(name => [name, async (x: any) => {
        if (x.id === "explodes") throw new Error("DynamoDB said no");
        written.push(`${name}/${x.id}`);
      }])
    );

    const r = await applyBundle(
      { format: 2, widgets: [{ id: "ok" }, { name: "no id here" }, { id: "explodes" }, { id: "ok2" }] } as any,
      false, writers,
    );

    check("an entry with no id is skipped rather than written under a new one",
      written.join() === "widgets/ok,widgets/ok2", written);
    check("  and is reported", r.errors.some(e => e.includes("no id")), r.errors);
    check("one record failing does not abandon the rest",
      r.applied.widgets === 2, r.applied);
    check("  and the failure names the record and the reason",
      r.errors.some(e => e.includes("explodes") && e.includes("DynamoDB said no")), r.errors);
  }

  // ── nothing is deleted ─────────────────────────────────────────────
  {
    const src = require("fs").readFileSync(__dirname + "/src/routes/config.ts", "utf8");
    check("import never calls a delete",
      !/\bdelete[A-Z]\w*\(/.test(src) && !/DeleteCommand/.test(src), "config.ts references a delete");
    check("  and findings and activity are left out of the export",
      !/listFindings|getActivity\(/.test(src), "config.ts exports observations as if they were config");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
