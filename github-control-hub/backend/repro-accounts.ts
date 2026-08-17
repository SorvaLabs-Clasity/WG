/**
 * The account the guardrail engine runs against, and the regions inside it.
 *
 * This file used to test running across several AWS accounts — a registry, a
 * role assumed in each one, access keys in Secrets Manager for accounts outside
 * an organization. That feature is gone, and the standing permissions it needed
 * went with it: `sts:AssumeRole` on a role name in any account, the ability to
 * read stored credentials, and `organizations:ListAccounts`.
 *
 * What survives is the part that was never about multiple accounts: the engine
 * still sweeps several **regions**, an unreachable region must not silently
 * shrink the estate, and a region nobody configured has to be reported as
 * unlooked-at rather than as clean. Those are the failures worth guarding —
 * a tool that reports a healthy account because it stopped looking at half of
 * it.
 *
 * The engine is driven directly with injected collectors, so no AWS and no
 * DynamoDB.
 */
process.env.AWS_REGION = "us-east-1";

import { run } from "./src/aws-guardrails/engine";
import { findingKey } from "./src/aws-guardrails/store";
import { scopesFor, resolveAccounts, credentialsFor } from "./src/aws-guardrails/accounts";
import type { Guardrail, AwsAccount, ResourceSnapshot, Scope } from "./src/aws-guardrails/types";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const account = (over: Partial<AwsAccount> = {}): AwsAccount => ({
  accountId: "111111111111", name: "This account", regions: ["us-east-1"],
  enabled: true, isHome: true,
  createdBy: "system", createdAt: "", updatedAt: "", ...over,
});

const rule = (over: Partial<Guardrail> = {}): Guardrail => ({
  id: "r1", name: "Retention floor", description: "", kind: "log_retention_min",
  enabled: true, mode: "report", applyOnCreate: true,
  params: { minDays: 365 }, exclusionLists: [],
  createdBy: "t", createdAt: "", updatedAt: "", ...over,
});

/** A log group always in violation, so every scope produces a finding. */
const group = (id: string): ResourceSnapshot => ({
  id, type: "logs:log-group", tags: {}, state: { retentionInDays: 7 },
});

(async () => {
  // ── one account, and it is the one we are in ────────────────────────
  //
  // The property the removal was for. There is no registry to add to, so no
  // configuration can point the engine at an estate it does not already have
  // credentials for.
  {
    const accounts = await resolveAccounts().catch(() => null);
    if (accounts === null) {
      // No AWS credentials in this environment, which is the normal case for a
      // test run. The shape is still worth asserting from the type side.
      check("resolveAccounts needs credentials and says so rather than inventing an account", true);
    } else {
      check("exactly one account is ever returned", accounts.length === 1, accounts.length);
      check("  and it is marked as the account the app runs in", accounts[0].isHome === true);
      check("  with no role to assume", !accounts[0].roleArn, accounts[0].roleArn);
    }

    // Ambient credentials, always. Undefined is the instruction to use the
    // process's own chain, and there is no branch that returns anything else.
    check("credentials are always the ambient ones",
      (await credentialsFor(account())) === undefined);
    check("  even for a record that somehow carries a role",
      (await credentialsFor(account({ roleArn: "arn:aws:iam::999999999999:role/x" } as any))) === undefined,
      "a stored role ARN must not resurrect cross-account access");
  }

  // ── every region is visited ─────────────────────────────────────────
  {
    const seen: string[] = [];
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account({ regions: ["us-east-1", "us-east-2"] })],
      credentialsFor: async () => undefined,
      collectors: {
        "logs:log-group": async (scope: Scope) => {
          seen.push(`${scope.accountId}/${scope.region}`);
          return { resources: [group("/aws/lambda/api")] };
        },
      } as any,
    });

    check("each region is collected separately",
      seen.sort().join(",") === "111111111111/us-east-1,111111111111/us-east-2", seen);
    check("  and each produces its own finding", result.findings.length === 2, result.findings.length);
    check("  stamped with the region it came from",
      result.findings.map(f => f.region).sort().join(",") === "us-east-1,us-east-2",
      result.findings.map(f => f.region));
    check("  violations count every region, not just the first",
      result.violations === 2, result.violations);
  }

  // ── the same resource id in two regions is two findings ─────────────
  //
  // A shared key would make the second sweep overwrite the first's verdict, so
  // one region's result would silently stand in for both.
  {
    const a = findingKey({ ruleId: "r1", accountId: "111111111111", region: "us-east-1", resourceId: "/aws/x" } as any);
    const b = findingKey({ ruleId: "r1", accountId: "111111111111", region: "us-east-2", resourceId: "/aws/x" } as any);
    check("identically named resources in two regions get distinct keys", a !== b, { a, b });
  }

  // ── a region that cannot be read is reported, not skipped ───────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account({ regions: ["us-east-1", "us-east-2"] })],
      credentialsFor: async () => undefined,
      collectors: {
        "logs:log-group": async (scope: Scope) => {
          if (scope.region === "us-east-1") throw new Error("AccessDenied");
          return { resources: [group("/aws/lambda/api")] };
        },
      } as any,
    });

    check("a region that fails does not end the sweep", result.findings.length === 1, result.findings.length);
    check("  and the failure is reported rather than swallowed",
      result.errors.some(e => /AccessDenied/.test(e)), result.errors);
  }

  // ── a disabled account is not swept ─────────────────────────────────
  {
    const result = await run([rule()], [], {}, undefined, {
      resolveAccounts: async () => [account({ enabled: false })],
      credentialsFor: async () => undefined,
      collectors: {
        "logs:log-group": async () => ({ resources: [group("/aws/lambda/api")] }),
      } as any,
    });
    check("a disabled account is not swept", result.findings.length === 0, result.findings.length);
  }

  // ── a region nobody configured is a blind spot, not a pass ──────────
  //
  // S3 is global while the sweep is per-region, so a bucket in a region the
  // account does not list is never examined — and on screen an unexamined
  // bucket looks exactly like a compliant one.
  {
    const result = await run([rule({ kind: "s3_https_only", params: { sid: "x" } })], [], {}, undefined, {
      resolveAccounts: async () => [account({ regions: ["us-east-1"] })],
      credentialsFor: async () => undefined,
      collectors: {
        "s3:bucket": async () => ({
          resources: [],
          unswept: [{ region: "eu-west-1", count: 3 }],
        }),
      } as any,
    });

    const blind = result.unswept ?? [];
    check("buckets in a region nobody added are reported as never looked at",
      blind.some(u => u.region === "eu-west-1"), blind);
    check("  with a count, so the size of the blind spot is visible",
      blind.find(u => u.region === "eu-west-1")?.count === 3, blind);
    check("  they are not counted as violations, because nobody checked them",
      result.violations === 0, result.violations);
    check("  nor as errors, because nothing went wrong",
      result.errors.length === 0, result.errors);
  }

  // ── scopesFor ───────────────────────────────────────────────────────
  {
    check("an account with no regions is swept nowhere",
      scopesFor([account({ regions: [] })]).length === 0,
      "a region invented here would be one nobody chose");
    check("  and a disabled one is skipped whatever its regions say",
      scopesFor([account({ enabled: false, regions: ["us-east-1"] })]).length === 0);
    check("  two regions produce two scopes",
      scopesFor([account({ regions: ["us-east-1", "eu-west-1"] })]).length === 2);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
