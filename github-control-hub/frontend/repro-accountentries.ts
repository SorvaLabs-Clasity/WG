/**
 * Reading and writing a person's entry per account, including legacy entries.
 *
 * The scenario these pin came from a real install. The migration wrote 48
 * people as legacy entries (top-level `presets: ["member"]`), then an AWS
 * account was declared. The Presets list correctly said 48 held `member`. But
 * "Remove from → Select everyone" said "nothing would change" and refused to
 * save — because removal looked for `member` in the per-account slots, and on
 * a legacy entry it lives at the top level.
 */
import fs from "node:fs";
import { sliceOf, materialise, withPresetChange, isLegacy } from "./src/components/accountEntries";
import { heldFromFile } from "./src/components/permissionDiff";
import { knownNodesOf } from "./src/components/permissionTreeModel";
import type { PermissionsFile, PermissionLeaf } from "./src/api/admin";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const ACC = "0".repeat(11) + "1";
const ACC2 = "0".repeat(11) + "2";
const vocab: PermissionLeaf[] = [
  { key: "overview.read", label: "Open Overview", addedIn: 1 },
  { key: "me.work.read", label: "Your queue", addedIn: 1 },
];
const known = knownNodesOf(vocab);

/** The migrated file: forty-eight legacy entries holding `member`. */
const migrated = (): PermissionsFile => ({
  version: 1,
  presets: { member: { name: "Member", grant: ["overview", "me"] } },
  teams: {},
  people: Object.fromEntries(
    Array.from({ length: 48 }, (_, i) => [`person-${i}`, { presets: ["member"] }])),
});

const holds = (f: PermissionsFile, login: string, acc: string | null) =>
  heldFromFile(vocab, f.presets, sliceOf(f.people[login], acc).presets ?? [],
    sliceOf(f.people[login], acc), known);

console.log("the reported case: remove member from everybody");
{
  const file = migrated();
  const everyone = Object.keys(file.people);
  const after = withPresetChange(file, everyone, "member", "remove", [ACC], [ACC]);

  check("the file actually changes",
    JSON.stringify(after) !== JSON.stringify(file),
    "an unchanged file is exactly why the dialog said nothing would change");
  check("  and person-0 no longer holds member in that account",
    !(sliceOf(after.people["person-0"], ACC).presets ?? []).includes("member"),
    after.people["person-0"]);

  const before = holds(file, "person-0", ACC);
  const now = holds(after, "person-0", ACC);
  check("  and the diff sees permissions leave",
    before.size > 0 && now.size === 0, { before: [...before], after: [...now] });
}

console.log("\nremoving from one account keeps the others");
{
  /**
   * The danger `materialise` exists for. Write one account onto a legacy entry
   * without copying the rest, and the top-level stops counting — so removing
   * `member` in one account would strip the person in every other one too.
   */
  const file = migrated();
  const after = withPresetChange(file, ["person-0"], "member", "remove", [ACC], [ACC, ACC2]);

  check("gone from the account it was removed from",
    holds(after, "person-0", ACC).size === 0);
  check("  and still there in the account it was not",
    holds(after, "person-0", ACC2).size === 2,
    "an edit to one account must not silently remove somebody from the rest");
  check("  and people not selected are untouched, still legacy",
    isLegacy(after.people["person-1"]) && holds(after, "person-1", ACC).size === 2);
}

console.log("\nreading a legacy entry per account");
{
  const file = migrated();
  check("a legacy entry shows its presets in every account tab",
    (sliceOf(file.people["person-0"], ACC).presets ?? []).includes("member")
      && (sliceOf(file.people["person-0"], ACC2).presets ?? []).includes("member"),
    "an empty tab here is what would have been saved back, stripping them");
  check("  and with accounts not in play", (sliceOf(file.people["person-0"], null).presets ?? []).includes("member"));
}

console.log("\nmaterialise copies, it does not move");
{
  const legacy = { presets: ["member"], grant: ["x"] };
  const m = materialise(legacy as any, [ACC, ACC2]);
  check("every declared account gets the top-level entry",
    (m.accounts?.[ACC]?.presets ?? []).includes("member")
      && (m.accounts?.[ACC2]?.grant ?? []).includes("x"));
  check("  and the top-level is cleared, because it no longer counts",
    m.presets === undefined && m.grant === undefined);
  check("  and each account's copy is its own, not a shared array",
    m.accounts![ACC].presets !== m.accounts![ACC2].presets,
    "a shared array means editing one account edits them all");
  const already = { accounts: { [ACC]: { presets: ["a"] } } };
  check("an entry that is already per-account is left alone",
    JSON.stringify(materialise(already as any, [ACC, ACC2])) === JSON.stringify(already));
}

console.log("\napplying still works, and without accounts too");
{
  const empty: PermissionsFile = { version: 1, presets: { member: { name: "M" } }, teams: {}, people: { a: {} } };
  const applied = withPresetChange(empty, ["a"], "member", "apply", [ACC], [ACC]);
  check("applying in an account writes it there",
    (sliceOf(applied.people.a, ACC).presets ?? []).includes("member"));

  const unscoped = withPresetChange(migrated(), ["person-0"], "member", "remove", [], []);
  check("with no accounts declared the top-level presets are edited",
    !(unscoped.people["person-0"].presets ?? []).includes("member"));
}

console.log("\nthe rule lives in one place");
{
  /**
   * This bug happened because the rule for reading an entry per account was
   * written out in four places in the page, and two got updated. The guard is
   * structural: the page may not index an entry's accounts directly, so the
   * only way to read one is through `sliceOf`, which is tested above.
   */
  const page = fs.readFileSync("./src/pages/AdminPage.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const direct = page.match(/\.accounts\?\.\[[^\]]+\]/g) ?? [];
  check("the admin page never indexes an entry's accounts directly",
    direct.length === 0, direct);
  check("  it reads through sliceOf and writes through withPresetChange",
    /sliceOf\(/.test(page) && /withPresetChange\(/.test(page));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
