# Webhooks on API Gateway and Lambda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive GitHub webhooks through API Gateway and Lambda instead of an EC2 instance the work account's VPC cannot route to, then delete the instance.

**Architecture:** A REST API (chosen over HTTP API because only REST supports resource policies, which is how the GitHub IP allow-list survives) invokes a receiver Lambda that verifies the HMAC and enqueues to SQS. A worker Lambda drains the queue and runs the processing logic that today lives in the Express route. The split exists so the internet-facing function holds nothing but one secret and one queue.

**Tech Stack:** TypeScript, AWS CDK v2 (`aws-cdk-lib` ^2.170.0), Lambda `NODEJS_24_X`, SQS, DynamoDB, API Gateway REST v1. Tests are standalone `repro-*.ts` scripts run with `tsx` — no framework.

**Spec:** `docs/superpowers/specs/2026-08-13-webhook-lambda-migration-design.md`

**Branch:** `webhooks-on-lambda`

## Global Constraints

- Webhook HMAC verification fails closed. No secret means accept nothing. `if (!secret) return false` must survive verbatim — `repro-appsec.ts` asserts on that exact string.
- Signature comparison uses `crypto.timingSafeEqual`, never `===`.
- The HMAC is computed over raw bytes. Nothing may `JSON.parse` and re-serialise before verification.
- Secrets are never Lambda environment variables. Table names are.
- The desktop app must not change. OAuth callback stays `http://localhost:4321/auth/callback`.
- Same DynamoDB tables, same Secrets Manager secret, same activity rows.
- `repro-appsec.ts` and `repro-leastprivilege.ts` may be repointed and strengthened, never weakened.
- Path is `/webhooks/github` (no `/api` prefix).
- Worker timeout 600s, queue visibility 660s, lease 660s, done-marker TTL 900s, `maxReceiveCount` 5, event source `maxConcurrency` 5, worker reserved concurrency 5, batch size 1. The done-marker is longer than the lease on purpose — see Task 3.
- Verification bar before any milestone is claimed done: every `repro-*.ts` exits 0, plus `npx tsc --noEmit` in `backend`, `frontend`, `desktop`, `infra`.
- Commit messages are declarative sentences explaining *why*. End with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Do not push to `main`. Do not deploy. Deploys and GitHub webhook changes are run by the user, who pastes back output.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `backend/src/webhooks/verify.ts` | Raw-byte extraction and HMAC comparison. Pure; no AWS, no Express, no Lambda. |
| `backend/src/webhooks/secret.ts` | One cached Secrets Manager fetch, serving both the webhook secret and the worker's env bootstrap. |
| `backend/src/webhooks/deliveryLock.ts` | Claim / complete / release against DynamoDB. |
| `backend/src/webhooks/processDelivery.ts` | The event-handling logic moved out of the Express route. |
| `backend/src/webhooks/receiver.ts` | API Gateway handler. |
| `backend/src/webhooks/worker.ts` | SQS handler. |
| `backend/repro-webhookdelivery.ts` | New test suite. |

**Modified:** `backend/package.json`, `backend/src/server.ts`, `infra/cdk-stack.ts`, `backend/repro-appsec.ts`, `backend/repro-leastprivilege.ts`, and the docs listed in Task 11.

**Deleted (Phase 2):** `backend/src/routes/webhooks.ts`, `backend/src/standalone.ts`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `scripts/deploy.sh`, `docs/infrastructure/ec2.md`.

## Phases

**Phase 1 (Tasks 1–8)** adds the new path with the instance still standing. Ends at a deployable milestone the user verifies in the personal account.

**Phase 2 (Tasks 9–11)** deletes the instance. Ends at a second deployable milestone.

---

## Task 1: Signature verification over raw bytes

This is first because base64 handling is the single most likely way the migration fails silently, and it fails looking exactly like a wrong secret.

**Files:**
- Create: `github-control-hub/backend/src/webhooks/verify.ts`
- Create: `github-control-hub/backend/repro-webhookdelivery.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `rawBodyBytes(body: string | undefined, isBase64Encoded: boolean): Buffer` and `verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `github-control-hub/backend/repro-webhookdelivery.ts`:

```ts
/**
 * Regression test: webhook delivery handling under Lambda.
 *
 * The HMAC is computed over the exact bytes GitHub sent. API Gateway may hand
 * Lambda a base64-encoded body, and anything that parses and re-serialises the
 * payload before verification breaks every signature — while looking exactly
 * like a misconfigured secret, which is the wrong thing to go and check.
 */
import crypto from "crypto";
import { rawBodyBytes, verifyGitHubSignature } from "./src/webhooks/verify";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const SECRET = "it's a secret to everybody";
// A payload with non-ASCII bytes: a multi-byte character encodes differently
// under utf8 and base64, so a mistake in the encoding branch shows up here and
// would not show up on a plain-ASCII fixture.
const PAYLOAD = JSON.stringify({ repository: { name: "café-service" }, action: "created" });
const sign = (body: string) =>
  `sha256=${crypto.createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;

/**
 * Source with comments removed.
 *
 * Assertions below look for the absence of things, and prose explaining why a
 * thing is absent contains the thing. Same helper, same reason, as
 * repro-appsec.ts.
 */
const code = (src: string) => src
  .split("\n")
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s*\/\/.*$/, ""))
  .join("\n");

// Wrapped in an async IIFE from the start: later blocks in this file use
// `await import` to load modules after setting the environment they read.
(async () => {

// ── the signature verifies whichever way API Gateway encoded the body ──
{
  const sig = sign(PAYLOAD);

  const utf8 = rawBodyBytes(PAYLOAD, false);
  check("a UTF-8 body verifies", verifyGitHubSignature(utf8, sig, SECRET));

  const b64 = rawBodyBytes(Buffer.from(PAYLOAD, "utf8").toString("base64"), true);
  check("a base64 body verifies", verifyGitHubSignature(b64, sig, SECRET));

  check("  and both decode to identical bytes", utf8.equals(b64));
}

// ── forgery and misconfiguration ──
{
  const sig = sign(PAYLOAD);
  const tampered = PAYLOAD.replace("café-service", "evil-service");
  check("a tampered payload is rejected",
    !verifyGitHubSignature(rawBodyBytes(tampered, false), sig, SECRET));

  check("an absent secret rejects everything",
    !verifyGitHubSignature(rawBodyBytes(PAYLOAD, false), sig, ""),
    "no secret would accept anything");

  check("an absent signature header is rejected",
    !verifyGitHubSignature(rawBodyBytes(PAYLOAD, false), undefined, SECRET));

  check("a malformed signature header is rejected rather than throwing",
    !verifyGitHubSignature(rawBodyBytes(PAYLOAD, false), "garbage", SECRET));

  check("a signature for a different secret is rejected",
    !verifyGitHubSignature(rawBodyBytes(PAYLOAD, false),
      `sha256=${crypto.createHmac("sha256", "wrong").update(PAYLOAD).digest("hex")}`, SECRET));
}

// Later tasks append their blocks here, inside the IIFE.

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
})();
```

The `code` helper is unused in this task — Task 4 is its first consumer. Leave
it in place rather than deleting and re-adding it.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: FAIL — `Cannot find module './src/webhooks/verify'`.

- [ ] **Step 3: Write minimal implementation**

Create `github-control-hub/backend/src/webhooks/verify.ts`:

```ts
import crypto from "crypto";

/**
 * The bytes GitHub signed, whatever encoding API Gateway wrapped them in.
 *
 * The signature covers the request body exactly as sent. API Gateway may
 * base64-encode it, so the flag decides the decoding — and nothing may parse
 * and re-serialise the payload before this runs, because a re-serialised body
 * is a different sequence of bytes and every signature fails.
 */
