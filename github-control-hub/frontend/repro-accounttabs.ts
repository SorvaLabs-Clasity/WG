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

console.log("\nthe diff is reviewed before it is saved, not after");
{
  const dialog = fs.readFileSync("./src/components/PermissionDiffDialog.tsx", "utf8");
  const page = fs.readFileSync("./src/pages/AdminPage.tsx", "utf8");

  /**
   * A count of gains and losses answers "is this roughly right". Somebody
   * about to change what a colleague can do in production is asking something
   * else: what exactly, and where. So the changes are listed one permission
   * per line, marked the way a diff is read.
   */
  check("changes are listed per permission, gained and lost marked apart",
    /current\.gained\.map/.test(dialog) && /current\.lost\.map/.test(dialog));
  check("  each line names the permission in words and in key",
    /\{l\.label\}/.test(dialog) && /\{l\.key\}/.test(dialog),
    "the label is what the tree shows; the key is what the file stores");
  check("  and the markers are not colour alone",
    /\+<\/span>/.test(dialog) && /−<\/span>/.test(dialog) && /sr-only/.test(dialog),
    "colour alone is unreadable to anybody who cannot see it");

  /**
   * Grouped by account and navigable, because the changes are per account and
   * one flat list would put a production change beside a sandbox one with
   * nothing but a label between them.
   */
  check("accounts are navigable rather than concatenated",
    /Previous account/.test(dialog) && /Next account/.test(dialog));
  check("  with an account picker when there is more than one",
    /changed\.length > 1/.test(dialog));
  check("  and accounts with nothing to say are left out",
    /diffs\.filter\(d => !d\.unchanged\)/.test(dialog));

  check("saving goes through the review, not straight to the file",
    /Review and save/.test(page) && /onClick=\{\(\) => setConfirming\(true\)\}/.test(page),
    "a Save button that writes immediately makes the preview decorative");
  check("  and the summary under the button is still there",
    /dirty && diffs\.length > 0/.test(page));

  /**
   * The preset page gets the same review. Applying a bundle to twenty people
   * is the change most worth seeing before it lands.
   */
  check("mass apply and remove are offered from the preset's own page",
    /Apply to people/.test(page) && /assignMode/.test(page));
  check("  scoped to chosen accounts, since a preset is held per account",
    /assignAccounts/.test(page));
  check("  reviewed per person before saving",
    /assignDiffs/.test(page) && /setAssignOpen\(true\)/.test(page));
  check("  and honest that it cannot see team-derived access",
    /access from their GitHub teams is not included/.test(page),
    "the client knows the signed-in person's teams and nobody else's");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
