/**
 * Which AWS region this process is talking to.
 *
 * Every client here used to be constructed with
 * `process.env.AWS_REGION || "us-east-1"`, which is worse than passing nothing
 * at all. The SDK resolves a region on its own — from AWS_REGION, then
 * AWS_DEFAULT_REGION, then the signed-in profile's `region`, then the instance
 * or Lambda environment — and a hardcoded fallback *overrides* that chain.
 *
 * So a desktop user whose profile lives in eu-west-1, with no AWS_REGION
 * exported, silently read DynamoDB in us-east-1 and found an empty account.
 * Nothing failed; there was simply nothing there.
 *
 * Returning undefined hands the question back to the SDK, which is the only
 * thing that can answer it correctly.
 */
export function awsRegion(): string | undefined {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

/**
 * The region as a string, for the few places that need to name it rather than
 * call with it — console URLs, and the region shown on the sign-in page.
 *
 * Asks the SDK when the environment is silent, so it agrees with whatever the
 * clients actually connected to rather than guessing alongside them.
 */
export async function resolveAwsRegion(): Promise<string | undefined> {
  const fromEnv = awsRegion();
  if (fromEnv) return fromEnv;
  try {
    // Ask a client rather than re-implementing the lookup. `config.region` is
    // the SDK's own resolver, so this returns exactly what every other client
    // in the process will have used — including a region that came from the
    // signed-in profile, which no environment variable would reveal.
    const { STSClient } = await import("@aws-sdk/client-sts");
    return await new STSClient({}).config.region();
  } catch {
    // Nothing configured. The caller says "unknown" rather than naming a
    // region nobody chose.
    return undefined;
  }
}
