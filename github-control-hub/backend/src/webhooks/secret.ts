import { awsRegion } from "../utils/region";

/**
 * One Secrets Manager fetch per container, serving both handlers.
 *
 * The receiver needs GITHUB_WEBHOOK_SECRET on the hot path; the worker needs
 * the whole bundle in process.env. Fetching per delivery would add latency
 * against GitHub's ten-second budget, cost a call per invocation, and make
 * every webhook depend on an API the work account restricts by SCP.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * The floor between refetches. Without it, a stream of bad signatures becomes
 * a stream of Secrets Manager calls.
 */
const REFETCH_FLOOR_MS = 60 * 1000;

/** Keys the app expects to find in the secret. Same list standalone.ts used. */
const SECRET_KEYS = [
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SYSTEM_GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET", "GITHUB_ORG", "JWT_SECRET",
  "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID",
] as const;

type Bundle = Record<string, string>;

let cached: Bundle | null = null;
let cachedAt = 0;
let lastFetchAt = 0;
let lastRefetchAt = 0;

async function loadFromSecretsManager(): Promise<Bundle> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: awsRegion() });
  const name = process.env.SECRET_NAME
    || `${process.env.STACK_NAME || "github-control-hub"}/secrets`;
  const result = await client.send(new GetSecretValueCommand({ SecretId: name }));
  return result.SecretString ? (JSON.parse(result.SecretString) as Bundle) : {};
}

let loader: () => Promise<Bundle> = loadFromSecretsManager;

async function fetchBundle(): Promise<void> {
  lastFetchAt = Date.now();
  try {
    cached = await loader();
    cachedAt = Date.now();
  } catch (err) {
    // A transient failure is not a reason to discard a working secret. An
    // absent secret still yields "" below, so this stays fail-closed.
    console.error("[Webhook] Could not load secrets:", (err as Error).message);
  }
}

async function getBundle(): Promise<Bundle> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  await fetchBundle();
  return cached ?? {};
}

export async function getWebhookSecret(): Promise<string> {
  return (await getBundle()).GITHUB_WEBHOOK_SECRET || "";
}

/**
 * Re-read after a signature failed to verify.
 *
 * The cache would otherwise mean up to fifteen minutes of rejected deliveries
 * after the webhook secret is rotated, and rejected deliveries are lost rather
 * than queued. This bounds a rotation to roughly one lost delivery.
 */
export async function refetchWebhookSecret(): Promise<string> {
  if (Date.now() - lastRefetchAt < REFETCH_FLOOR_MS) {
    return cached?.GITHUB_WEBHOOK_SECRET || "";
  }
  lastRefetchAt = Date.now();
  await fetchBundle();
  return cached?.GITHUB_WEBHOOK_SECRET || "";
}

/** The worker's bootstrap: the same values standalone.ts put in the environment. */
export async function loadSecretsIntoEnv(): Promise<void> {
  const bundle = await getBundle();
  for (const key of SECRET_KEYS) {
    if (bundle[key] && !process.env[key]) process.env[key] = bundle[key];
  }
}

// ── test seams ──
export function __setSecretLoaderForTests(fn: () => Promise<Bundle>): void {
  loader = fn;
}
export function __resetSecretCacheForTests(opts?: { keepValue?: boolean }): void {
  if (!opts?.keepValue) cached = null;
  cachedAt = 0;
  lastFetchAt = 0;
  lastRefetchAt = 0;
}
