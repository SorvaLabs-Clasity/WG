/**
 * What has to be forgotten when the AWS account changes underneath the process.
 *
 * The desktop app runs one long-lived process and can now move between accounts
 * inside it. Anything cached "because it cannot change" was true only while an
 * account was something chosen once at launch, and each of those caches becomes
 * a way for the account you left to keep answering questions about the one you
 * moved to.
 *
 * They are collected here rather than left at three call sites, because the
 * failure they produce is silent and directional: the AWS tab showed whichever
 * account was signed into *first*, in both directions, and no amount of
 * refreshing helped — every refresh asked the same stale client.
 *
 * Deliberately not here: `utils/dynamo`'s client. Each switch endpoint already
 * resets it, and the access-key endpoint resets it with explicit credentials
 * this function does not have. Resetting it again here would replace that with
 * a client built from the default chain.
 *
 * When you add another module-level cache holding anything account-shaped — a
 * client, an account id, a region list, a secret — add it here too. There is a
 * test that fails when this list and the modules disagree.
 */
export async function forgetAccountScopedCaches(): Promise<void> {
  const { resetGuardrailStore } = await import("../aws-guardrails/store");
  resetGuardrailStore();

  const { resetHomeAccountCache } = await import("../aws-guardrails/accounts");
  resetHomeAccountCache();

  const { resetGithubGate } = await import("../middleware/githubGate");
  resetGithubGate();

  const { resetAwsHealthCache } = await import("../middleware/awsHealthMiddleware");
  resetAwsHealthCache();
}
