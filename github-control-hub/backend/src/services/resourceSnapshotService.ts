import { docClient, usesDynamo, tableName, PutCommand, GetCommand } from "../utils/dynamo";

/**
 * What a resource looked like last time this app read it.
 *
 * Drift answers "does AWS match the code". This answers a different question
 * that people ask in the same breath and which drift cannot touch: **has this
 * changed?**
 *
 * The two are not the same, and conflating them is why the app appeared to
 * notice nothing when a rule's address was edited. Drift compares AWS against
 * source, and a security group that no code declares compares the same way
 * before and after an edit — undeclared either way. Nothing about that
 * comparison has any memory.
 *
 * ## What this can and cannot say
 *
 * It records a fingerprint each time a resource is read, so the next read can
 * say what is different. That gives:
 *
 *   - **which rules appeared and which disappeared**, exactly
 *   - **when it was noticed**, meaning the gap between two observations
 *
 * It cannot say *when* the change happened inside that gap, and it cannot say
 * **who** made it. Both come from CloudTrail, which this app deliberately does
 * not use. The wording throughout is therefore "changed since last seen on
 * <date>", never "changed 37 minutes ago" — the second is a claim the data does
 * not support.
 *
 * The first read of a resource establishes a baseline and reports nothing.
 * There is nothing to compare against, and inventing a change on first sight
 * would make every new resource look like an incident.
 */

const TABLE = () => tableName("ALARMS_TABLE");

export interface ResourceSnapshot {
  id: string;
  kind: "resource-snapshot";
  service: string;
  name: string;
  /** The comparable facts, as stable strings. */
  facts: string[];
  /** When this app last read it. Not when it changed. */
  seenAt: string;
  /** When this app last saw it change. */
  changedAt?: string;
  ttl: number;
}

/** Kept long enough that a quarterly review still has a baseline. */
const SNAPSHOT_TTL_DAYS = 180;

const snapshotId = (service: string, name: string) => `snapshot#${service}#${name}`;

let memStore = new Map<string, ResourceSnapshot>();

export function __resetSnapshotsForTests(): void {
  memStore = new Map();
}

export async function loadSnapshot(
  service: string, name: string,
): Promise<ResourceSnapshot | null> {
  const id = snapshotId(service, name);
  if (!usesDynamo()) return memStore.get(id) ?? null;
  const r = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
  const item = r.Item as ResourceSnapshot | undefined;
  return item?.kind === "resource-snapshot" ? item : null;
}

export async function saveSnapshot(row: ResourceSnapshot): Promise<void> {
  const stamped = {
    ...row,
    ttl: Math.floor(Date.now() / 1000) + SNAPSHOT_TTL_DAYS * 86_400,
  };
  if (!usesDynamo()) { memStore.set(row.id, stamped); return; }
  await docClient.send(new PutCommand({ TableName: TABLE(), Item: stamped }));
}

export interface ChangeReport {
  /** Nothing was on file, so this read is the baseline. */
  first: boolean;
  added: string[];
  removed: string[];
  /** When this app previously read it. The change happened at or before now. */
  lastSeenAt: string | null;
  /** When this app last observed a change, including this one. */
  changedAt: string | null;
}

/**
 * What is different since the last read, and record the new state.
 *
 * Order-insensitive: AWS returns rules in whatever order it likes, and a
 * reordering is not a change. Comparing the raw lists would report every read
 * as a change and the feature would be noise by its second use.
 */
export async function trackChange(
  service: string, name: string, facts: string[], now = new Date(),
): Promise<ChangeReport> {
  const previous = await loadSnapshot(service, name);
  const sorted = [...new Set(facts)].sort();

  if (!previous) {
    await saveSnapshot({
      id: snapshotId(service, name), kind: "resource-snapshot",
      service, name, facts: sorted, seenAt: now.toISOString(), ttl: 0,
    });
    return { first: true, added: [], removed: [], lastSeenAt: null, changedAt: null };
  }

  const before = new Set(previous.facts);
  const after = new Set(sorted);
  const added = sorted.filter(f => !before.has(f));
  const removed = previous.facts.filter(f => !after.has(f));
  const changed = added.length > 0 || removed.length > 0;

  // Computed once, then both stored and returned.
  //
  // It was worked out twice — once for the row, once for the reply — and a
  // mutation that broke only the stored copy passed every test, because the
  // reply was still right. The divergence would have surfaced one read later,
  // as a "last changed" that had quietly become "last looked at".
  //
  // Only moved when something actually differs, so opening the page does not
  // make every resource look freshly edited.
  const changedAt = changed ? now.toISOString() : previous.changedAt ?? null;

  await saveSnapshot({
    ...previous,
    facts: sorted,
    seenAt: now.toISOString(),
    changedAt: changedAt ?? undefined,
    ttl: 0,
  });

  return { first: false, added, removed, lastSeenAt: previous.seenAt, changedAt };
}
