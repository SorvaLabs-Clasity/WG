/**
 * Arming a write you are not allowed to make.
 *
 * Guardrails break the app's usual arrangement. Everywhere else a write goes
 * out under the credentials of whoever asked for it, so AWS decides and the app
 * holds no permission logic. Remediation cannot: the engine runs in a Lambda,
 * on a schedule, and acts under the Lambda's role.
 *
 * So membership of the guardrail admin team was, on its own, enough to arm an
 * enforce rule, and the privileged Lambda would then perform a write AWS would
 * have refused the person who armed it, successfully, because the Lambda's role
 * is what gets checked. Read-only in production meant nothing. The same held
 * for the per-resource fix button.
 *
 * The gate simulates the caller's own policy before allowing either. What is
 * asserted here is the part that decides, and above all that it fails closed:
 * every way of not knowing has to come out as a refusal, because the failure
 * being prevented is granting a write on the strength of not having checked.
 *
 * Run:  npx tsx repro-guardrailwrites.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import {
  REMEDIATION_ACTIONS, resourceArnFor, scopeArnFor, accountOf,
  principalArn, decide, callerMayRemediate, type PermissionProbe,
} from "./src/aws-guardrails/permissions";
import { canRemediate } from "./src/aws-guardrails/remediators";
import { CATALOG } from "./src/aws-guardrails/catalog";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const probe = (over: Partial<PermissionProbe> = {}): PermissionProbe => ({
  callerArn: async () => "arn:aws:sts::123456789012:assumed-role/ReadOnly/alice",
  simulate: async ({ actions }) => actions.map(a => ({ action: a, decision: "allowed" })),
  ...over,
});

(async () => {
  // ── every remediator is covered ─────────────────────────────────────
  //
  // A kind that can be remediated but has no actions listed would be waved
  // through as "nothing to authorise", which is the whole hole reopened for
  // that one rule.
  {
    for (const entry of CATALOG) {
      const kind = entry.kind as keyof typeof REMEDIATION_ACTIONS;
      if (!canRemediate(entry.kind)) continue;
      check(`${entry.kind} declares the actions it writes with`,
        (REMEDIATION_ACTIONS[kind]?.length ?? 0) > 0,
        REMEDIATION_ACTIONS[kind]);
    }
    check("and a report-only kind authorises nothing, rather than being refused",
      (await callerMayRemediate("iam_user_mfa" as any, [], probe())).allowed,
      "a rule that never writes must not need a write permission");
  }

  // ── the SSO trap ────────────────────────────────────────────────────
  //
  // GetCallerIdentity returns an assumed-role session ARN. IAM will not
  // simulate one. Passed through unchanged it throws, and under a fail-closed
  // rule that denies every SSO user in the product, which is all of them.
  {
    check("an assumed-role session resolves to the role IAM can simulate",
      principalArn("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice@x.com")
        === "arn:aws:iam::123456789012:role/AWSReservedSSO_Admin_abc",
      principalArn("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice@x.com"));
    check("  a plain user ARN is already simulatable and passes through",
      principalArn("arn:aws:iam::123456789012:user/bob") === "arn:aws:iam::123456789012:user/bob");
    check("  and the account can be read back off either",
      accountOf("arn:aws:iam::123456789012:role/X") === "123456789012"
      && accountOf("arn:aws:sts::999999999999:assumed-role/X/y") === "999999999999");
  }

  // ── what gets simulated ─────────────────────────────────────────────
  {
    check("a bucket is simulated by its own ARN, not a wildcard",
      resourceArnFor("s3_https_only", { id: "prod-data" }) === "arn:aws:s3:::prod-data",
      resourceArnFor("s3_https_only", { id: "prod-data" }));
    check("  a log group needs its region and account, and refuses without them",
      resourceArnFor("log_retention_min", { id: "/aws/lambda/x" }) === null,
      "a guessed ARN simulates a group in the wrong account and looks like an answer");
    check("  and builds one when it has both",
      resourceArnFor("log_retention_min", { id: "/aws/lambda/x", region: "us-east-2", accountId: "123456789012" })
        === "arn:aws:logs:us-east-2:123456789012:log-group:/aws/lambda/x:*");

    // Arming enforce is a standing instruction over resources that do not exist
    // yet, so the narrow question is the wrong one to ask at authoring time.
    check("arming enforce asks about the whole namespace",
      scopeArnFor("s3_https_only", "123456789012") === "arn:aws:s3:::*");
    check("  which a sandbox-only policy is correctly refused for",
      !(await callerMayRemediate("s3_https_only", [], probe({
        simulate: async ({ resources }) => [{
          action: "s3:PutBucketPolicy",
          // A policy scoped to sandbox-* does not allow the wildcard.
          decision: resources[0] === "arn:aws:s3:::*" ? "implicitDeny" : "allowed",
        }],
      }))).allowed,
      "the rule being armed does not distinguish sandbox from production either");
  }

  // ── fail closed, every way of not knowing ───────────────────────────
  {
    const cases: [string, Partial<PermissionProbe>][] = [
      ["IAM refuses the simulation itself",
        { simulate: async () => { throw Object.assign(new Error("x"), { name: "AccessDenied" }); } }],
      ["STS cannot say who you are",
        { callerArn: async () => { throw new Error("no credentials"); } }],
      ["the simulation comes back empty",
        { simulate: async () => [] }],
      ["it answers about a different action",
        { simulate: async () => [{ action: "s3:GetBucketPolicy", decision: "allowed" }] }],
    ];
    for (const [label, over] of cases) {
      const v = await callerMayRemediate("s3_https_only", [{ id: "b" }], probe(over));
      check(`${label} is a refusal`, !v.allowed, v);
      check(`  and says so rather than blaming your access`, v.reason.length > 0, v.reason);
    }

    for (const decision of ["implicitDeny", "explicitDeny", ""]) {
      check(`  "${decision || "(blank)"}" is not a yes`,
        !decide([{ action: "s3:PutBucketPolicy", decision }], ["s3:PutBucketPolicy"]).allowed);
    }
    check("  only \"allowed\" is",
      decide([{ action: "s3:PutBucketPolicy", decision: "allowed" }], ["s3:PutBucketPolicy"]).allowed);

    // Being unable to run the check is not the same finding as being denied,
    // and an admin missing iam:SimulatePrincipalPolicy needs to be able to tell.
    const cantCheck = await callerMayRemediate("s3_https_only", [{ id: "b" }], probe({
      simulate: async () => { throw Object.assign(new Error("x"), { name: "AccessDenied" }); },
    }));
    check("a missing simulate permission is named, not reported as a denial",
      /SimulatePrincipalPolicy/.test(cantCheck.reason), cantCheck.reason);
    check("  and says outright that nobody has checked",
      /not the same as being denied/.test(cantCheck.reason), cantCheck.reason);
    check("  names both controls it blocks, not just one",
      /enforce mode or use the Fix button/.test(cantCheck.reason), cantCheck.reason);
    check("  and says what still works, so it does not read as everything broken",
      /rules keep reporting/.test(cantCheck.reason), cantCheck.reason);
  }

  // ── a refusal has to say what you can no longer do ───────────────────
  //
  // "Your AWS access does not allow s3:PutBucketPolicy" is true and leaves
  // somebody staring at a form. The message has to name the control that just
  // stopped working, and say why it is gated at all.
  {
    const denied = async (intent: "enforce" | "fix") => (await callerMayRemediate(
      "s3_https_only", [{ id: "b" }],
      probe({ simulate: async () => [{ action: "s3:PutBucketPolicy", decision: "implicitDeny" }] }),
      undefined, intent)).reason;

    const e = await denied("enforce");
    check("refusing enforce says it is enforce that is blocked",
      /cannot set this rule to enforce/.test(e), e);
    check("  names the AWS action missing", /s3:PutBucketPolicy/.test(e), e);
    check("  explains why it is gated at all",
      /perform that change on your behalf/.test(e), e);
    check("  and says who to ask", /administers your AWS permissions/.test(e), e);

    const f = await denied("fix");
    check("refusing a fix says it is the fix that is blocked",
      /cannot fix this resource/.test(f), f);
    check("  and does not claim enforce was what you tried",
      !/set this rule to enforce/.test(f), f);

    const route = fs.readFileSync("./src/routes/awsGuardrails.ts", "utf8");
    check("the routes say which of the two they are checking",
      /res, "enforce"\)/.test(route) && /res, "fix", region\)/.test(route),
      "a shared message cannot name the control the caller was using");
  }

  // ── the allowed path still works ────────────────────────────────────
  {
    check("someone who may write is allowed",
      (await callerMayRemediate("s3_https_only", [{ id: "b" }], probe())).allowed);
    check("  every action must pass, not just the first",
      !decide([{ action: "a", decision: "allowed" }, { action: "b", decision: "implicitDeny" }],
              ["a", "b"]).allowed);
  }

  // ── the routes actually call it ─────────────────────────────────────
  {
    const route = fs.readFileSync("./src/routes/awsGuardrails.ts", "utf8");
    const between = (a: string, b: string) => route.slice(route.indexOf(a), route.indexOf(b, route.indexOf(a)));

    check("creating a rule in enforce mode is gated",
      /refuseIfCallerCannotWrite\(kind as GuardrailKind, \[\], res, "enforce"\)/.test(route));
    check("editing one into enforce mode is too",
      /refuseIfCallerCannotWrite\(existing\.kind, \[\], res, "enforce"\)/.test(route),
      "creating and updating are two doors onto the same escalation");
    check("the fix button is gated per resource",
      /refuseIfCallerCannotWrite\(\s*rule\.kind,\s*\[\{ id: resourceId/.test(route),
      "report mode still exposes a one-press privileged write");

    // The gate has to run before the Lambda is asked to do anything.
    const fix = between('router.post("/remediate"', "  try {");
    check("  and refuses before the engine is invoked",
      fix.includes("refuseIfCallerCannotWrite") && !fix.includes("invokeEngine"),
      "checking after the write has happened is not a check");

    check("a refusal is a 403 the client can recognise",
      /code: "AWS_WRITE_DENIED"/.test(route));
    check("the check runs against the caller's own credentials",
      /liveProbe\(awsRegion\(\)\)/.test(route),
      "simulating the Lambda's role would answer the wrong question entirely");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
