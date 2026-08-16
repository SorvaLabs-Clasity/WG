/**
 * Has this changed since we last looked?
 *
 * Run from github-control-hub/backend:  npx tsx repro-snapshot.ts
 *
 * A different question from drift, and one drift cannot answer. Drift compares
 * AWS against source; a security group that no code declares compares
 * identically before and after somebody edits a rule's address — undeclared
 * either way. Nothing about that comparison has any memory, which is why the
 * app appeared to notice nothing when exactly that happened.
 *
 * This remembers. What it can honestly say:
 *
 *   - **which rules appeared and which disappeared**, exactly
 *   - **when it was noticed** — the gap between two reads
 *
 * And what it must never say, because the data does not support it:
 *
 *   - *when* inside that gap the change happened
 *   - **who** made it. That is CloudTrail, which this app does not use
 *
 * So the wording is "changed since last seen on <date>", never "changed 37
 * minutes ago". The first read of a resource is a baseline and reports nothing:
 * inventing a change on first sight would make every new resource an incident.
 */
import {
  trackChange, loadSnapshot, __resetSnapshotsForTests,
} from "./src/services/resourceSnapshotService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const t = (iso: string) => new Date(iso);

(async () => {
  // ── the case that prompted it ────────────────────────────────────────
  {
    __resetSnapshotsForTests();
    const before = ["tcp 22 from 203.0.113.1/32", "tcp 443 from 0.0.0.0/0"];

    const first = await trackChange("ec2-sg", "web", before, t("2026-08-01T10:00:00Z"));
    check("the first read is a baseline, not a change", first.first, first);
    check("  reporting nothing", first.added.length === 0 && first.removed.length === 0);
    check("  because inventing one would make every new resource an incident",
      first.changedAt === null);

    // Somebody edits the address on one rule.
    const after = ["tcp 22 from 198.51.100.7/32", "tcp 443 from 0.0.0.0/0"];
    const r = await trackChange("ec2-sg", "web", after, t("2026-08-02T10:00:00Z"));

    check("an edited address is one rule added and one removed",
      r.added.length === 1 && r.removed.length === 1, r);
    check("  naming the new one", r.added[0] === "tcp 22 from 198.51.100.7/32", r.added);
    check("  and the one it replaced", r.removed[0] === "tcp 22 from 203.0.113.1/32", r.removed);
    check("  the untouched rule is not mentioned",
      !r.added.concat(r.removed).some(x => /443/.test(x)), r);

    // What it may say about time: the gap, and nothing finer.
    check("it reports when we previously looked", r.lastSeenAt === "2026-08-01T10:00:00.000Z", r.lastSeenAt);
    check("  and when the change was noticed", r.changedAt === "2026-08-02T10:00:00.000Z", r.changedAt);
  }

  // ── reading it again must not look like another change ──────────────
  {
    __resetSnapshotsForTests();
    const rules = ["tcp 443 from 0.0.0.0/0"];
    await trackChange("ec2-sg", "web", rules, t("2026-08-01T10:00:00Z"));
    const second = await trackChange("ec2-sg", "web", rules, t("2026-08-01T10:05:00Z"));
    check("reading again with nothing changed reports nothing",
      second.added.length === 0 && second.removed.length === 0, second);
    check("  and is not a first read", !second.first);
    check("  while still recording that we looked",
      second.lastSeenAt === "2026-08-01T10:00:00.000Z", second.lastSeenAt);
  }
  {
    // "Last changed" must not creep forward every time somebody opens the page.
    __resetSnapshotsForTests();
    await trackChange("ec2-sg", "web", ["a"], t("2026-08-01T10:00:00Z"));
    await trackChange("ec2-sg", "web", ["b"], t("2026-08-02T10:00:00Z"));
    const quiet = await trackChange("ec2-sg", "web", ["b"], t("2026-08-09T10:00:00Z"));
    check("last-changed stays put when nothing changed",
      quiet.changedAt === "2026-08-02T10:00:00.000Z", quiet.changedAt);
    check("  rather than becoming last-looked-at",
      quiet.changedAt !== "2026-08-09T10:00:00.000Z");

    // A second quiet read, which is what catches a stored value diverging from
    // a returned one. The first quiet read still had the right answer in front
    // of it; only the next read sees what was actually written down.
    const quieter = await trackChange("ec2-sg", "web", ["b"], t("2026-08-16T10:00:00Z"));
    check("  and is still the real change date two reads later",
      quieter.changedAt === "2026-08-02T10:00:00.000Z", quieter.changedAt);
  }

  // ── AWS's ordering is not a change ──────────────────────────────────
  {
    __resetSnapshotsForTests();
    await trackChange("ec2-sg", "web", ["a", "b", "c"], t("2026-08-01T10:00:00Z"));
    const shuffled = await trackChange("ec2-sg", "web", ["c", "a", "b"], t("2026-08-02T10:00:00Z"));
    check("a reordering is not a change",
      shuffled.added.length === 0 && shuffled.removed.length === 0, shuffled);
    // Otherwise every read would report a change and the feature is noise by
    // its second use.
    check("  and last-changed does not move", shuffled.changedAt === null, shuffled.changedAt);

    const duped = await trackChange("ec2-sg", "web", ["a", "a", "b", "c"], t("2026-08-03T10:00:00Z"));
    check("a repeated rule is not a new rule",
      duped.added.length === 0 && duped.removed.length === 0, duped);
  }

  // ── adding and removing, separately ─────────────────────────────────
  {
    __resetSnapshotsForTests();
    await trackChange("ec2-sg", "web", ["a"], t("2026-08-01T10:00:00Z"));
    const added = await trackChange("ec2-sg", "web", ["a", "b"], t("2026-08-02T10:00:00Z"));
    check("an added rule is added only", added.added.join() === "b" && added.removed.length === 0, added);

    const removed = await trackChange("ec2-sg", "web", ["b"], t("2026-08-03T10:00:00Z"));
    check("a removed rule is removed only",
      removed.removed.join() === "a" && removed.added.length === 0, removed);

    const emptied = await trackChange("ec2-sg", "web", [], t("2026-08-04T10:00:00Z"));
    check("removing every rule is reported, not read as nothing to say",
      emptied.removed.join() === "b", emptied);
  }

  // ── each resource has its own history ───────────────────────────────
  {
    __resetSnapshotsForTests();
    await trackChange("ec2-sg", "web", ["a"], t("2026-08-01T10:00:00Z"));
    const other = await trackChange("ec2-sg", "db", ["z"], t("2026-08-01T10:00:00Z"));
    check("a different resource has its own baseline", other.first, other);
    check("  and does not inherit the first one's rules",
      other.added.length === 0 && other.removed.length === 0);

    const sameName = await trackChange("rds", "web", ["q"], t("2026-08-01T10:00:00Z"));
    check("the same name in another service is a different resource", sameName.first);

    const stored = await loadSnapshot("ec2-sg", "web");
    check("what was stored is what was read", stored?.facts.join() === "a", stored?.facts);

    // Stored in a stable shape, so the row does not churn on re-reads and a
    // stored snapshot can be compared by eye.
    __resetSnapshotsForTests();
    await trackChange("ec2-sg", "x", ["c", "a", "b", "a"], t("2026-08-01T10:00:00Z"));
    const normalised = await loadSnapshot("ec2-sg", "x");
    check("stored facts are sorted and deduplicated",
      normalised?.facts.join() === "a,b,c", normalised?.facts);
    check("  and nothing is stored for a resource never read",
      (await loadSnapshot("ec2-sg", "never")) === null);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