export function rawBodyBytes(body: string | undefined, isBase64Encoded: boolean): Buffer {
  return Buffer.from(body ?? "", isBase64Encoded ? "base64" : "utf8");
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;

  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws when the lengths differ, which is what a
    // malformed header looks like.
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add github-control-hub/backend/src/webhooks/verify.ts github-control-hub/backend/repro-webhookdelivery.ts
git commit -m "$(cat <<'EOF'
Verify webhook signatures against bytes rather than a re-encoded payload

API Gateway may hand Lambda a base64-encoded body. Deciding the encoding at
the boundary, and comparing before anything parses the payload, is what stops
a correct secret presenting as a wrong one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The cached secret

**Files:**
- Create: `github-control-hub/backend/src/webhooks/secret.ts`
- Modify: `github-control-hub/backend/repro-webhookdelivery.ts` (append)

**Interfaces:**
- Consumes: `awsRegion()` from `../utils/region`.
- Produces: `getWebhookSecret(): Promise<string>`, `refetchWebhookSecret(): Promise<string>`, `loadSecretsIntoEnv(): Promise<void>`, and the test seams `__setSecretLoaderForTests(fn)` / `__resetSecretCacheForTests()`.

One module fetches the secret bundle once per container. The receiver reads one key out of it; the worker copies nine keys into `process.env`. Two Secrets Manager calls for the same JSON would be wasteful and would double the exposure to the work account's SCP.

- [ ] **Step 1: Write the failing test**

Append to `github-control-hub/backend/repro-webhookdelivery.ts`, immediately **before** the final `console.log`/`process.exit` lines:

```ts
// ── the secret is cached, and a rotation costs one delivery not fifteen minutes ──
{
  const { getWebhookSecret, refetchWebhookSecret,
          __setSecretLoaderForTests, __resetSecretCacheForTests } = await import("./src/webhooks/secret");

  let calls = 0;
  let live = "first-secret";
  __resetSecretCacheForTests();
  __setSecretLoaderForTests(async () => { calls++; return { GITHUB_WEBHOOK_SECRET: live }; });

  check("the first read fetches", (await getWebhookSecret()) === "first-secret" && calls === 1, calls);
  await getWebhookSecret();
  await getWebhookSecret();
  check("  and subsequent reads do not", calls === 1, calls);

  // The secret is rotated in Secrets Manager. The cache is now wrong, and
  // rejected deliveries are lost rather than queued.
  live = "rotated-secret";
  check("a refetch after a failed verification picks up the rotation",
    (await refetchWebhookSecret()) === "rotated-secret");

  // A stream of bad signatures must not become a stream of Secrets Manager calls.
  const before = calls;
  await refetchWebhookSecret();
  await refetchWebhookSecret();
  check("  but refetches are floored so bad signatures cannot amplify",
    calls === before, calls);
}

// ── a transient Secrets Manager failure does not discard a working secret ──
{
  const { getWebhookSecret, __setSecretLoaderForTests, __resetSecretCacheForTests } =
    await import("./src/webhooks/secret");

  __resetSecretCacheForTests();
  __setSecretLoaderForTests(async () => ({ GITHUB_WEBHOOK_SECRET: "good" }));
  await getWebhookSecret();

  __setSecretLoaderForTests(async () => { throw new Error("throttled"); });
  __resetSecretCacheForTests({ keepValue: true });
  check("a fetch failure keeps the last known secret", (await getWebhookSecret()) === "good");

  __resetSecretCacheForTests();
  check("  but no secret at all still fails closed", (await getWebhookSecret()) === "");
}
```

The file is already wrapped in an async IIFE from Task 1, so `await import` is
legal here. No restructuring is needed — append inside the IIFE, above the
`console.log`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: FAIL — `Cannot find module './src/webhooks/secret'`.

- [ ] **Step 3: Write minimal implementation**

Create `github-control-hub/backend/src/webhooks/secret.ts`:

```ts
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
  if (Date.now() - lastFetchAt < REFETCH_FLOOR_MS) {
    return cached?.GITHUB_WEBHOOK_SECRET || "";
  }
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
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add github-control-hub/backend/src/webhooks/secret.ts github-control-hub/backend/repro-webhookdelivery.ts
git commit -m "$(cat <<'EOF'
Bound a webhook secret rotation to one lost delivery instead of fifteen minutes

Caching the secret per container is what keeps the receiver off Secrets Manager
on the hot path, but a cache that long would silently reject every delivery
until it expired — and rejected deliveries are lost, not queued. Refetching
once after a verification failure, with a floor so bad signatures cannot
amplify into API calls, gets both.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The delivery lock

**Files:**
- Create: `github-control-hub/backend/src/webhooks/deliveryLock.ts`
- Modify: `github-control-hub/backend/repro-webhookdelivery.ts` (append)

**Interfaces:**
- Consumes: `docClient`, `tableName`, `PutCommand`, `DeleteCommand` from `../utils/dynamo`.
- Produces: `claimDelivery(deliveryId: string): Promise<boolean>`, `completeDelivery(deliveryId: string): Promise<void>`, `releaseDelivery(deliveryId: string): Promise<void>`.

Replaces the in-memory `Map`, which does nothing across Lambda invocations. It lives in the worker because SQS standard queues are at-least-once, so deduplication is needed whether or not GitHub ever replays.

- [ ] **Step 1: Write the failing test**

Append inside the async IIFE of `repro-webhookdelivery.ts`, before the final `console.log`:

```ts
// ── replay protection survives across invocations, and a failure is retryable ──
{
  process.env.WEBHOOK_DELIVERIES_TABLE = "test-deliveries";
  const { docClient } = await import("./src/utils/dynamo");
  const { claimDelivery, completeDelivery, releaseDelivery } =
    await import("./src/webhooks/deliveryLock");

  // An in-memory stand-in implementing the conditional-put semantics the lock
  // depends on. Running this against real DynamoDB would need an account.
  const store = new Map<string, any>();
  (docClient as any).send = async (cmd: any) => {
    const kind = cmd.constructor.name;
    if (kind === "PutCommand") {
      const item = cmd.input.Item;
      if (cmd.input.ConditionExpression) {
        const existing = store.get(item.deliveryId);
        const now = cmd.input.ExpressionAttributeValues[":now"];
        if (existing && existing.expiresAt >= now) {
          const e: any = new Error("conditional check failed");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
      }
      store.set(item.deliveryId, item);
      return {};
    }
    if (kind === "DeleteCommand") { store.delete(cmd.input.Key.deliveryId); return {}; }
    throw new Error(`unexpected command: ${kind}`);
  };

  check("a delivery can be claimed", (await claimDelivery("d-1")) === true);
  check("  and a second claim on the same id is refused", (await claimDelivery("d-1")) === false);

  await completeDelivery("d-1");
  check("  a completed delivery stays claimed within the replay window",
    (await claimDelivery("d-1")) === false);

  // At-least-once means a successful delivery can be redelivered when its
  // deletion does not register, one visibility timeout (660s) later. A marker
  // that expired before then would let templates be applied a second time.
  check("  and the marker outlives the queue's visibility timeout",
    store.get("d-1").expiresAt - Math.floor(Date.now() / 1000) > 660,
    store.get("d-1").expiresAt - Math.floor(Date.now() / 1000));

  // A worker killed mid-delivery never releases its claim. Without an expiring
  // lease that event is lost permanently.
  await claimDelivery("d-2");
  const held = store.get("d-2");
  store.set("d-2", { ...held, expiresAt: Math.floor(Date.now() / 1000) - 1 });
  check("a claim whose lease expired can be re-taken", (await claimDelivery("d-2")) === true);

  await claimDelivery("d-3");
  await releaseDelivery("d-3");
  check("a released claim can be re-taken so SQS can retry", (await claimDelivery("d-3")) === true);
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: FAIL — `Cannot find module './src/webhooks/deliveryLock'`.

- [ ] **Step 3: Write minimal implementation**

Create `github-control-hub/backend/src/webhooks/deliveryLock.ts`:

```ts
import { docClient, tableName, PutCommand, DeleteCommand } from "../utils/dynamo";

/**
 * Replay protection, and the deduplication SQS requires of anything reading a
 * standard queue.
 *
 * The in-memory Map this replaces worked on a long-lived server and does
 * nothing across Lambda invocations.
 */

/**
 * How long a claim is held. Matches the queue's visibility timeout, so it
 * outlives the worker's own 600-second timeout — a lease equal to the function
 * timeout would expire at the moment a maximally slow invocation was still
 * running, letting a second worker claim a delivery the first had not released.
 */
const LEASE_SEC = 660;

/**
 * How long a completed delivery is remembered.
 *
 * Longer than the lease, which is the counter-intuitive part. The obvious value
 * is 300 — the replay window the in-memory Map used — and it is wrong here: a
 * worker can succeed and have the message deletion not register, which is
 * ordinary at-least-once behavior, and the redelivery arrives one visibility
 * timeout later at 660 seconds. A 300-second marker has expired by then, so the
 * delivery would be claimed again and its templates applied a second time.
 *
 * The cost is that a manual redelivery from GitHub's UI is ignored for fifteen
 * minutes rather than five.
 */
const DONE_SEC = 900;

function table(): string {
  return tableName("WEBHOOK_DELIVERIES_TABLE");
}

/**
 * Take the delivery, or report that someone already has it.
 *
 * The condition treats a logically expired row as absent, because DynamoDB's
 * TTL sweep is lazy and a row can outlive its own expiry by hours. Same
 * reasoning as the one-time auth codes in routes/auth.ts, expressed for a
 * conditional put rather than a delete.
 */
export async function claimDelivery(deliveryId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await docClient.send(new PutCommand({
      TableName: table(),
      Item: { deliveryId, state: "processing", expiresAt: now + LEASE_SEC, ttl: now + LEASE_SEC },
      ConditionExpression: "attribute_not_exists(deliveryId) OR expiresAt < :now",
      ExpressionAttributeValues: { ":now": now },
    }));
    return true;
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function completeDelivery(deliveryId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await docClient.send(new PutCommand({
    TableName: table(),
    Item: { deliveryId, state: "done", expiresAt: now + DONE_SEC, ttl: now + DONE_SEC },
  }));
}

/** Hand the delivery back so SQS's retry can re-take it. */
export async function releaseDelivery(deliveryId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: table(), Key: { deliveryId } }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add github-control-hub/backend/src/webhooks/deliveryLock.ts github-control-hub/backend/repro-webhookdelivery.ts
git commit -m "$(cat <<'EOF'
Give a killed worker's delivery a way back rather than losing it forever

Replay protection was an in-memory Map, which does nothing once each delivery
may land in a different container. Moving it to DynamoDB raises a question the
Map never had: a claim held by a worker that timed out mid-delivery would never
be released. The claim is therefore a lease that outlives the function timeout
and then expires.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extract the processing logic

**Files:**
- Create: `github-control-hub/backend/src/webhooks/processDelivery.ts`
- Read for reference: `github-control-hub/backend/src/routes/webhooks.ts` (deleted in Task 9, left in place for now)
- Modify: `github-control-hub/backend/repro-webhookdelivery.ts` (append)

**Interfaces:**
- Consumes: every service the current route imports, unchanged.
- Produces:
  ```ts
  export interface Delivery {
    event: string;
    deliveryId: string;
    payload: any;
    token: string;
  }
  export async function processDelivery(d: Delivery): Promise<void>;
  export async function awaitBackground(tasks: Promise<unknown>[], ceilingMs?: number): Promise<void>;
  ```
  `awaitBackground` is exported for the test in Step 1, not because anything
  else calls it.

This is a move, not a rewrite. Copy `routes/webhooks.ts` lines 62–361 (the router callback body) and apply exactly the changes below. Do not restructure the event handling — every `createAlert`, `logActivity` and `applyTemplate` call keeps its current arguments and order.

**The changes, in full:**

1. Drop the imports of `Router`, `Request`, `Response`, `crypto`, and `getSystemToken`. Keep every service import. Add `getOrg` (still used).
2. Delete lines 15–60 entirely — `sanitizeField` moves across unchanged, but `getWebhookSecret`, `verifySignature`, `DELIVERY_TTL_MS`, `processedDeliveries` and `isDuplicateDelivery` do not. **Keep `sanitizeField`.**
3. Replace the handler signature:
   ```ts
   // was: router.post("/github", async (req: Request, res: Response) => {
   export async function processDelivery({ event, payload, token }: Delivery): Promise<void> {
   ```
4. Delete the signature check (lines 63–66), the delivery-id check (lines 69–72), and the two lines reading `event` and `payload` off the request (74–75).
5. Delete `res.status(202).send("Accepted");` (line 178).
6. Replace every `getSystemToken()` with `token`. Occurrences: lines 182, 183, 277, 279, 337, 342.
7. Line 298 becomes `token` directly — there is no `req.user` in Lambda:
   ```ts
   // was: const token = getSystemToken() || (req as any).user?.accessToken;
   //      (and the `if (token)` guard around addRepoEdges)
   ```
   Fold into the background-work block below.
8. Replace the whole tail from line 270 (`const shouldRefreshCompliance =`) to the end with the block in Step 3.
9. Close with `}` instead of `});`, and drop `export default router;`.

- [ ] **Step 1: Write the failing test**

Append inside the async IIFE of `repro-webhookdelivery.ts`, before the final `console.log`:

```ts
// ── work that outlived the HTTP response must now be awaited ──
//
// On Express the process outlives the request, so refreshRepo, addRepoEdges and
// the scan timer were deliberately not awaited. In Lambda the container freezes
// when the handler resolves: activity rows and template auto-apply would keep
// working because those are awaited, while compliance refresh, new-repo graph
// edges and scanner runs silently stopped. A partial success reports nothing.
{
  const fs = await import("fs");
  const nodePath = await import("path");
  // Comments stripped. The implementation explains in prose why getSystemToken
  // is absent, and that prose contains "getSystemToken()" — asserting against
  // raw source would fail on the comment justifying the very absence it
  // asserts. Same trap, same fix, as repro-appsec.ts.
  const src = code(fs.readFileSync(
    nodePath.join(__dirname, "src", "webhooks", "processDelivery.ts"), "utf8"));

  check("scans are not scheduled on a timer",
    !/setTimeout\(async/.test(src),
    "a one-second timer may never fire in a frozen container");

  check("  and the GitHub token is a parameter",
    !/getSystemToken\(\)/.test(src),
    "the sync getter returns a stale token on a warm container");

  // The next three are behavioral rather than textual, because they are the
  // ones whose regression reads like a tidy-up.
  const { awaitBackground } = await import("./src/webhooks/processDelivery");

  let settled = false;
  await awaitBackground([
    (async () => { await new Promise(r => setTimeout(r, 10)); settled = true; })(),
  ]);
  check("background work is awaited, not abandoned", settled);

  // A flaky scanner must not throw out of processDelivery: the worker would
  // release its claim, SQS would redeliver, and templates would be applied
  // again — up to five times.
  let threw = false;
  try {
    await awaitBackground([Promise.reject(new Error("scanner exploded"))]);
  } catch { threw = true; }
  check("  a rejecting task does not fail the delivery", !threw,
    "Promise.all here would arm a redelivery loop that re-applies templates");

  // And work that hangs must not carry the invocation past its timeout, which
  // would kill it before completeDelivery ran and redeliver by another route.
  const started = Date.now();
  await awaitBackground([new Promise(() => {})], 50);
  check("  work that hangs is abandoned at the ceiling", Date.now() - started < 1000);
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `github-control-hub/backend/src/webhooks/processDelivery.ts` by applying changes 1–9 above. The header and the replacement tail, verbatim:

```ts
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { runScan, listScanners } from "../services/scannerService";
import { createAlert, autoResolveAlerts } from "../services/alertService";
import { logActivity, updateActivityOutcome } from "../services/activityService";
import { listTemplates, applyTemplate } from "../services/templateService";
import { resolveExcludedReposFromIds } from "../services/exclusionService";
import { refreshRepo } from "../services/complianceCacheService";
import {
  addBranchEdge, removeBranchEdge, updateBranchProtection,
  addCollaboratorEdge, removeCollaboratorEdge, addRepoEdges,
} from "../services/graphEdgeService";

export interface Delivery {
  event: string;
  deliveryId: string;
  payload: any;
  /**
   * Resolved once per invocation by the worker rather than read from the
   * module singleton. Lambda freezes containers between invocations, so the
   * refresh timer behind the synchronous getSystemToken() does not fire on
   * schedule — a warm container would serve a cached token until it expired
   * and then fall back to SYSTEM_GITHUB_TOKEN, stopping auto-apply with
   * "No GitHub token available" on some containers and not others.
   */
  token: string;
}

/** Strip characters that could be used for XSS when reflected in the frontend. */
function sanitizeField(val: string | undefined, maxLen = 200): string {
  if (!val || typeof val !== "string") return "";
  return val.replace(/[<>"'&]/g, "").slice(0, maxLen);
}

/** How long the best-effort enrichment may take before it is abandoned. */
const BACKGROUND_CEILING_MS = 4 * 60 * 1000;

/**
 * Wait for the best-effort work, but never fail on it and never wait forever.
 *
 * Both halves matter, and both protect the same thing. If a rejecting task
 * could throw out of processDelivery, the worker would release its claim, SQS
 * would redeliver, and the delivery would be reprocessed — re-applying
 * templates and writing a second set of template.apply rows, up to five times.
 * Promise.allSettled is what prevents that, so it is not interchangeable with
 * Promise.all however much tidier that looks.
 *
 * The ceiling prevents the same outcome arriving as a timeout instead: work
 * that runs long carries the invocation past its limit, Lambda kills it,
 * completeDelivery never runs, the lease expires and SQS redelivers.
 *
 * Abandoning a scan costs a stale compliance cache until the next event for
 * that repository. Abandoning an invocation costs a repository having its
 * templates applied twice.
 */
export async function awaitBackground(
  tasks: Promise<unknown>[],
  ceilingMs: number = BACKGROUND_CEILING_MS,
): Promise<void> {
  if (tasks.length === 0) return;

  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[Webhook] Background work exceeded ${ceilingMs}ms — abandoning it so the delivery can be marked done`);
      resolve();
    }, ceilingMs);
  });

  try {
    await Promise.race([Promise.allSettled(tasks).then(() => undefined), ceiling]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function processDelivery({ event, payload, token }: Delivery): Promise<void> {
  console.log(`[Webhook] Received GitHub event: ${event}`);

  // ... lines 79–177 of routes/webhooks.ts, verbatim ...
  // ... then the auto-apply block, lines 181–268, with getSystemToken() → token ...
```

and the tail that replaces lines 270–361:

```ts
  // Work that used to outlive the HTTP response.
  //
  // In Lambda the container freezes when this function resolves, so an
  // unawaited promise may never settle and a one-second timer may never fire.
  // These are collected rather than awaited in place so that one failing does
  // not prevent the others from running — which is what the bare .catch()
  // handlers gave us before.
  const background: Promise<unknown>[] = [];

  const shouldRefreshCompliance =
    event === "branch_protection_rule" ||
    event === "repository_ruleset" ||
    event === "member" ||
    (event === "repository" && payload.action === "created") ||
    (event === "push" && payload.ref === `refs/heads/${payload.repository?.default_branch}`);

  if (repoName && token && shouldRefreshCompliance) {
    console.log(`[Webhook] Refreshing compliance cache for ${repoName}`);
    background.push(refreshRepo(token, repoName).catch((err) =>
      console.error(`[Webhook] Compliance refresh failed for ${repoName}:`, (err as Error).message)
    ));
  }

  // Incremental graph edge updates
  const org = getOrg();
  try {
    if (event === "create" && payload.ref_type === "branch" && repoName && payload.ref) {
      console.log(`[Webhook] Adding graph edge: branch "${payload.ref}" in ${repoName}`);
      await addBranchEdge(repoName, payload.ref, false);
    }

    if (event === "delete" && payload.ref_type === "branch" && repoName && payload.ref) {
      console.log(`[Webhook] Removing graph edge: branch "${payload.ref}" from ${repoName}`);
      await removeBranchEdge(repoName, payload.ref);
    }

    if (event === "repository" && payload.action === "created" && repoName && token) {
      console.log(`[Webhook] Adding all graph edges for new repo "${repoName}"`);
      background.push(addRepoEdges(token, org, repoName).catch((err) =>
        console.error(`[Webhook] Graph edge sync failed for new repo ${repoName}:`, (err as Error).message)
      ));
    }

    if (event === "member" && repoName && payload.member?.login) {
      const user = payload.member.login;
      if (payload.action === "added") {
        const role = payload.changes?.permission?.to || "read";
        console.log(`[Webhook] Adding graph edge: collaborator "${user}" on ${repoName}`);
        await addCollaboratorEdge(repoName, user, role);
      } else if (payload.action === "removed") {
        console.log(`[Webhook] Removing graph edge: collaborator "${user}" from ${repoName}`);
        await removeCollaboratorEdge(repoName, user);
      }
    }

    if (event === "branch_protection_rule" && repoName) {
      const branchName = payload.rule?.name;
      if (branchName) {
        const isProtected = payload.action !== "deleted";
        console.log(`[Webhook] Updating graph edge: branch "${branchName}" protection=${isProtected} in ${repoName}`);
        await updateBranchProtection(repoName, branchName, isProtected);
      }
    }
  } catch (graphErr) {
    console.error(`[Webhook] Graph edge update failed:`, (graphErr as Error).message);
  }

  // Background compliance scans.
  //
  // The one-second setTimeout this replaces existed to let the HTTP response
  // go out first. There is no response to get out of the way of here.
  if (repoName) {
    console.log(`[Webhook] Scheduling compliance scan for repository: ${repoName}`);
    background.push((async () => {
      try {
        if (!token) {
          console.warn("[Webhook] No GitHub token available. Cannot run automated background scan.");
          return;
        }
        const octokit = new Octokit({ auth: token });
        const scanners = await listScanners();
        const relevantScanners = scanners.filter(s =>
          s.targetRepos === "all" ||
          (Array.isArray(s.targetRepos) && s.targetRepos.includes(repoName!)) ||
          s.includeFutureRepos
        );
        for (const scanner of relevantScanners) {
          console.log(`[Webhook] Running scanner '${scanner.name}' against repo '${repoName}'`);
          await runScan(octokit, scanner.id, [repoName!]);
        }
      } catch (err) {
        console.error(`[Webhook] Error executing background tasks for ${repoName}:`, err);
      }
    })());
  }

  await awaitBackground(background);
}
```

- [ ] **Step 4: Run tests and the compiler**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts && npx tsc --noEmit
```

Expected: `ALL PASS` and no type errors. `routes/webhooks.ts` still exists and still compiles at this point.

- [ ] **Step 5: Commit**

```bash
git add github-control-hub/backend/src/webhooks/processDelivery.ts github-control-hub/backend/repro-webhookdelivery.ts
git commit -m "$(cat <<'EOF'
Await the webhook work that used to outlive the HTTP response

Three calls were deliberately unawaited because on Express the process outlives
the request. A Lambda container freezes the moment the handler resolves, so
compliance refresh, new-repo graph edges and scanner runs would have stopped
while activity rows and template auto-apply kept working — a partial success
that reports nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The receiver handler

**Files:**
- Create: `github-control-hub/backend/src/webhooks/receiver.ts`
- Modify: `github-control-hub/backend/package.json`
- Modify: `github-control-hub/backend/repro-webhookdelivery.ts` (append)

**Interfaces:**
- Consumes: `rawBodyBytes`, `verifyGitHubSignature` (Task 1); `getWebhookSecret`, `refetchWebhookSecret` (Task 2).
- Produces: `handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult>`.

- [ ] **Step 1: Add the two missing dependencies**

```bash
cd github-control-hub/backend
npm install --save @aws-sdk/client-sqs@^3.1108.0
npm install --save-dev @types/aws-lambda@^8.10.152
```

Neither is currently in `package.json`. `@aws-sdk/client-sqs` is a runtime dependency because the receiver bundles it; `@types/aws-lambda` is types only.

- [ ] **Step 2: Write the failing test**

Append inside the async IIFE, before the final `console.log`:

```ts
// ── nothing reaches the queue that did not verify ──
{
  process.env.WEBHOOK_QUEUE_URL = "https://sqs.test/queue";
  const { __setSecretLoaderForTests, __resetSecretCacheForTests } =
    await import("./src/webhooks/secret");
  __resetSecretCacheForTests();
  __setSecretLoaderForTests(async () => ({ GITHUB_WEBHOOK_SECRET: SECRET }));

  const { handler, __setQueueSenderForTests } = await import("./src/webhooks/receiver");

  const sent: string[] = [];
  __setQueueSenderForTests(async (body: string) => { sent.push(body); });

  const evt = (body: string, sig: string | undefined, b64 = false) => ({
    body: b64 ? Buffer.from(body, "utf8").toString("base64") : body,
    isBase64Encoded: b64,
    headers: {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "delivery-abc",
      "X-GitHub-Event": "repository",
    },
  }) as any;

  const good = await handler(evt(PAYLOAD, sign(PAYLOAD)));
  check("a signed delivery is accepted", good.statusCode === 202, good.statusCode);
  check("  and is queued", sent.length === 1, sent.length);
  check("  with the delivery id and event carried through", (() => {
    const msg = JSON.parse(sent[0]);
    return msg.deliveryId === "delivery-abc" && msg.event === "repository"
        && msg.payload.repository.name === "café-service";
  })());

  sent.length = 0;
  const bad = await handler(evt(PAYLOAD, "sha256=deadbeef"));
  check("an unsigned delivery is rejected", bad.statusCode === 401, bad.statusCode);
  check("  and nothing is queued", sent.length === 0, sent.length);

  sent.length = 0;
  const b64ok = await handler(evt(PAYLOAD, sign(PAYLOAD), true));
  check("a base64-encoded delivery is accepted end to end", b64ok.statusCode === 202, b64ok.statusCode);
  check("  and is queued", sent.length === 1, sent.length);

  // Header casing is not guaranteed by API Gateway's v1 payload format.
  sent.length = 0;
  const lower = await handler({
    body: PAYLOAD, isBase64Encoded: false,
    headers: {
      "x-hub-signature-256": sign(PAYLOAD),
      "x-github-delivery": "delivery-xyz",
      "x-github-event": "push",
    },
  } as any);
  check("lower-cased headers are found", lower.statusCode === 202, lower.statusCode);
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: FAIL — `Cannot find module './src/webhooks/receiver'`.

- [ ] **Step 4: Write the implementation**

Create `github-control-hub/backend/src/webhooks/receiver.ts`:

```ts
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { awsRegion } from "../utils/region";
import { rawBodyBytes, verifyGitHubSignature } from "./verify";
import { getWebhookSecret, refetchWebhookSecret } from "./secret";

/**
 * The internet-facing half.
 *
 * It verifies the signature and puts the delivery on a queue, and that is all
 * it can do: its IAM grants one secret and one queue. Everything with real
 * privileges runs in the worker, which nothing on the internet can reach.
 */

type Sender = (body: string) => Promise<void>;

let send: Sender = async (body: string) => {
  const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
  const client = new SQSClient({ region: awsRegion() });
  await client.send(new SendMessageCommand({
    QueueUrl: process.env.WEBHOOK_QUEUE_URL,
    MessageBody: body,
  }));
};

function header(headers: Record<string, unknown> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const raw = rawBodyBytes(event.body ?? undefined, event.isBase64Encoded === true);
  const signature = header(event.headers, "x-hub-signature-256");

  // A rotated secret would otherwise reject every delivery until the cache
  // expired, and rejected deliveries are lost rather than queued.
  let ok = verifyGitHubSignature(raw, signature, await getWebhookSecret());
  if (!ok) ok = verifyGitHubSignature(raw, signature, await refetchWebhookSecret());

  if (!ok) {
    console.error("Webhook signature verification failed");
    return { statusCode: 401, body: "Unauthorized" };
  }

  const deliveryId = header(event.headers, "x-github-delivery");
  const githubEvent = header(event.headers, "x-github-event");
  if (!deliveryId || !githubEvent) {
    return { statusCode: 400, body: "Missing delivery headers" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { statusCode: 400, body: "Body is not JSON" };
  }

  await send(JSON.stringify({ deliveryId, event: githubEvent, payload }));

  return { statusCode: 202, body: "Accepted" };
}

// ── test seam ──
export function __setQueueSenderForTests(fn: Sender): void {
  send = fn;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts && npx tsc --noEmit
```

Expected: `ALL PASS`, no type errors.

- [ ] **Step 6: Commit**

```bash
git add github-control-hub/backend/src/webhooks/receiver.ts github-control-hub/backend/package.json github-control-hub/backend/package-lock.json github-control-hub/backend/repro-webhookdelivery.ts
git commit -m "$(cat <<'EOF'
Give the internet-facing function one secret and one queue and nothing else

Splitting reception from processing is not about Lambda's execution model — it
is about what the reachable half is allowed to do. This half can read the
webhook secret and write to a queue. The half holding eleven tables, the GitHub
App token and the ability to rewrite repositories has no path from the internet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The worker handler

**Files:**
- Create: `github-control-hub/backend/src/webhooks/worker.ts`
- Modify: `github-control-hub/backend/repro-webhookdelivery.ts` (append)

**Interfaces:**
- Consumes: `loadSecretsIntoEnv` (Task 2), `claimDelivery`/`completeDelivery`/`releaseDelivery` (Task 3), `processDelivery` (Task 4), `initTokenManager`/`getSystemTokenAsync` from `../github/client`.
- Produces: `handler(event: SQSEvent): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append inside the async IIFE, before the final `console.log`:

```ts
// ── a failed delivery is retryable, a duplicate is not reprocessed ──
{
  const src = await import("fs").then(fs =>
    fs.readFileSync(new URL("./src/webhooks/worker.ts", `file://${__filename}`), "utf8"));

  check("the worker claims before processing",
    src.indexOf("claimDelivery") < src.indexOf("processDelivery"));

  check("  releases the claim when processing throws",
    /releaseDelivery\(/.test(src) && /throw /.test(src),
    "a swallowed error would delete the message and lose the event");

  check("  and resolves the token once per invocation",
    /await getSystemTokenAsync\(\)/.test(src),
    "the synchronous getter returns a stale token on a warm container");

  check("  bootstrapping happens once per container",
    /bootstrapped/.test(src),
    "re-reading Secrets Manager per message wastes the warm container");
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Write the implementation**

Create `github-control-hub/backend/src/webhooks/worker.ts`:

```ts
import type { SQSEvent } from "aws-lambda";
import { initTokenManager, getSystemTokenAsync } from "../github/client";
import { loadSecretsIntoEnv } from "./secret";
import { claimDelivery, completeDelivery, releaseDelivery } from "./deliveryLock";
import { processDelivery } from "./processDelivery";

/**
 * The privileged half. Reachable only from the queue.
 */

let bootstrapped: Promise<void> | null = null;

/**
 * Once per container, not once per message. A warm container keeps both the
 * secrets and the App token, which is most of what makes this cheap.
 */
function bootstrapOnce(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await loadSecretsIntoEnv();
      if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
        try {
          await initTokenManager(
            process.env.GITHUB_APP_ID,
            process.env.GITHUB_APP_PRIVATE_KEY,
            process.env.GITHUB_APP_INSTALLATION_ID,
          );
          console.log("[Webhook] GitHub App token manager initialized");
        } catch (err) {
          console.error("[Webhook] GitHub App token manager failed to initialize:", (err as Error).message);
        }
      }
    })();
  }
  return bootstrapped;
}

export async function handler(event: SQSEvent): Promise<void> {
  await bootstrapOnce();

  // Resolved once per invocation rather than read from the module singleton.
  // The refresh timer behind the synchronous getter does not fire on schedule
  // in a frozen container, so this is what keeps the token live.
  const token = await getSystemTokenAsync();

  for (const record of event.Records) {
    const { deliveryId, event: githubEvent, payload } = JSON.parse(record.body);

    if (!(await claimDelivery(deliveryId))) {
      console.log(`[Webhook] Delivery ${deliveryId} is already handled — skipping`);
      continue;
    }

    try {
      await processDelivery({ event: githubEvent, deliveryId, payload, token });
      await completeDelivery(deliveryId);
    } catch (err) {
      // Hand the claim back before rethrowing, so SQS's retry can re-take it.
      // Swallowing this would delete the message and lose the event.
      await releaseDelivery(deliveryId);
      console.error(`[Webhook] Delivery ${deliveryId} failed:`, (err as Error).message);
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd github-control-hub/backend && npx tsx repro-webhookdelivery.ts && npx tsc --noEmit
```

Expected: `ALL PASS`, no type errors.

- [ ] **Step 5: Commit**

```bash
git add github-control-hub/backend/src/webhooks/worker.ts github-control-hub/backend/repro-webhookdelivery.ts
git commit -m "$(cat <<'EOF'
Resolve the GitHub token per invocation instead of trusting a frozen timer

getSystemToken() is kept warm by a setTimeout that Lambda's container freezing
prevents from firing on schedule. A warm container would serve the cached token
until it expired and then fall back to the PAT, so auto-apply would stop on some
containers and not others. Awaiting the async getter once per invocation makes
the timer irrelevant rather than depending on it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Infrastructure

**Files:**
- Modify: `github-control-hub/infra/cdk-stack.ts`

**Interfaces:**
- Consumes: the handlers from Tasks 5 and 6, by entry path.
- Produces: stack outputs `WebhookUrl` (replacing the EC2 one), `WebhookQueueUrl`, `WebhookDlqUrl`.

The EC2, its security group and its Elastic IP all stay in this task. They are removed in Task 10.

- [ ] **Step 1: Hoist the CIDR list**

Replace the inline array at `cdk-stack.ts:59-64` so the security group and the resource policy cannot drift apart:

```ts
// From https://api.github.com/meta → hooks. Nothing here detects a change:
// deliveries would begin returning 403 and the app's Activity page would read
// Stale within 72 hours. See docs/operations/troubleshooting.md.
const GITHUB_WEBHOOK_CIDRS = [
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20",
];
```

Declare it at module scope, above the class. Update the existing loop to `for (const cidr of GITHUB_WEBHOOK_CIDRS)`.

- [ ] **Step 2: Add the imports**

```ts
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as logs from "aws-cdk-lib/aws-logs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
```

- [ ] **Step 3: Add the webhook infrastructure**

Insert after the guardrail section, before `// ── Outputs ──`:

```ts
    // ── Webhooks ──
    //
    // The instance this replaces could not be reached at all in the work
    // account: that VPC has no internet gateway, so inbound from the internet
    // is impossible however the security group is written. API Gateway needs
    // no VPC ingress.

    // The only table CDK owns. The other eleven are created by
    // scripts/setup-aws-account.sh and deliberately stay outside
    // CloudFormation, so `cdk destroy` cannot take the activity log with it.
    // This one holds five-minute deduplication state and nothing else.
    const deliveriesTable = new dynamodb.Table(this, "WebhookDeliveries", {
      tableName: `${stackPrefix}-webhook-deliveries`,
      partitionKey: { name: "deliveryId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const webhookDlq = new sqs.Queue(this, "WebhookDlq", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    const webhookQueue = new sqs.Queue(this, "WebhookQueue", {
      // Must exceed the worker's own timeout.
      visibilityTimeout: cdk.Duration.minutes(11),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: webhookDlq,
        // Sized for throttling, not for processing failures: a throttled
        // invocation still increments a message's receive count, so a burst
        // could otherwise send messages to the DLQ that no worker ever saw.
        // AWS's own guidance is a minimum of five. Do not tidy this down.
        maxReceiveCount: 5,
      },
    });

    const webhookBundling = {
      externalModules: [],
      minify: false,
      sourceMap: true,
    };

    const receiverFn = new NodejsFunction(this, "WebhookReceiver", {
      functionName: `${stackPrefix}-webhook-receiver`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "webhooks", "receiver.ts"),
      handler: "handler",
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // Below GitHub's ten-second timeout on purpose: past that nobody is
      // listening for the response, so there is no value in still working.
      timeout: cdk.Duration.seconds(8),
      memorySize: 256,
      environment: {
        STACK_NAME: stackPrefix,
        SECRET_NAME: secretName,
        WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
      },
      bundling: webhookBundling,
    });

    // Two grants, and that is the whole of it. This function is the only thing
    // here reachable from the internet.
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadWebhookSecret",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
    }));
    webhookQueue.grantSendMessages(receiverFn);

    const workerFn = new NodejsFunction(this, "WebhookWorker", {
      functionName: `${stackPrefix}-webhook-worker`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "webhooks", "worker.ts"),
      handler: "handler",
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // Auto-apply waits five seconds for provisioning and then retries four
      // times, and the scanner runs that used to be unbounded background time
      // on a long-lived server now happen inside the invocation.
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      // Must be at least the event source's maxConcurrency below.
      reservedConcurrentExecutions: 5,
      environment: {
        STACK_NAME: stackPrefix,
        SECRET_NAME: secretName,
        ACTIVITY_TABLE: `${stackPrefix}-activity`,
        TEMPLATES_TABLE: `${stackPrefix}-templates`,
        SCANNERS_TABLE: `${stackPrefix}-scanners`,
        ALERTS_TABLE: `${stackPrefix}-alerts`,
        ORG_CONFIG_TABLE: `${stackPrefix}-org-config`,
        GRAPH_EDGES_TABLE: `${stackPrefix}-graph-edges`,
        EXCLUSIONS_TABLE: `${stackPrefix}-exclusions`,
        COMPLIANCE_CACHE_TABLE: `${stackPrefix}-compliance-cache`,
        RULE_TEMPLATES_TABLE: `${stackPrefix}-rule-templates`,
        WEBHOOK_DELIVERIES_TABLE: deliveriesTable.tableName,
      },
      bundling: webhookBundling,
    });

    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadAppSecrets",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
    }));

    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "AppTables",
      actions: [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query",
        "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
      ],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-*`],
    }));

    // Limited at the poller rather than at the function. Reserved concurrency
    // alone would let the event source keep scaling its polling and have the
    // surplus invocations throttled — and a throttled invocation still
    // increments the message's receive count, so the setting meant to protect
    // GitHub's rate limit would instead fill the dead-letter queue with
    // messages no worker ever saw.
    //
    // The rate limit is the reason any cap exists: createOctokit sets
    // onRateLimit to false, so a throttled GitHub call fails rather than
    // retrying.
    workerFn.addEventSource(new SqsEventSource(webhookQueue, {
      batchSize: 1,
      maxConcurrency: 5,
    }));

    const apiLogGroup = new logs.LogGroup(this, "WebhookApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const webhookApi = new apigateway.RestApi(this, "WebhookApi", {
      restApiName: `${stackPrefix}-webhooks`,
      description: "GitHub webhook receiver",
      // REST rather than HTTP API for one reason: HTTP APIs do not support
      // resource policies, and the IP allow-list is the resource policy.
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        // Deliberately no body. Payloads name repositories, people and teams.
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: apigateway.AccessLogField.contextRequestId(),
          sourceIp: apigateway.AccessLogField.contextIdentitySourceIp(),
          status: apigateway.AccessLogField.contextStatus(),
          latency: apigateway.AccessLogField.contextResponseLatency(),
        })),
      },
      // The allow-list the security group used to hold. Better here: API
      // Gateway evaluates this before the integration runs, so the code never
      // executes for a request from anywhere else.
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: { NotIpAddress: { "aws:SourceIp": GITHUB_WEBHOOK_CIDRS } },
          }),
        ],
      }),
    });

    webhookApi.root
      .addResource("webhooks")
      .addResource("github")
      .addMethod("POST", new apigateway.LambdaIntegration(receiverFn));

    // A queue nobody watches is a queue that quietly fills up. The guardrail
    // DLQ had this gap too, so it gets one as well.
    const alarmTopic = this.node.tryGetContext("alertEmail")
      ? new sns.Topic(this, "AlarmTopic", { displayName: `${stackPrefix} alarms` })
      : undefined;
    if (alarmTopic) {
      alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(this.node.tryGetContext("alertEmail")),
      );
    }

    for (const [id, queue, description] of [
      ["WebhookDlqAlarm", webhookDlq, "A webhook delivery failed five times and was dead-lettered"],
      ["GuardrailDlqAlarm", guardrailDlq, "A guardrail invocation failed and was dead-lettered"],
    ] as Array<[string, sqs.Queue, string]>) {
      const alarm = new cloudwatch.Alarm(this, id, {
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      if (alarmTopic) alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    }
```

- [ ] **Step 4: Replace the webhook URL output**

Replace the existing `WebhookUrl` output (`cdk-stack.ts:409-412`) and add two more:

```ts
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${webhookApi.url}webhooks/github`,
      description: "GitHub webhook payload URL — set this in the org's webhook settings",
    });

    new cdk.CfnOutput(this, "WebhookQueueUrl", {
      value: webhookQueue.queueUrl,
      description: "Queue between the receiver and the worker",
    });

    new cdk.CfnOutput(this, "WebhookDlqUrl", {
      value: webhookDlq.queueUrl,
      description: "Dead-letter queue for webhook deliveries that failed five times",
    });
```

- [ ] **Step 5: Verify it synthesises**

```bash
cd github-control-hub/infra && npx tsc --noEmit && npx cdk synth --quiet
```

Expected: no type errors; synth succeeds. If `maxConcurrency` is rejected as an unknown property on `SqsEventSourceProps`, the pinned `aws-cdk-lib` is older than the feature — report this rather than removing the property, because dropping it reintroduces the DLQ problem it exists to prevent.

`cdk synth` may require AWS credentials for the `Vpc.fromLookup`; if it fails on that alone, note it and move on — the user runs the real deploy.

- [ ] **Step 6: Commit**

```bash
git add github-control-hub/infra/cdk-stack.ts
git commit -m "$(cat <<'EOF'
Put the webhook endpoint somewhere the work account can actually route to

REST rather than HTTP API because only REST supports resource policies, and the
resource policy is how the GitHub IP allow-list survives the move off the
security group — enforced now before the integration runs rather than at the
instance.

Concurrency is capped at the poller rather than the function, because a
throttled invocation still burns a message's receive count and would have
dead-lettered deliveries no worker ever saw.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Repoint and strengthen the security suites

**Files:**
- Modify: `github-control-hub/backend/repro-appsec.ts:113-122`
- Modify: `github-control-hub/backend/repro-leastprivilege.ts`

These assert properties that nothing else notices. Repointing them is required because the file they read is moving; the additions are because the new topology has new things worth asserting.

- [ ] **Step 1: Repoint and extend `repro-appsec.ts`**

Replace the block at lines 113–122:

```ts
  // ── the webhook cannot be forged ───────────────────────────────────
  {
    const verify   = read("github-control-hub/backend/src/webhooks/verify.ts");
    const receiver = read("github-control-hub/backend/src/webhooks/receiver.ts");
    const worker   = read("github-control-hub/backend/src/webhooks/worker.ts");

    check("webhook signatures are compared in constant time",
      /timingSafeEqual/.test(verify));
    check("  and a missing secret fails closed",
      /if \(!secret\) return false/.test(verify), "an absent webhook secret would accept anything");
    check("  replays are rejected",
      /claimDelivery/.test(worker));

    // The receiver's whole job is to not put anything unverified on the queue.
    const receiverCode = code(receiver);
    check("  nothing is queued before the signature verifies",
      receiverCode.indexOf("statusCode: 401") < receiverCode.indexOf("await send("),
      "an unverified payload would reach the worker");

    // The signature covers the bytes as sent. Parsing first breaks every one.
    check("  the body is not parsed before it is verified",
      receiverCode.indexOf("verifyGitHubSignature") < receiverCode.indexOf("JSON.parse"),
      "a re-serialised body is a different sequence of bytes");
  }
```

- [ ] **Step 2: Extend `repro-leastprivilege.ts`**

Add a new block after the existing CDK assertions (near line 113, after the `allowRemediation` check):

```ts
  // ── the internet-facing function is the smallest thing here ────────
  //
  // The receiver is the only component reachable from the internet. The
  // privilege split is the reason it is a separate function at all, so a
  // grant creeping into it is the regression this guards.
  {
    const receiverBlock = cdkCode.slice(
      cdkCode.indexOf("const receiverFn"),
      cdkCode.indexOf("const workerFn"),
    );
    check("the webhook receiver holds no DynamoDB",
      receiverBlock.length > 0 && !/dynamodb:/.test(receiverBlock),
      "the internet-facing function gained table access");
    check("  and cannot assume a role",
      !/sts:AssumeRole/.test(receiverBlock),
      "the internet-facing function gained cross-account reach");
    check("  and cannot invoke anything",
      !/lambda:InvokeFunction/.test(receiverBlock));

    check("the webhook API restricts source IPs to GitHub",
      /NotIpAddress/.test(cdkCode) && /GITHUB_WEBHOOK_CIDRS/.test(cdkCode),
      "the allow-list the security group used to hold was not carried over");
    check("  with an explicit deny, not just an allow",
      /Effect\.DENY/.test(cdkCode),
      "an allow alone does not exclude anyone");
  }
```

- [ ] **Step 3: Run both suites**

```bash
cd github-control-hub/backend && npx tsx repro-appsec.ts && npx tsx repro-leastprivilege.ts
```

Expected: `ALL PASS` from both, exit 0.

- [ ] **Step 4: Run everything**

```bash
cd github-control-hub/backend && for t in repro-*.ts; do printf '%-32s' "$t"; npx tsx "$t" >/dev/null 2>&1 && echo PASS || echo FAIL; done
cd ../backend  && npx tsc --noEmit
cd ../frontend && npx tsc --noEmit
cd ../desktop  && npx tsc --noEmit
cd ../infra    && npx tsc --noEmit
```

Expected: 21 suites PASS, four clean type-checks. `routes/webhooks.ts` still exists and is still mounted — nothing is broken yet.

- [ ] **Step 5: Commit**

```bash
git add github-control-hub/backend/repro-appsec.ts github-control-hub/backend/repro-leastprivilege.ts
git commit -m "$(cat <<'EOF'
Assert the webhook receiver stays the smallest thing in the stack

The privilege split is the reason reception is a separate function, and nothing
would notice a grant creeping into it — no test goes red, and the property is
only visible to someone reading the IAM a year later. Same reason these two
suites exist at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## MILESTONE A — the user deploys and verifies

**Stop here. Do not proceed to Task 9 until the user confirms.**

Report to the user, and ask them to run these and paste the output:

1. Deploy to **personal** (`<account-id>`, us-east-1, profile `<profile>`):
   ```bash
   cd github-control-hub/infra && npx cdk deploy
   ```
   The instance is still there; this only adds.

2. Take `WebhookUrl` from the stack outputs.

3. In `SorvaLabs-Clasity` → Settings → Webhooks, **edit the existing webhook's URL**. Do not add a second one — GitHub issues a separate delivery id per webhook, so the lock cannot dedupe across them and templates would be applied twice.

4. Confirm the `ping` shows a green tick with a 202.

5. Create a test repository. Confirm: the activity row appears, any auto-apply template was applied, and the Activity page reads **Receiving events**.

If a delivery returns 401, the likely cause is the base64 branch, not the secret — check the receiver's CloudWatch logs before touching Secrets Manager.

---

## Task 9: Remove the Express webhook path

**Files:**
- Modify: `github-control-hub/backend/src/server.ts:15,97-101`
- Delete: `github-control-hub/backend/src/routes/webhooks.ts`
- Delete: `github-control-hub/backend/src/standalone.ts`
- Delete: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `scripts/deploy.sh`

- [ ] **Step 1: Unmount the route**

Delete line 15 (`import webhookRoutes from "./routes/webhooks";`) and lines 97–101:

```ts
// Webhook route MUST be mounted before global express.json() so we can capture the raw body for HMAC verification
app.use("/api/webhooks", express.json({
  limit: "1mb",
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}), webhookRoutes);
```

Leave `app.use(express.json({ limit: "1mb" }));` — it is now the only body parser.

- [ ] **Step 2: Delete the files**

```bash
cd /Users/ronidaou/Documents/GitHub/WG
git rm github-control-hub/backend/src/routes/webhooks.ts \
       github-control-hub/backend/src/standalone.ts \
       Dockerfile docker-compose.yml .dockerignore scripts/deploy.sh
```

`standalone.ts` is the instance's entry point; the desktop has its own `desktop/src/bootstrap.ts` and `desktop/src/server.ts` and references it only in a comment. The `Dockerfile`'s `CMD` is `node github-control-hub/backend/dist/standalone.js`, `deploy.sh` is the only thing that builds the image, and CI builds Electron only.

- [ ] **Step 3: Fix the stale comment in the desktop**

`desktop/src/server.ts:51` refers to `backend/src/standalone.ts`. Read the surrounding comment and reword it so it does not point at a deleted file. Do not change behavior.

- [ ] **Step 4: Verify**

```bash
cd github-control-hub/backend && for t in repro-*.ts; do printf '%-32s' "$t"; npx tsx "$t" >/dev/null 2>&1 && echo PASS || echo FAIL; done
cd ../backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit && cd ../desktop && npx tsc --noEmit && cd ../infra && npx tsc --noEmit
```

Expected: 21 PASS, four clean type-checks. `repro-appsec` and `repro-leastprivilege` already point at the new files from Task 8.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Delete the server that only ever existed to hold a webhook route

The Express mount, the standalone entry point, the container that ran it and
the script that shipped it were one path with one purpose, now served by two
Lambdas. The instance also served the frontend, but its security group allowed
only GitHub's ranges, so no browser ever reached it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Remove the EC2 from the stack

**Files:**
- Modify: `github-control-hub/infra/cdk-stack.ts`

- [ ] **Step 1: Delete the instance and everything only it needed**

Remove, in order: the `ec2.Vpc.fromLookup` (`DefaultVpc`), the `SecurityGroup` and its CIDR loop, the `InstanceRole` and all six of its `addToPolicy` calls, the `ec2.Instance`, its `addUserData` block, the `cdk.Tags.of(instance)` line, and the `CfnEIP`.

Keep `GITHUB_WEBHOOK_CIDRS` — the resource policy uses it now.

- [ ] **Step 2: Re-home the two grants that were not about the instance**

`guardrailFn.grantInvoke(role)` and the `ReadOwnEngineRole` policy granted the *instance role* the ability to invoke the guardrail Lambda and read its configuration. That role is gone, but the capability was for the desktop app, which uses the signed-in user's own AWS credentials — so both simply disappear. Delete them.

Verify by grepping for other uses of `role`:

```bash
grep -n "\brole\b" github-control-hub/infra/cdk-stack.ts
```

Expected: no references to the deleted `InstanceRole` remain.

- [ ] **Step 3: Delete the stale outputs**

Remove `InstanceId`, `PublicIp` and `ConnectCommand`. Keep every guardrail output and the three webhook outputs from Task 7.

- [ ] **Step 4: Remove the now-unused imports**

`import * as ec2 from "aws-cdk-lib/aws-ec2";` — confirm nothing else uses it before deleting.

- [ ] **Step 5: Verify**

```bash
cd github-control-hub/infra && npx tsc --noEmit && npx cdk synth --quiet
cd ../backend && npx tsx repro-leastprivilege.ts
```

Expected: clean type-check, successful synth, `ALL PASS`. `cdk synth` should now work without credentials, because `Vpc.fromLookup` is gone — that is a small bonus of the deletion.

If `repro-leastprivilege` fails, read the failure before changing it: it may be correctly reporting that an assertion referenced the instance role. Repoint it; do not delete the assertion.

- [ ] **Step 6: Commit**

```bash
git add github-control-hub/infra/cdk-stack.ts
git commit -m "$(cat <<'EOF'
Stop paying for an instance in a subnet nothing can reach

The security group, the Elastic IP and the self-signed certificate all existed
to get GitHub to an address the work VPC never had a route from. With the
webhook on API Gateway there is nothing left for the instance to do.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Documentation

**Files:** as listed below. Docs are first-class here; every one of these currently describes a machine that no longer exists.

- [ ] **Step 1: Rewrite `docs/architecture/where-code-runs.md`**

Replace the `## EC2 instance` section with `## Webhook receiver and worker`, describing the API Gateway → receiver → SQS → worker path. Keep the list of events it records verbatim. Update the intro: the backend is now started **two** ways, not three, plus three Lambda entry points. Correct the closing line of the desktop section — "Turn off the EC2 and the app still works" needs rewording.

Keep the sentence about deliveries being lost when the receiver is down, but note the DLQ now holds anything that reached the queue and failed.

- [ ] **Step 2: Delete `docs/infrastructure/ec2.md`**

```bash
git rm docs/infrastructure/ec2.md
```

- [ ] **Step 3: Rewrite `docs/infrastructure/lambda.md`**

It currently describes one function. It now describes three. Add a table row per function, and replace the "Why it is separate from the EC2" section — the reasoning ("it needs no inbound connectivity") is now the reasoning for the whole design rather than a contrast. Note the runtime is `nodejs24.x`; the file currently says `nodejs22.x`, which was already stale.

- [ ] **Step 4: Update `docs/infrastructure/README.md` and `docs/infrastructure/cost.md`**

Remove the EC2 and Elastic IP lines. Add API Gateway (REST, $3.50/M), the two Lambdas, SQS and the deliveries table. State the net effect: roughly fifteen dollars a month to roughly nothing.

- [ ] **Step 5: Rewrite `docs/github-api/webhooks.md`**

- The URL is now the API Gateway one, not `https://<ec2>/api/webhooks/github`.
- Under Security, replace the security-group line with the resource policy, and say it is evaluated before the integration runs.
- Replace "responds 202 before doing slow work" — the receiver responds 202 because the work happens in another function off a queue.
- Under "If the EC2 is down", rewrite for the new failure modes: a delivery rejected at the gateway is lost as before; a delivery that reached the queue and failed five times is in the DLQ and can be redriven.
- Keep the health table unchanged; it still works.

- [ ] **Step 6: Update `docs/operations/deploying.md` and `docs/operations/setup.md`**

Remove every reference to `scripts/deploy.sh`, Docker, SSM Session Manager and the instance. Deployment is now `cdk deploy` alone. In `setup.md`, the webhook URL step becomes "take `WebhookUrl` from the stack outputs", and add the warning about editing the existing webhook rather than adding a second one.

- [ ] **Step 7: Add a troubleshooting entry**

In `docs/operations/troubleshooting.md`, add: GitHub's webhook IP ranges change occasionally; nothing detects it; the symptom is 403s at the gateway and an Activity page that reads **Stale** within 72 hours; the current list comes from `https://api.github.com/meta` → `hooks` and lives in `GITHUB_WEBHOOK_CIDRS` in `infra/cdk-stack.ts`.

Add a second entry: a 401 on a delivery that used to work is more likely the secret having been rotated than the signature logic; the receiver refetches once per failure with a sixty-second floor, so give it a minute before investigating further.

- [ ] **Step 8: Correct `docs/development/testing.md`**

The header says "Seventeen suites" and the table lists 17, but there were already 20 files before this work and there are now 21. Fix the count and add a row:

```markdown
| `repro-webhookdelivery` | Signature verification over raw bytes, and the delivery lock |
```

Add it to the "Two unusual ones" section or leave that alone — but the count must be right.

- [ ] **Step 9: Check `docs/architecture/request-path.md`**

```bash
grep -rn "EC2\|ec2\|standalone\|deploy.sh\|Docker\|docker" docs/
```

Fix every remaining hit. Expect stragglers in `docs/README.md`, `docs/architecture/request-path.md` and `docs/operations/environment.md`.

- [ ] **Step 10: Verify and commit**

```bash
grep -rn "EC2\|ec2\b\|deploy\.sh\|standalone" docs/ | grep -v "docs/superpowers/"
```

Expected: no hits outside `docs/superpowers/` (the spec and this plan describe the migration and should keep their references).

```bash
git add -A
git commit -m "$(cat <<'EOF'
Describe the system that exists rather than the one that was deleted

Six documents described an instance, a container and a deploy script, all of
which are gone. The webhook URL, the deployment procedure and the cost page
were the ones that would have actively misled someone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## MILESTONE B — the user deploys the deletion

**Stop. Report to the user and ask them to run:**

1. Personal (`<account-id>`, us-east-1):
   ```bash
   cd github-control-hub/infra && npx cdk deploy
   ```
   This destroys the instance, security group and Elastic IP. Confirm webhooks still arrive afterwards — create another test repository.

2. Work (`<account-id>`, us-east-2). Region matters: an SCP denies `secretsmanager:GetSecretValue` in us-east-1.
   ```bash
   cd github-control-hub/infra && AWS_REGION=us-east-2 npx cdk deploy
   ```
   Then set the webhook URL in the work org and repeat the verification.

3. Confirm the work account's Activity page reaches **Receiving events** — the thing that has never worked and is the reason for all of this.

Then ask whether to open a PR. Do not push to `main` without asking.

---

## Self-Review

**Spec coverage.** Every section maps to a task: REST/resource policy → 7; raw bytes → 1; replay lock → 3; token lifecycle → 6; awaited background work → 4; secret cache and refetch → 2; concurrency and `maxReceiveCount` → 7; IAM split → 7 and asserted in 8; DLQ alarms → 7; deletion list → 9 and 10; testing → 1–6 and 8; rollout including repoint-don't-duplicate → Milestones A and B; docs → 11. The spec's "out of scope" items appear nowhere, as intended.

**Type consistency.** `Delivery` is defined in Task 4 and consumed in Task 6 with the same four fields. `claimDelivery`/`completeDelivery`/`releaseDelivery` keep their names across Tasks 3, 6 and 8. `getWebhookSecret`/`refetchWebhookSecret`/`loadSecretsIntoEnv` keep theirs across 2, 5 and 6. `rawBodyBytes`/`verifyGitHubSignature` across 1 and 5. `WEBHOOK_DELIVERIES_TABLE` and `WEBHOOK_QUEUE_URL` are set in Task 7 and read in Tasks 3 and 5.

**Known soft spot.** Task 4 is a code move described as a diff rather than reproduced in full, because reproducing 200 lines of event handling invites drift between plan and source. The substitutions are enumerated exactly and the replacement tail is given verbatim; the reviewer's check is that `processDelivery.ts` differs from the old route body only in the nine listed ways.
