import type { S3Event } from "aws-lambda";
import { gunzipSync } from "zlib";
import { createHash } from "crypto";
import { isConsequential, normalize, parseNdjson } from "./events";

/**
 * Enterprise audit log, from S3 into the activity feed.
 *
 * GitHub streams the audit log to a bucket as gzipped newline-delimited JSON.
 * This runs on each object as it lands, keeps the consequential events and
 * writes them as activity rows so they appear in the Audit stream beside
 * everything else the app records.
 *
 * The raw object is left in S3 untouched. That is the complete record — this
 * only builds an index over the part anyone reads, and the filter can be
 * widened later without losing anything that already arrived.
 */

const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE || "";

/**
 * Same thirteen months as every other activity row, stamped from the event's
 * own timestamp rather than write time — a backdated object replayed into the
 * bucket expires on its own schedule instead of thirteen months from now.
 *
 * Inlined rather than imported because this file is bundled on its own, and a
 * row without the stamp is a row that never expires.
 */
const RETENTION_MONTHS = Number(process.env.ACTIVITY_RETENTION_MONTHS) || 13;

function expiryFor(timestamp: string): number {
  const d = new Date(timestamp);
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  const out = new Date(base);
  out.setUTCMonth(out.getUTCMonth() + RETENTION_MONTHS);
  return Math.floor(out.getTime() / 1000);
}

/** DynamoDB rejects a batch larger than 25. */
const BATCH = 25;

/**
 * A stable id for one audit event.
 *
 * Two properties, and the previous version had only the first:
 *
 *   **stable** — replaying an object into the bucket must overwrite the same
 *   rows rather than duplicate them, so the id is derived from the event's own
 *   fields and never from the clock or a random value.
 *
 *   **distinct** — two different events must never collide, or one silently
 *   overwrites the other and the audit trail is short by a row that nothing
 *   reports.
 *
 * It used to be `base64url(`${timestamp}|${target}|${actor}|${repo}`)` cut to
 * 40 characters. Forty base64url characters are thirty bytes of input, and an
 * ISO timestamp plus its separator is twenty-five of them — so the id was the
 * timestamp and the first five characters of the action, and the actor and the
 * repository were truncated away entirely before they could contribute
 * anything. GitHub stamps a bulk operation's events with the same millisecond,
 * so adding a team to twenty repositories produced twenty rows with one id and
 * one surviving row. `sk` is built from the same two values, so the write
 * overwrote in place: no error, no duplicate, nineteen events gone.
 *
 * A digest instead. Every field contributes to every character of the output,
 * so truncating to 40 costs collision resistance rather than fields, and the
 * summary is included because it carries the part of an event that the four
 * key fields do not — which permission changed, to what.
 */
export function auditRowId(n: {
  timestamp: string; target: string; actor: string; repo: string;
  subject?: string; details?: string;
}): string {
  const composite = [n.timestamp, n.target, n.actor, n.repo, n.subject ?? "", n.details ?? ""]
    .join("\u0000");
  return `audit-${createHash("sha256").update(composite).digest("base64url").slice(0, 40)}`;
}

export async function handler(event: S3Event): Promise<void> {
  if (!ACTIVITY_TABLE) throw new Error("[Audit] ACTIVITY_TABLE is not set");

  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");

  const s3 = new S3Client({});
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    // Keys arrive URL-encoded; a key with a space or a colon fetches nothing
    // without this, and the object is skipped with no obvious reason.
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // GitHub writes a plain-text object called `_check` when you press "Check
    // endpoint", and again periodically while streaming is enabled. It is not
    // an audit batch and never parses as one.
    //
    // Skipped by name rather than left to fail: counting it as unparseable
    // logged a failure every time GitHub verified the connection, which would
    // bury a real corrupted batch among routine noise. The count only means
    // something if it only counts real problems.
    if (key === "_check" || key.endsWith("/_check")) {
      console.log(`[Audit] ${key}: endpoint check from GitHub, connection is live`);
      continue;
    }

    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const raw = Buffer.from(await res.Body!.transformToByteArray());

    // GitHub gzips these. Some tooling re-uploads them plain, so the magic
    // number decides rather than the file extension.
    const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    const body = (isGzip ? gunzipSync(raw) : raw).toString("utf8");

    const { events, skipped } = parseNdjson(body);
    const kept = events.filter(e => isConsequential(String(e.action ?? "")));

    console.log(`[Audit] ${key}: ${events.length} events, ${kept.length} indexed, ${skipped} unparseable`);

    const rows = kept.map(e => {
      const n = normalize(e);
      const id = auditRowId(n);
      return {
        PutRequest: {
          Item: {
            pk: "ACTIVITY",
            sk: `${n.timestamp}#${id}`,
            id,
            source: "audit",
            // One action for every audit row; the specific event is in target.
            // That is what puts these in the Audit stream in the UI.
            action: "audit.event",
            actor: n.actor,
            repo: n.repo,
            target: n.target,
            details: n.details,
            // Carried as its own field, not only inside the summary text, so
            // the table can show who an event was about in a column. The
            // Details column is hidden below a large viewport, which is where
            // the subject was previously the only place it appeared.
            ...(n.subject && { subject: n.subject }),
            timestamp: n.timestamp,
            ttl: expiryFor(n.timestamp),
          },
        },
      };
    });

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      let unprocessed = await ddb.send(new BatchWriteCommand({
        RequestItems: { [ACTIVITY_TABLE]: chunk },
      })).then(r => r.UnprocessedItems?.[ACTIVITY_TABLE] ?? []);

      // BatchWrite returns partial success rather than throwing. Ignoring the
      // remainder loses events quietly, which is the one thing an audit trail
      // must not do.
      let attempt = 0;
      while (unprocessed.length > 0 && attempt < 4) {
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
        unprocessed = await ddb.send(new BatchWriteCommand({
          RequestItems: { [ACTIVITY_TABLE]: unprocessed },
        })).then(r => r.UnprocessedItems?.[ACTIVITY_TABLE] ?? []);
        attempt++;
      }
      if (unprocessed.length > 0) {
        // Thrown, not logged: S3 retries the notification, and the stable ids
        // above make a replay harmless.
        throw new Error(`[Audit] ${unprocessed.length} rows from ${key} could not be written after ${attempt} retries`);
      }
    }
  }
}
