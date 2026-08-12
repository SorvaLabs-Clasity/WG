/**
 * Tests for running guardrails across more than one AWS account.
 *
 * The failure this is built around is the quiet one: a tool that reports a
 * clean estate because it stopped looking at half of it. So the assertions are
 * mostly about what happens when an account cannot be reached, and about
 * findings from different accounts staying distinguishable.
 *
 * The engine is driven directly with injected collectors and account
 * resolution — no AWS, no DynamoDB.
 */
process.env.AWS_REGION = "us-east-1";

import { run, ruleAppliesTo } from "./src/aws-guardrails/engine";
import { findingKey } from "./src/aws-guardrails/store";
import { scopesFor, accessMethod, sessionArnToRoleArn, suggestExternalId } from "./src/aws-guardrails/accounts";
import type { Guardrail, AwsAccount, ResourceSnapshot, Scope, Finding } from "./src/aws-guardrails/types";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const account = (accountId: string, name: string, over: Partial<AwsAccount> = {}): AwsAccount => ({
  accountId, name, regions: ["us-east-1"], enabled: true,
  createdBy: "t", createdAt: "", updatedAt: "", ...over,
});

const rule = (over: Partial<Guardrail> = {}): Guardrail => ({
  id: "r1", name: "Retention floor", description: "", kind: "log_retention_min",
  enabled: true, mode: "report", applyOnCreate: true,
  params: { minDays: 365 }, exclusionLists: [],
  createdBy: "t", createdAt: "", updatedAt: "", ...over,
});

/** A log group that is always in violation, so every scope produces a finding. */
const group = (id: string): ResourceSnapshot => ({
  id, type: "logs:log-group", tags: {}, state: { retentionInDays: 7 },
});

