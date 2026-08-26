/**
 * "Is GitHub still reaching us" must be answered by arrivals, not by side effects.
 *
 * The badge exists because silence is this feature's only failure mode: a
 * broken webhook looks exactly like a quiet week, and there is no backfill, so
 * whatever happened meanwhile is gone rather than late.
 *
 * It answered by searching the newest sixty activity rows for one with
 * `source: "github"`, which under-reported twice over:
 *
 *   1. Most delivered events write no activity row at all. `team`,
 *      `membership`, `member` and `dependabot_alert` patch the access graph,
 *      and `push` writes nothing unless detailed logging is on. Those
 *      deliveries were invisible to it.
 *   2. The sixty-row window fills with the app's own `sync.*` housekeeping, so
 *      real events fall out of it as the app gets busier.
 *
 * Measured on a live deployment: the newest qualifying row sat at position 46
 * of 60 and was 259 hours old, so the badge read "Nothing for 3 days" while the
 * worker had handled a delivery four minutes earlier. Fourteen more app rows
 * would have made it claim nothing had ever arrived.
 *
 * Run:  npx tsx repro-webhookhealth.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";
import { webhookHealth } from "./src/services/activityService";
import { recordWebhookSeen, getOrgConfig, __resetWebhookStampThrottle } from "./src/services/orgConfigService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8");
const code = (s: string) => s.split("\n")
  .filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");

(async () => {
  // ── the stamp is written on arrival ─────────────────────────────────
  {
    const wh = code(read("src/webhooks/processDelivery.ts"));
    check("every delivery records that it arrived",
      /recordWebhookSeen\(/.test(wh),
      "inferring arrival from a side effect misses every event that has none");
    check("  before anything else in the delivery can fail",
      wh.indexOf("recordWebhookSeen") < wh.indexOf('event === "repository"'),
      "a delivery that throws later still proves GitHub reached us");
    check("  and failing to record it never costs the delivery",
      /Could not record delivery time/.test(read("src/webhooks/processDelivery.ts")),
      "a throw here would re-run every real effect of the event");
  }

  // ── the health answer no longer depends on a row being written ──────
  {
    const svc = code(read("src/services/activityService.ts"));
    check("the health stamp is read from stored config",
      /lastWebhookAt/.test(svc));
    check("  and the sixty-row search is only a fallback, not the answer",
      svc.indexOf("lastWebhookAt") < svc.lastIndexOf("fromGitHub?.timestamp"),
      "a deployment with no stamp yet must not read as never having received one");
    check("  the later of stamp and feed row wins",
      /Date\.parse\(stamped\) >= Date\.parse\(fromGitHub\.timestamp\)/.test(svc),
      "the stamp is throttled, so a feed row can legitimately be newer");
  }

  // ── the stamp round-trips ───────────────────────────────────────────
  {
    __resetWebhookStampThrottle();
    const when = new Date().toISOString();
    await recordWebhookSeen(when);
    check("recording an arrival stores it", (await getOrgConfig()).lastWebhookAt === when);

    // Throttled: this runs once per delivery, and a write per webhook for a
    // field nothing else reads is a real cost on a busy organization.
    const later = new Date(Date.now() + 1000).toISOString();
    await recordWebhookSeen(later);
    check("  a second arrival within the window does not write again",
      (await getOrgConfig()).lastWebhookAt === when,
      "five minutes of imprecision changes no answer this stamp is used for");

    __resetWebhookStampThrottle();
    await recordWebhookSeen(later);
    check("  and once the window passes it writes",
      (await getOrgConfig()).lastWebhookAt === later);
  }

  // ── the thresholds the badge renders from ───────────────────────────
  {
    const now = Date.parse("2026-08-26T12:00:00Z");
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    check("under a day reads as healthy", webhookHealth(ago(1), now).status === "healthy");
    check("  a day to three days reads as quiet", webhookHealth(ago(30), now).status === "quiet");
    check("  beyond three days reads as stale", webhookHealth(ago(100), now).status === "stale");
    check("  and never having received one is unknown, not stale",
      webhookHealth(null, now).status === "unknown",
      "a fresh install has not failed; it has not started");
  }

  // ── the case that was wrong on the live deployment ──────────────────
  //
  // A delivery four minutes ago, and no activity row from GitHub for 259
  // hours, because everything recent was `team` and `membership` events plus
  // the app's own syncs. The badge must follow the delivery.
  {
    __resetWebhookStampThrottle();
    const now = Date.now();
    const fourMinutesAgo = new Date(now - 4 * 60_000).toISOString();
    await recordWebhookSeen(fourMinutesAgo);
    const { at } = await import("./src/services/activityService").then(m => m.lastGitHubEvent());
    check("a delivery with no activity row still reports as received",
      at === fourMinutesAgo, { reported: at, expected: fourMinutesAgo });
    check("  and the badge calls that healthy",
      webhookHealth(at, now).status === "healthy",
      'this read "Nothing for 3 days" before the fix');
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
