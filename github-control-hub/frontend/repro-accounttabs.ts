/**
 * The person screen, per account: tabs, copying, and the save preview.
 *
 * The preview is the part that has to be right. Somebody about to change what
 * a colleague can do in production is entitled to see what will change, where,
 * before it is written — and an entry is a set of grants and revokes at
 * arbitrary depths, so two entries that look nothing alike can decide the same
 * thing. Diffing entries would report noise and miss substance; this diffs
 * what they decide.
 */
import fs from "node:fs";
import { diffAccount } from "./src/components/permissionDiff";
import type { PermissionLeaf, FlatRule } from "./src/api/admin";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const vocab: PermissionLeaf[] = [
  { key: "alarms.org.read", label: "Org-wide alarms", addedIn: 1 },
  { key: "alarms.org.create", label: "Create an org alarm", addedIn: 1 },
  { key: "aws.remediate", label: "Fix a finding", addedIn: 1 },
  { key: "overview.read", label: "Open Overview", addedIn: 1 },
];
const allFalse = Object.fromEntries(vocab.map(l => [l.key, false]));
const PROD = "0".repeat(11) + "1";

console.log("the preview says what changes, in the words on the checkboxes");
{
  const d = diffAccount(PROD, "prod", vocab, {}, { grant: ["alarms.org"] }, allFalse, []);
  check("granting a branch reports each leaf it reaches",
    d.gained.map(g => g.key).sort().join() === "alarms.org.create,alarms.org.read",
    d.gained.map(g => g.key));
  check("  labelled the way the tree labels them, not as keys",
    d.gained.every(g => /alarm/i.test(g.label)), d.gained.map(g => g.label));
  check("  and nothing is reported lost", d.lost.length === 0, d.lost);
}

console.log("\nit diffs what entries decide, not how they are written");
{
  /**
   * The same outcome written two ways. A textual diff would call this a
   * change; it is not one, and reporting it would teach people to skip the
   * preview.
   */
  const asBranch = { grant: ["alarms.org"] };
  const asLeaves = { grant: ["alarms.org.read", "alarms.org.create"] };
  const d = diffAccount(PROD, "prod", vocab, asBranch, asLeaves, allFalse, []);
  check("two spellings of the same grant show no change", d.unchanged, d);
}

console.log("\nit is measured against each account's own baseline");
{
  const inherited: FlatRule[] = [
    { node: "alarms.org", effect: "grant", layer: 0, origin: "team platform" },
  ];
  const baseline = { ...allFalse, "alarms.org.read": true, "alarms.org.create": true };

  const d = diffAccount(PROD, "prod", vocab, {}, { grant: ["alarms.org"] }, baseline, inherited);
  check("granting what a team already grants here is no change",
    d.unchanged, d,
  );

  const revoked = diffAccount(PROD, "prod", vocab, {}, { revoke: ["alarms.org.create"] }, baseline, inherited);
  check("  while revoking one of them is reported as a loss",
    revoked.lost.map(l => l.key).join() === "alarms.org.create", revoked.lost);
  check("    and reported as a loss rather than silently as nothing",
    revoked.gained.length === 0 && !revoked.unchanged);
}

console.log("\nthe screen wires the tabs, the copy and the preview");
{
  const page = fs.readFileSync("./src/pages/AdminPage.tsx", "utf8");

  check("there is a tab per declared account",
    /options=\{accountIds\.map/.test(page));
  check("  and the tree, baseline and presets all follow the open tab",
    /scopedStanding/.test(page) && /storedPresetsFor\(tabKey\)/.test(page),
    "a tab that changed only the checkboxes would edit one account against another's baseline");

  check("permissions can be copied to one account or to all of them",
    /Copy this account's permissions to/.test(page) && /all of them/.test(page));

  /**
   * Copying writes into a draft the current tab is not showing, so a Save
   * button watching only the visible tab would stay disabled over a real
   * change.
   */
  check("  and a change in any account enables Save, not just the open one",
    /anyAccountChanged/.test(page) && /accountIds\.some/.test(page));

  check("the preview is shown before saving, not after",
    /dirty && diffs\.length > 0/.test(page));
  check("  and an account with no change is left out of it",
    /filter\(d => !d\.unchanged\)/.test(page));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