(async () => {
  // ── every account is visited ───────────────────────────────────────
  {
    const seen: string[] = [];
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account("111111111111", "prod"), account("222222222222", "dev")],
      credentialsFor: async (a) => a.roleArn ? { accessKeyId: "k", secretAccessKey: "s" } : undefined,
      collectors: {
        "logs:log-group": async (scope: Scope) => {
          seen.push(`${scope.accountId}/${scope.region}`);
          return { resources: [group("/aws/lambda/api")] };
        },
      } as any,
    });

    check("both accounts are collected from",
      seen.join() === "111111111111/us-east-1,222222222222/us-east-1", seen);
    check("  and each produces its own finding",
      result.findings.length === 2, result.findings.length);
    check("  stamped with the account it came from",
      result.findings.map(f => f.accountId).sort().join() === "111111111111,222222222222",
      result.findings.map(f => f.accountId));
    check("  and with the name a person would recognise",
      result.findings.map(f => f.accountName).sort().join() === "dev,prod",
      result.findings.map(f => f.accountName));
    check("  violations count every account, not just the first",
      result.violations === 2, result.violations);
    check("  and the run says where it looked",
      result.accountsChecked?.map(a => a.name).join() === "prod,dev", result.accountsChecked);
  }

  // ── same resource name in two accounts ─────────────────────────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account("111111111111", "prod"), account("222222222222", "dev")],
      credentialsFor: async () => undefined,
      collectors: { "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }) } as any,
    });

    const keys = result.findings.map(f => findingKey(f));
    check("identically named resources in two accounts get distinct keys",
      new Set(keys).size === 2, keys);
    check("  so neither overwrites the other's verdict on the next sweep",
      keys.every(k => k.startsWith("1111") || k.startsWith("2222")), keys);
  }

  // ── one account two regions ────────────────────────────────────────
  {
    const seen: string[] = [];
    await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account("111111111111", "prod", { regions: ["us-east-1", "eu-west-1"] })],
      credentialsFor: async () => undefined,
      collectors: {
        "logs:log-group": async (scope: Scope) => { seen.push(scope.region); return { resources: [] }; },
      } as any,
    });
    check("each region of an account is collected separately",
      seen.join() === "us-east-1,eu-west-1", seen);
  }

  // ── an account that cannot be reached ──────────────────────────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [
        account("111111111111", "prod"),
        account("222222222222", "dev", { roleArn: "arn:aws:iam::222222222222:role/gone" }),
        account("333333333333", "uat"),
      ],
      credentialsFor: async (a) => {
        if (a.accountId === "222222222222") throw new Error("AccessDenied");
        return undefined;
      },
      collectors: { "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }) } as any,
    });

    check("a role that cannot be assumed does not end the sweep",
      result.findings.length === 2, result.findings.length);
    check("  the accounts after it are still checked",
      result.findings.some(f => f.accountName === "uat"), result.findings.map(f => f.accountName));
    check("  and the unreachable one is reported, not skipped in silence",
      result.errors.some(e => e.includes("dev") && e.includes("222222222222")), result.errors);
    check("  it is absent from the list of accounts checked",
      !result.accountsChecked?.some(a => a.name === "dev"), result.accountsChecked);
  }

  // ── a disabled account ─────────────────────────────────────────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [
        account("111111111111", "prod"),
        account("222222222222", "dev", { enabled: false }),
      ],
      credentialsFor: async () => undefined,
      collectors: { "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }) } as any,
    });
    check("a disabled account is not swept",
      result.findings.every(f => f.accountName === "prod"), result.findings.map(f => f.accountName));
  }

  // ── narrowing a run to one account ─────────────────────────────────
  {
    const result = await run([rule()], [], { accountIds: ["222222222222"] }, undefined, {
      resolveAccounts: async () => [account("111111111111", "prod"), account("222222222222", "dev")],
      credentialsFor: async () => undefined,
      collectors: { "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }) } as any,
    });
    check("a run limited to one account touches only that account",
      result.findings.length === 1 && result.findings[0].accountName === "dev", result.findings);
  }

  // ── rules that name accounts ───────────────────────────────────────
  {
    check("a rule with no account list applies everywhere",
      ruleAppliesTo(rule(), "999999999999"));
    check("  as does one with an empty list, so new accounts are covered",
      ruleAppliesTo(rule({ accounts: [] }), "999999999999"));
    check("a rule naming accounts applies only to those",
      ruleAppliesTo(rule({ accounts: ["111111111111"] }), "111111111111") &&
      !ruleAppliesTo(rule({ accounts: ["111111111111"] }), "222222222222"));

    const result = await run(
      [rule({ id: "prod-only", accounts: ["111111111111"] }), rule({ id: "everywhere" })],
      [], {}, undefined, {
        resolveAccounts: async () => [account("111111111111", "prod"), account("222222222222", "dev")],
        credentialsFor: async () => undefined,
        collectors: { "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }) } as any,
      });

    const byAccount = (id: string) => result.findings.filter(f => f.accountId === id).map(f => f.ruleId).sort();
    check("  prod gets both rules",
      byAccount("111111111111").join() === "everywhere,prod-only", byAccount("111111111111"));
    check("  dev gets only the unrestricted one",
      byAccount("222222222222").join() === "everywhere", byAccount("222222222222"));
  }

  // ── remediation lands in the right account ─────────────────────────
  {
    const wrote: string[] = [];
    await run([rule({ mode: "enforce" })], [], {}, undefined, {
      resolveAccounts: async () => [
        account("111111111111", "prod"),
        account("222222222222", "dev", { roleArn: "arn:aws:iam::222222222222:role/x" }),
      ],
      credentialsFor: async (a) => a.roleArn ? { accessKeyId: "dev-key", secretAccessKey: "s" } : undefined,
      canRemediate: () => true,
      remediate: (async (_kind: any, resource: ResourceSnapshot, _params: any, scope: Scope) => {
        // The credentials handed to the remediator are the ones that decide
        // which account is written to. A fix computed against prod and applied
        // in dev is the one mistake here that cannot be walked back.
        wrote.push(`${scope.accountId}:${scope.credentials?.accessKeyId ?? "ambient"}:${resource.id}`);
        return { changed: true, description: `fixed ${resource.id}` };
      }) as any,
      collectors: { "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }) } as any,
    });

    check("each fix carries the credentials of the account it is fixing",
      wrote.join() === "111111111111:ambient:/aws/lambda/api,222222222222:dev-key:/aws/lambda/api", wrote);
  }

  // ── the home account keeps working with nothing configured ─────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account("111111111111", "This account", { isHome: true })],
      credentialsFor: async () => undefined,
      collectors: {
        "logs:log-group": async (scope: Scope) => {
          check("the home account is reached without assuming anything",
            scope.credentials === undefined, scope.credentials);
          return { resources: [group("/aws/lambda/api")] };
        },
      } as any,
    });
    check("  and still produces findings", result.findings.length === 1, result.findings.length);
  }

  // ── failing to read the account list ───────────────────────────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => { throw new Error("table missing"); },
      collectors: { "logs:log-group": async () => ({ resources: [group("x")] }) } as any,
    });
    check("an unreadable account list reports an error rather than sweeping nothing quietly",
      result.errors.length === 1 && result.findings.length === 0, result);
  }

  // ── resources in regions nobody swept ──────────────────────────────
  {
    const result = await run([rule({ kind: "s3_https_only" })], [], {}, undefined, {
      resolveAccounts: async () => [account("111111111111", "prod", { regions: ["us-east-1", "eu-west-1"] })],
      credentialsFor: async () => undefined,
      collectors: {
        // What the real S3 collector does: ListBuckets is global, so each pass
        // sees the whole account and reports everything outside its own region.
        "s3:bucket": async (scope: Scope) => ({
          resources: [],
          unswept: [
            { region: "us-east-1", count: 3 },
            { region: "eu-west-1", count: 1 },
            { region: "ap-south-1", count: 7 },
          ].filter(u => u.region !== scope.region),
        }),
      } as any,
    });

    check("buckets in a region nobody added are reported as never looked at",
      result.unswept?.map(u => u.region).join() === "ap-south-1", result.unswept);
    check("  with a count, so the size of the blind spot is visible",
      result.unswept?.[0]?.count === 7, result.unswept);
    check("  and regions the account does sweep are not called blind spots",
      !result.unswept?.some(u => u.region === "eu-west-1"), result.unswept);
    check("  they are not counted as violations, because nobody checked them",
      result.violations === 0, result.violations);
    check("  nor as errors, because nothing went wrong",
      result.errors.length === 0, result.errors);
  }

  // ── keys for findings written before accounts existed ──────────────
  {
    const legacy = { ruleId: "r1", resourceId: "bucket" } as Finding;
    check("a finding with no account keeps its original key, so it can be deleted",
      findingKey(legacy) === "r1#bucket", findingKey(legacy));
  }

  // ── which way in ───────────────────────────────────────────────────
  {
    check("an account with no method and no role uses the organization roles",
      accessMethod(account("1", "x")) === "organization", accessMethod(account("1", "x")));
    check("  an account stored before this existed, with a role ARN, still uses it",
      accessMethod(account("1", "x", { roleArn: "arn:aws:iam::1:role/r" })) === "role");
    check("  one with stored keys and no method uses them",
      accessMethod(account("1", "x", { secretId: "s" })) === "keys");
    check("  the home account is never any of those",
      accessMethod(account("1", "x", { isHome: true, roleArn: "arn:aws:iam::1:role/r" })) === "home");
    check("  and an explicit choice wins over what can be inferred",
      accessMethod(account("1", "x", { access: "keys", roleArn: "arn:aws:iam::1:role/r" })) === "keys");
  }

  // ── deploying to some accounts, not all of them ────────────────────
  {
    const fs = require("fs");
    const path = require("path");
    const script = fs.readFileSync(
      path.join(__dirname, "../../scripts/deploy-guardrail-role-org-wide.sh"), "utf8");
    const page = fs.readFileSync(
      path.join(__dirname, "../frontend/src/pages/AwsPage.tsx"), "utf8");

    // Naming accounts alongside an organisational unit deploys to the whole
    // unit *as well*, unless the filter narrows it. Getting this wrong means
    // the role lands in every account when someone asked for three.
    for (const [what, src] of [["the script", script], ["the app", page]] as const) {
      // Interpolations collapsed to a placeholder, so one regex reads both a
      // shell string and a JS template literal.
      const flat = src.replace(/\$\{[^}]*\}/g, "X").replace(/\$[A-Z_]+/g, "X");
      // Deliberately over the whole file: the first mention of the filter is
      // in a comment explaining it, and a window around that misses the line
      // that actually does the work.
      check(`${what} narrows a chosen-accounts deployment with an intersection filter`,
        /OrganizationalUnitIds=X,Accounts=X,AccountFilterType=INTERSECTION/.test(flat),
        flat.match(/OrganizationalUnitIds=[^\n`"]*/g));
      check(`  and the every-account form has no account list to narrow`,
        /OrganizationalUnitIds=X(?![,\w])/.test(flat),
        flat.match(/OrganizationalUnitIds=[^\n`"]*/g));
    }

    // Auto-deployment adds the role to accounts created later. Right for
    // "every account", wrong for a chosen few — the point of choosing is that a
    // new account is not automatically in scope.
    check("the script only auto-deploys to later accounts when all were chosen",
      /if \[\[ "\$SCOPE" == "all" \]\]/.test(script)
      && /AUTO_DEPLOY="true"[\s\S]*?AUTO_DEPLOY="false"/.test(script),
      "auto-deployment is not tied to the scope choice");
    check("  and so does the app",
      /const autoDeploy = how === "org"/.test(page), "the app auto-deploys for a chosen subset");

    check("the script asks which accounts rather than assuming all of them",
      /ask SCOPE .*all\/some.* "some"/.test(script), "the script defaults to every account");
  }

  // ── the ARNs a watched account must trust ──────────────────────────
  {
    // GetCallerIdentity answers with a session ARN. A trust policy needs the
    // role ARN, and pasting the session one produces a role nobody can assume
    // and an error that points nowhere near the cause.
    check("an EC2 session ARN becomes the role ARN a trust policy accepts",
      sessionArnToRoleArn("arn:aws:sts::123456789012:assumed-role/hub-InstanceRole-ABC/i-0abc123")
      === "arn:aws:iam::123456789012:role/hub-InstanceRole-ABC",
      sessionArnToRoleArn("arn:aws:sts::123456789012:assumed-role/hub-InstanceRole-ABC/i-0abc123"));

    check("  a session name with slashes in it does not truncate the role",
      sessionArnToRoleArn("arn:aws:sts::123456789012:assumed-role/MyRole/session/extra")
      === "arn:aws:iam::123456789012:role/MyRole");

    check("  a non-standard partition survives",
      sessionArnToRoleArn("arn:aws-us-gov:sts::123456789012:assumed-role/R/s")
      === "arn:aws-us-gov:iam::123456789012:role/R");

    check("  something already a role ARN is left alone",
      sessionArnToRoleArn("arn:aws:iam::123456789012:role/Direct")
      === "arn:aws:iam::123456789012:role/Direct");
  }

  // ── external IDs ───────────────────────────────────────────────────
  {
    const a = suggestExternalId(), b = suggestExternalId();
    check("a generated external ID is long enough not to be guessed",
      a.length >= 30, a.length);
    check("  and two are never the same",
      a !== b, [a, b]);
    check("  and it is safe in a URL and a CloudFormation parameter",
      /^[A-Za-z0-9_-]+$/.test(a), a);
  }

  // ── failures that have a fix, reported as the fix ──────────────────
  {
    const { sanitizeError, ActionableError } = await import("./src/utils/errorSanitizer");
    const wasProd = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      // What DynamoDB actually throws: the name carries the meaning, the
      // message says "Requested resource not found" and matches nothing.
      const missing = Object.assign(new Error("Requested resource not found"),
        { name: "ResourceNotFoundException" });
      check("a missing table is not reported as an unexpected error",
        !sanitizeError(missing, "t").includes("unexpected"), sanitizeError(missing, "t"));
      check("  and the message says what to run",
        sanitizeError(missing, "t").includes("setup-aws-account.sh"), sanitizeError(missing, "t"));

      const denied = Object.assign(new Error("User is not authorized"),
        { name: "AccessDeniedException" });
      check("a missing IAM permission says to deploy the stack",
        sanitizeError(denied, "t").includes("CDK"), sanitizeError(denied, "t"));

      check("an actionable error survives production sanitising intact",
        sanitizeError(new ActionableError("Run the thing in the place"), "t") === "Run the thing in the place");

      // Anything genuinely unknown is still hidden.
      check("  while an unrecognised error is still generic in production",
        sanitizeError(new Error("host=10.0.3.4 password=hunter2"), "t").includes("unexpected"),
        sanitizeError(new Error("host=10.0.3.4 password=hunter2"), "t"));
    } finally {
      if (wasProd === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = wasProd;
    }
  }

  // ── scope expansion ────────────────────────────────────────────────
  {
    const scopes = scopesFor([
      account("111111111111", "prod", { regions: ["us-east-1", "eu-west-1"] }),
      account("222222222222", "dev", { enabled: false }),
      account("333333333333", "uat", { regions: [] }),
    ]);
    check("scopes cover every enabled account-region pair",
      scopes.map(s => `${s.accountName}/${s.region}`).join() ===
      "prod/us-east-1,prod/eu-west-1,uat/us-east-1", scopes);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
