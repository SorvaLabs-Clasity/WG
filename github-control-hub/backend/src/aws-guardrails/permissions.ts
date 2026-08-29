import type { GuardrailKind } from "./types";

/**
 * Whether the person asking could make this change themselves.
 *
 * Guardrails are the one place in the app where the usual arrangement does not
 * hold. Everywhere else a write goes out under the credentials of whoever asked
 * for it, so AWS and GitHub decide what is allowed and the app has no
 * permission logic of its own. Remediation cannot work that way: the engine
 * runs in a Lambda, on a schedule, hours after anybody pressed anything, and it
 * necessarily acts as the Lambda's own role.
 *
 * That is a privilege escalation waiting to happen. Somebody read-only in
 * production, but in the team that administers guardrails, could arm an enforce
 * rule and have a privileged Lambda perform a write they could not perform
 * themselves, and it would succeed, because the Lambda's role is what AWS
 * checks. Team membership answers "may they configure guardrails", which is a
 * different question from "may they change this bucket".
 *
 * So authoring is gated on the author, at the moment of authoring, against
 * their own credentials. The engine still does the work under its own role;
 * what this decides is whether anybody was allowed to ask.
 *
 * `iam:SimulatePrincipalPolicy` is used rather than a trial write: it is the
 * question being asked, exactly, and it changes nothing if the answer is yes.
 */

/**
 * The IAM actions each remediator actually calls.
 *
 * Read off `remediators.ts` rather than inferred from the rule's name. A kind
 * with no entry here has no remediator, and there is nothing to authorise.
 */
export const REMEDIATION_ACTIONS: Partial<Record<GuardrailKind, string[]>> = {
  s3_https_only: ["s3:PutBucketPolicy"],
  log_retention_min: ["logs:PutRetentionPolicy"],
};

export interface ResourceRef {
  id: string;
  region?: string;
  accountId?: string;
}

/**
 * The ARN a simulation should be run against.
 *
 * Resource-level, not `"*"`. A policy may well allow `s3:PutBucketPolicy` on
 * the sandbox buckets and not the production one, and simulating against a
 * wildcard would answer a question nobody asked, reporting no as a blanket
 * denial where the truth is "not that one", or yes where it is only some.
 *
 * Returns null when the ARN cannot be built, which the caller must treat as a
 * refusal rather than as permission. A simulation against the wrong ARN is
 * worse than no simulation, because it looks like an answer.
 */
export function resourceArnFor(kind: GuardrailKind, r: ResourceRef): string | null {
  switch (kind) {
    // Bucket ARNs carry no account or region, by design.
    case "s3_https_only":
      return r.id ? `arn:aws:s3:::${r.id}` : null;
    // Log groups do, and both have to be known, a guess would simulate against
    // a group in the wrong account.
    case "log_retention_min":
      return r.id && r.region && r.accountId
        ? `arn:aws:logs:${r.region}:${r.accountId}:log-group:${r.id}:*`
        : null;
    default:
      return null;
  }
}

/**
 * The ARN standing for every resource this rule could ever match.
 *
 * Arming enforce is not a decision about the resources failing today. It is a
 * standing instruction over everything the rule matches, now and in future, and
 * the engine will act on resources that do not exist yet. So the question at
 * authoring time is the wide one, may you write across this namespace, and
 * somebody who may rewrite the sandbox buckets but not the production ones is
 * correctly refused, because the rule they are arming does not distinguish
 * them either.
 *
 * The single-resource form is for the fix button, where the narrow question is
 * the right one: that person is changing that one thing, now.
 */
export function scopeArnFor(kind: GuardrailKind, accountId: string, region?: string): string | null {
  switch (kind) {
    case "s3_https_only":
      return "arn:aws:s3:::*";
    case "log_retention_min":
      return region ? `arn:aws:logs:${region}:${accountId}:log-group:*` : null;
    default:
      return null;
  }
}

/** The account a principal ARN belongs to, for building a scope ARN. */
export function accountOf(arn: string): string {
  return /^arn:aws:[^:]*:[^:]*:(\d+):/.exec(arn)?.[1] ?? "";
}

/**
 * Which of the two write paths is being attempted.
 *
 * Carried into the message because "your AWS access does not allow
 * s3:PutBucketPolicy" is a true sentence that leaves somebody staring at a
 * form wondering what they did. What they need to read is which control has
 * just stopped working and why it is gated at all.
 */
export type WriteIntent = "enforce" | "fix";

const WHAT: Record<WriteIntent, string> = {
  enforce: "set this rule to enforce",
  fix: "fix this resource",
};

/**
 * Both, when the cause blocks both, a missing permission to *check* is not
 * about one control, and saying "you cannot set enforce" would leave somebody
 * to discover the Fix button separately.
 */
const BOTH = "turn on enforce mode or use the Fix button";

export interface PermissionVerdict {
  allowed: boolean;
  /** Said plainly enough to act on: which action, and why the answer is no. */
  reason: string;
}

/**
 * Everything below talks to AWS. Injectable so the decisions above this line
 * can be tested without an account.
 */
