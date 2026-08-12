/**
 * Tests for activity retention.
 *
 * The failure that matters is silent: a row written without the expiry stamp
 * is a row DynamoDB keeps forever, and nothing about the table looks wrong.
 * Both writers have to agree, and "13 months" has to mean calendar months.
 */
import { activityExpiry, ACTIVITY_RETENTION_MONTHS } from "./src/services/activityService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** The Lambda carries its own copy; it must produce identical answers. */
function lambdaExpiry(iso: string): number {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + (Number(process.env.ACTIVITY_RETENTION_MONTHS) || 13));
  return Math.floor(d.getTime() / 1000);
}

check("retention is 13 months", ACTIVITY_RETENTION_MONTHS === 13, ACTIVITY_RETENTION_MONTHS);

{
  const written = "2026-08-11T12:00:00.000Z";
  const iso = new Date(activityExpiry(written) * 1000).toISOString();
  check("a row written this August expires the following September",
    iso.startsWith("2027-09-11"), iso);
}

{
  // Calendar months, so a year-plus-a-month is exactly that regardless of
  // which months it spans. 13 × 30 days would land in a different month.
  const written = "2026-01-31T00:00:00.000Z";
  const iso = new Date(activityExpiry(written) * 1000).toISOString();
  check("month-end rolls forward rather than truncating", iso.startsWith("2027-03-03"), iso);
}

{
  const leap = "2024-02-29T00:00:00.000Z";
  const iso = new Date(activityExpiry(leap) * 1000).toISOString();
  check("a leap day does not throw or land in the wrong year", iso.startsWith("2025-03"), iso);
}

{
  // An auditor asking for the last twelve months must find the whole period,
  // which is the entire reason for the extra month.
  const now = Date.now();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);
  check("a row from exactly twelve months ago has not expired",
    activityExpiry(twelveMonthsAgo.toISOString()) * 1000 > now);

  const fourteen = new Date(now);
  fourteen.setUTCMonth(fourteen.getUTCMonth() - 14);
  check("a row from fourteen months ago has", activityExpiry(fourteen.toISOString()) * 1000 < now);
}

{
  const samples = ["2026-08-11T12:00:00.000Z", "2024-02-29T00:00:00.000Z", "2026-12-31T23:59:59.000Z"];
  const disagree = samples.filter(s => activityExpiry(s) !== lambdaExpiry(s));
  check("the app and the Lambda compute the same expiry", disagree.length === 0, disagree);
}

check("the stamp is seconds, not milliseconds — DynamoDB reads it as seconds",
  String(activityExpiry(new Date().toISOString())).length === 10);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
