import { awsRegion } from "../utils/region";

/**
 * Two secrets, kept deliberately apart.
 *
 * The receiver needs exactly one value — the webhook HMAC secret — and it is
 * the only component in this system reachable from the internet. The worker
 * needs the whole application bundle, including the GitHub App private key,
 * and nothing outside the queue can reach it.
 *
 * These used to be one secret. That meant the internet-facing function held a
 * key to the App private key it never read, so any bug in the receiver's
 * pre-authentication path — the base64 decode and the HMAC, which necessarily
 * touch bytes nobody has verified yet — would have surrendered the whole
 * organization rather than the ability to check signatures. Since no amount of
 * review proves that path bug-free, the containment has to be real: separate
 * secrets, separate grants, and two code paths below that never share a fetch.
 *
 * Fetched once per container rather than per delivery. A fetch per invocation
 * would add latency against GitHub's ten-second budget, cost a call per
 * delivery, and make every webhook depend on an API the work account
 * restricts by SCP.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * The floor between refetches. Without it, a stream of bad signatures becomes
 * a stream of Secrets Manager calls.
 */
const REFETCH_FLOOR_MS = 60 * 1000;

/**
 * Keys the worker expects in the bundle — the same list the old EC2 app read.
 *
 * GITHUB_WEBHOOK_SECRET is deliberately absent. It lives in its own secret
 * now, and the worker has no use for it: signatures are verified at the edge,
 * before anything reaches the queue.
 */
const SECRET_KEYS = [
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SYSTEM_GITHUB_TOKEN",
  "GITHUB_ORG", "JWT_SECRET",
  "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID",
] as const;

type Bundle = Record<string, string>;

// ── the webhook secret: the receiver's only privilege ──────────────────

let webhookSecret: string | null = null;
let webhookFetchedAt = 0;
let lastRefetchAt = 0;

/**
 * The stored form of the webhook secret.
 *
 * Normally the secret is the value on its own — that is what somebody
 * rotating it in the console will paste into the box. A bundle-shaped
 * `{"GITHUB_WEBHOOK_SECRET": "..."}` is accepted too, so a rotation that
 * copies the old bundle's shape yields the secret rather than an empty string
 * that would reject every delivery until someone noticed.
 *
 * The input here comes from Secrets Manager, not from the network. Nothing an
 * attacker can send reaches this function.
 */
export function readWebhookSecret(stored: string | undefined): string {
  if (!stored) return "";
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === "object"
        && typeof (parsed as Bundle).GITHUB_WEBHOOK_SECRET === "string") {
      return (parsed as Bundle).GITHUB_WEBHOOK_SECRET;
    }
  } catch {
    // Not JSON, which is the ordinary case: the secret is the value itself.
  }
  return stored;
}

async function loadWebhookSecretFromSecretsManager(): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: awsRegion() });
  const name = process.env.WEBHOOK_SECRET_NAME
    || `${process.env.STACK_NAME || "github-control-hub"}/webhook-secret`;
  const result = await client.send(new GetSecretValueCommand({ SecretId: name }));
  return readWebhookSecret(result.SecretString);
}

let webhookLoader: () => Promise<string> = loadWebhookSecretFromSecretsManager;

async function fetchWebhookSecret(): Promise<void> {
  try {
    webhookSecret = await webhookLoader();
    webhookFetchedAt = Date.now();
  } catch (err) {
    // A transient failure is not a reason to discard a working secret. Having
    // never had one still yields "" below, so this stays fail-closed.
    console.error("[Webhook] Could not load the webhook secret:", (err as Error).message);
  }
}

export async function getWebhookSecret(): Promise<string> {
  if (webhookSecret !== null && Date.now() - webhookFetchedAt < CACHE_TTL_MS) {
    return webhookSecret;
  }
  await fetchWebhookSecret();
  return webhookSecret ?? "";
}

/**
 * Re-read after a signature failed to verify.
 *
 * The cache would otherwise mean up to fifteen minutes of rejected deliveries
 * after the webhook secret is rotated, and rejected deliveries are lost rather
 * than queued. This bounds a rotation to roughly one lost delivery.
 */
export async function refetchWebhookSecret(): Promise<string> {
  if (Date.now() - lastRefetchAt < REFETCH_FLOOR_MS) return webhookSecret ?? "";
  lastRefetchAt = Date.now();
  await fetchWebhookSecret();
  return webhookSecret ?? "";
}

// ── the application bundle: the worker's, and never the receiver's ─────

let cached: Bundle | null = null;
let cachedAt = 0;

async function loadBundleFromSecretsManager(): Promise<Bundle> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: awsRegion() });
  const name = process.env.SECRET_NAME
    || `${process.env.STACK_NAME || "github-control-hub"}/secrets`;
  const result = await client.send(new GetSecretValueCommand({ SecretId: name }));
  return result.SecretString ? (JSON.parse(result.SecretString) as Bundle) : {};
}

let bundleLoader: () => Promise<Bundle> = loadBundleFromSecretsManager;

async function fetchBundle(): Promise<void> {
  try {
    cached = await bundleLoader();
    cachedAt = Date.now();
  } catch (err) {
    console.error("[Webhook] Could not load secrets:", (err as Error).message);
  }
}

async function getBundle(): Promise<Bundle> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  await fetchBundle();
  return cached ?? {};
}

/** The worker's bootstrap: the same values the old EC2 app put in the environment. */
export async function loadSecretsIntoEnv(): Promise<void> {
  const bundle = await getBundle();
  for (const key of SECRET_KEYS) {
    if (bundle[key] && !process.env[key]) process.env[key] = bundle[key];
  }
}

// ── test seams ──

/**
 * Installed by the reset seam. A test that forgets to inject a loader fails
 * loudly here rather than silently making a live Secrets Manager call — which
 * is what restoring the real loader would do, and which makes a test's result
 * depend on whose credentials are in the environment.
 */
async function unconfiguredLoader(): Promise<never> {
  throw new Error("secret loader not configured — inject one first");
}

export function __setWebhookSecretLoaderForTests(fn: () => Promise<string>): void {
  webhookLoader = fn;
}
export function __setBundleLoaderForTests(fn: () => Promise<Bundle>): void {
  bundleLoader = fn;
}
export function __resetSecretCacheForTests(opts?: { keepValue?: boolean }): void {
  if (!opts?.keepValue) {
    webhookSecret = null;
    cached = null;
  }
  webhookFetchedAt = 0;
  cachedAt = 0;
  lastRefetchAt = 0;
  webhookLoader = unconfiguredLoader;
  bundleLoader = unconfiguredLoader;
}
