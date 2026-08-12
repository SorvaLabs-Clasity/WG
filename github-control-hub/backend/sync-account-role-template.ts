/**
 * Copy scripts/guardrail-account-role.yaml into the TypeScript module the
 * backend serves from.
 *
 * Two copies exist because they have different jobs: the repo file is what
 * someone deploys from a checkout, and the embedded string is what the app
 * hands to someone who never opens a terminal. They must be identical bytes,
 * and repro-leastprivilege.ts fails if they are not — this is how you fix that
 * failure.
 */
import fs from "fs";
import path from "path";

const YAML = path.join(__dirname, "../../scripts/guardrail-account-role.yaml");
const TS = path.join(__dirname, "src/aws-guardrails/accountRoleTemplate.ts");

const yaml = fs.readFileSync(YAML, "utf8");

// String.raw with a backtick delimiter: a backtick or a ${ in the YAML would
// end the literal or start an interpolation, and silently ship a truncated
// template that CloudFormation would reject in a confusing way.
if (yaml.includes("`") || yaml.includes("${")) {
  console.error("The template contains a backtick or ${ and cannot be embedded as-is.");
  process.exit(1);
}

const header = `/**
 * The CloudFormation template each watched account deploys.
 *
 * Embedded rather than read from scripts/ because the backend ships as a
 * Docker image that does not contain the repository — and the Accounts screen
 * has to be able to hand this to someone who has never opened a terminal.
 *
 * scripts/guardrail-account-role.yaml is the same bytes, kept for people
 * deploying from a checkout. repro-leastprivilege.ts asserts the two are
 * identical, so neither can drift into being the lenient one.
 *
 * Regenerate after editing the YAML:  npx tsx sync-account-role-template.ts
 */

export const ACCOUNT_ROLE_TEMPLATE = String.raw\``;

fs.writeFileSync(TS, header + yaml + "`;\n");
console.log(`Embedded ${yaml.length} bytes into ${path.relative(process.cwd(), TS)}`);
