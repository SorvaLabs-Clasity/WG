/**
 * Permissions are per account, across the whole vocabulary.
 *
 * An account is a configured environment — some with GitHub, some AWS-only —
 * and each has its own tabs. So the account is a dimension over every
 * permission rather than a branch inside the AWS ones: "read Activity in
 * sandbox but not in production" has to be sayable, and a key path could never
 * say it.
 */
import { permissionsFor, inheritedStanding } from "./src/permissions/evaluate";
import { emptyFile, type PermissionsFile } from "./src/permissions/types";
import { fileProblems } from "./src/permissions/validate";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const PROD = "0".repeat(11) + "1";
const DEV = "0".repeat(11) + "2";
const alice = { login: "alice", teamSlugs: [] as string[], isOrgOwner: false };

const file: PermissionsFile = {
  ...emptyFile(),
  presets: {
    reader: { name: "Reader", grant: ["overview.read", "activity.read.own"] },
    operator: { name: "Operator", inherits: "reader", grant: ["alarms", "aws"] },
  },
  people: {
    alice: {
      accounts: {
        [DEV]: { presets: ["operator"] },
        [PROD]: { presets: ["reader"], revoke: ["activity.read.own"] },
      },
    },
  },
};

console.log("the same person holds different things in different accounts");
{
  const dev = permissionsFor(file, alice, DEV);
  const prod = permissionsFor(file, alice, PROD);

  check("in dev she can run the org's alarms", dev.has("alarms.org.create"));
  check("  and touch AWS", dev.has("aws.rules.enforce"));
  check("in prod she can do neither",
    !prod.has("alarms.org.create") && !prod.has("aws.rules.enforce"));
  check("  but can still open Overview, which her reader preset grants there",
    prod.has("overview.read"));
  check("  while her revoke in that account alone takes Activity away",
    !prod.has("activity.read.own") && dev.has("activity.read.own"),
    "a revoke written for one account must not reach another");
}

console.log("\nan account nobody was given anything in grants nothing");
{
  const third = "0".repeat(11) + "3";
  const held = permissionsFor(file, alice, third);
  check("a newly declared account starts empty",
    held.held.length === 0, held.held.slice(0, 6));
  check("  which is deny-by-default applied to a dimension, not an exception to it",
    !held.has("overview.read"));
}

console.log("\nGitHub permissions are scoped too, not only the AWS ones");
{
  const dev = permissionsFor(file, alice, DEV);
  const prod = permissionsFor(file, alice, PROD);
  for (const key of ["alarms.org.create", "activity.read.own", "overview.read"]) {
    check(`  ${key} answers per account`,
      dev.has(key) !== prod.has(key) || key === "overview.read",
      { key, dev: dev.has(key), prod: prod.has(key) });
  }
  check("an AWS-only account still has Activity and Alarms to grant",
    dev.has("activity.read.own") && dev.has("alarms.org.read"),
    "those tabs exist on every account, so they must be grantable on every account");
}

console.log("\na file written before accounts existed still works");
{
  const old: PermissionsFile = {
    ...emptyFile(),
    presets: { reader: { name: "Reader", grant: ["overview.read"] } },
    people: { alice: { presets: ["reader"] } },
  };
  check("with no account in play its top-level fields decide",
    permissionsFor(old, alice).has("overview.read"));
  check("  and it is still a valid file", fileProblems(old).length === 0, fileProblems(old));
  check("  while asking about an account it never mentioned grants nothing",
    !permissionsFor(old, alice, PROD).has("overview.read"),
    "an entry written before accounts cannot silently apply to all of them");
}

console.log("\nthe tree's baseline is per account too");
{
  const devBase = inheritedStanding(file, alice, DEV).baseline;
  const prodBase = inheritedStanding(file, alice, PROD).baseline;
  check("the baseline beneath her differs by account",
    devBase["alarms.org.create"] === true && prodBase["alarms.org.create"] === false,
    { dev: devBase["alarms.org.create"], prod: prodBase["alarms.org.create"] });
  check("  and excludes her own layer in both",
    prodBase["activity.read.own"] === true,
    "her revoke is the layer being edited, so the baseline must show it granted");
}

console.log("the validator holds the per-account shape to the same standard");
{
  const PROD_OK = { ...emptyFile(), presets: { r: { name: "R" } },
    people: { alice: { accounts: { [PROD]: { presets: ["r"], grant: ["me"] } } } } } as PermissionsFile;
  check("a valid per-account entry passes", fileProblems(PROD_OK).length === 0, fileProblems(PROD_OK));

  const bad: Array<[string, any]> = [
    ["an account id that is not twelve digits", { "prod": { grant: ["me"] } }],
    ["an entry that is not an object", { [PROD]: "everything" }],
    ["a presets that is not an array", { [PROD]: { presets: "r" } }],
    ["a preset that does not exist", { [PROD]: { presets: ["nope"] } }],
    ["a grant that is not an array", { [PROD]: { grant: "me" } }],
  ];
  for (const [what, accounts] of bad) {
    const f = { ...emptyFile(), presets: { r: { name: "R" } }, people: { alice: { accounts } } } as any;
    check(`  and ${what} is refused`, fileProblems(f).length > 0,
      "anything written under a bad key decides nothing while reading as though it had");
  }

  const notObject = { ...emptyFile(), people: { alice: { accounts: ["nope"] } } } as any;
  check("  and an accounts that is not an object is refused",
    fileProblems(notObject).length > 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