export interface PermissionProbe {
  callerArn: () => Promise<string>;
  simulate: (args: { arn: string; actions: string[]; resources: string[] }) =>
    Promise<Array<{ action: string; decision: string }>>;
}

/** The real one, built on the caller's own profile. */
export function liveProbe(region?: string): PermissionProbe {
  return {
    async callerArn() {
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const out = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
      if (!out.Arn) throw new Error("STS returned no ARN for the current identity");
      return out.Arn;
    },
    async simulate({ arn, actions, resources }) {
      const { IAMClient, SimulatePrincipalPolicyCommand } = await import("@aws-sdk/client-iam");
      const out = await new IAMClient({ region }).send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: arn,
        ActionNames: actions,
        ResourceArns: resources,
      }));
      return (out.EvaluationResults ?? []).map(r => ({
        action: r.EvalActionName ?? "",
        decision: r.EvalDecision ?? "implicitDeny",
      }));
    },
  };
}

/**
 * An assumed-role session ARN is not a principal IAM will simulate.
 *
 * `sts:GetCallerIdentity` returns `arn:aws:sts::123:assumed-role/Role/session`,
 * and SimulatePrincipalPolicy wants `arn:aws:iam::123:role/Role`. Passing the
 * session form straight through fails with a validation error, which, under a
 * fail-closed rule, would deny every SSO user in the product, which is all of
 * them.
 */
export function principalArn(callerArn: string): string {
  const m = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//.exec(callerArn);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : callerArn;
}

/** Only `allowed` is a yes. Everything else, including silence, is a no. */
export function decide(
  results: Array<{ action: string; decision: string }>,
  actions: string[],
  intent: WriteIntent = "fix",
): PermissionVerdict {
  const because = "Enforce mode and the Fix button make the app perform that change on your"
    + " behalf, so they are only offered to people who could make it themselves.";
  for (const action of actions) {
    const hit = results.find(r => r.action === action);
    if (!hit) {
      return {
        allowed: false,
        reason: `You cannot ${WHAT[intent]}: AWS did not say whether your access allows `
          + `${action}, and an unanswered check is treated as a no. ${because}`,
      };
    }
    if (hit.decision !== "allowed") {
      return {
        allowed: false,
        reason: `You cannot ${WHAT[intent]}: your AWS access does not allow ${action}. `
          + `${because} Ask whoever administers your AWS permissions if you need it.`,
      };
    }
  }
  return { allowed: true, reason: "" };
}

/**
 * Whether this caller may perform the writes this rule's remediation performs.
 *
 * Fails closed on every uncertainty, an unbuildable ARN, an unreachable IAM,
 * a principal that cannot be resolved. The alternative is granting a write on
 * the strength of not having been able to check, which is the failure this
 * exists to prevent. The message says which of those happened, so an
 * administrator who is merely missing `iam:SimulatePrincipalPolicy` can tell
 * that apart from being genuinely denied.
 */
export async function callerMayRemediate(
  kind: GuardrailKind,
  /** The resources being changed, or empty for "everything this rule matches". */
  resources: ResourceRef[],
  probe: PermissionProbe,
  region?: string,
  intent: WriteIntent = "fix",
): Promise<PermissionVerdict> {
  const actions = REMEDIATION_ACTIONS[kind];
  // Nothing to authorise: a report-only kind never writes.
  if (!actions?.length) return { allowed: true, reason: "" };

  let arn: string;
  try {
    arn = principalArn(await probe.callerArn());
  } catch {
    return {
      allowed: false,
      reason: `You cannot ${BOTH}: the app could not work out who you are signed in to AWS as,`
        + " so it cannot confirm you are allowed to make this change. Signing in to AWS again"
        + " usually fixes it.",
    };
  }

  const arns = resources.length
    ? resources.map(r => resourceArnFor(kind, r)).filter((a): a is string => !!a)
    : [scopeArnFor(kind, accountOf(arn), region)].filter((a): a is string => !!a);
  if (arns.length === 0) {
    return {
      allowed: false,
      reason: `You cannot ${WHAT[intent]}: the app could not work out which AWS resources this`
        + " would change, so it cannot confirm you are allowed to change them.",
    };
  }

  let results: Array<{ action: string; decision: string }>;
  try {
    results = await probe.simulate({ arn, actions, resources: arns });
  } catch (err: any) {
    // Overwhelmingly this is the check itself being denied, which is not the
    // same as the write being denied and must not be reported as if it were.
    // Overwhelmingly the check itself being refused. Named as its own outcome,
    // because "you are not allowed to do this" and "we were not allowed to ask"
    // send somebody to two different people.
    return {
      allowed: false,
      reason: `You cannot ${BOTH}: your AWS access is missing iam:SimulatePrincipalPolicy,`
        + " which the app uses to confirm you could make the change yourself before doing it"
        + ` for you (AWS said: ${err?.name ?? "the check failed"}).`
        + " This is not the same as being denied the change. Nobody has checked."
        + " Ask whoever administers your AWS permissions to add it."
        + " Everything else still works: rules keep reporting, and findings keep collecting.",
    };
  }

  return decide(results, actions, intent);
}
