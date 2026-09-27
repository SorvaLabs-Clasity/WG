/**
 * An AWS-only account is recognised from its secret — and a failed read never is.
 *
 * The server the desktop app runs never had `AWS_ONLY` set, so on an AWS-only
 * account every gated route said "permissions could not be read". It is now
 * recorded from the secret read. The dangerous direction is the other one: a
 * secret that *failed* to load looks like one with no organization, and taking
 * that as "no GitHub here" would open every gate on an account with a file.
 *
 * Run:  npx tsx repro-githubpresence.ts   from github-control-hub/backend
 */
import { recordSecretOutcome, isMissingSecret } from "./src/utils/githubPresence";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

delete process.env.AWS_ONLY;

console.log("what a secret read says about GitHub");
recordSecretOutcome({ kind: "read", secrets: { JWT_SECRET: "x" } });
check("a secret naming no organization is an AWS-only account", process.env.AWS_ONLY === "true");

recordSecretOutcome({ kind: "read", secrets: { GITHUB_ORG: "an-org", JWT_SECRET: "x" } });
check("one naming an organization is not", process.env.AWS_ONLY === undefined, process.env.AWS_ONLY);

recordSecretOutcome({ kind: "missing" });
check("no secret at all is an AWS-only account", process.env.AWS_ONLY === "true");

recordSecretOutcome({ kind: "failed" });
check("a failed read is not, even straight after an AWS-only account",
  process.env.AWS_ONLY === undefined,
  "carrying AWS-only across a switch into an account whose read failed would open its gates");

console.log("\nwhich errors mean \"no such secret\"");
check("ResourceNotFoundException does", isMissingSecret({ name: "ResourceNotFoundException" }));
check("an expired session does not", !isMissingSecret({ name: "CredentialsProviderError" }));
check("access denied does not", !isMissingSecret({ name: "AccessDeniedException" }));

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
