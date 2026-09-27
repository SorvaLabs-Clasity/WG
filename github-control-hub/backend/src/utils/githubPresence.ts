/**
 * Whether this AWS account has GitHub at all — stated at the one moment it is
 * known, which is when the account's secret has just been read.
 *
 * The permission system is inert on an AWS-only account: no organization, no
 * file, nothing to decide. It learned that from `AWS_ONLY`, which only the
 * deployed alarm Lambda ever had set. The server the desktop app runs never
 * did, so on an AWS-only account the missing GitHub App read as credentials
 * that *failed to load* — and every gated route answered "permissions could
 * not be read", on the one kind of account that has no permissions to read.
 *
 * Inferring it from a missing `GITHUB_ORG` alone would be wrong the other way:
 * a secret that failed to load looks exactly like that, and treating it as
 * "no GitHub here" would open every gate on an account that has a file. So it
 * is recorded from the read itself:
 *
 *   - the secret was read and names no organization  → AWS-only, by design;
 *   - there is no secret at all                       → AWS-only, by design;
 *   - the read failed for any other reason            → not known, so not
 *     AWS-only, and the gates stay closed and say so.
 *
 * Every read replaces the previous answer, so switching from an AWS-only
 * account to one whose read then fails does not carry "AWS-only" across.
 */
export type SecretOutcome =
  | { kind: "read"; secrets: Record<string, string> }
  | { kind: "missing" }
  | { kind: "failed" };

export function recordSecretOutcome(outcome: SecretOutcome): void {
  const awsOnly = outcome.kind === "missing"
    || (outcome.kind === "read" && !outcome.secrets.GITHUB_ORG);
  if (awsOnly) process.env.AWS_ONLY = "true";
  else delete process.env.AWS_ONLY;
}

/** Whether a Secrets Manager error means "there is no such secret". */
export function isMissingSecret(err: unknown): boolean {
  const e = err as { name?: string; __type?: string } | null;
  return e?.name === "ResourceNotFoundException"
    || /ResourceNotFoundException/.test(String(e?.__type ?? ""));
}
