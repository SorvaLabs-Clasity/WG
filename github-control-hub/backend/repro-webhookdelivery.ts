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

  __resetSecretCacheForTests({ keepValue: true });
  __setSecretLoaderForTests(async () => { throw new Error("throttled"); });
  check("a fetch failure keeps the last known secret", (await getWebhookSecret()) === "good");

  __resetSecretCacheForTests();
  __setSecretLoaderForTests(async () => ({}));
  check("  but no secret at all still fails closed", (await getWebhookSecret()) === "");
}

// ── the test seam does not leave residue ──
{
  const { getWebhookSecret, __setSecretLoaderForTests, __resetSecretCacheForTests } =
    await import("./src/webhooks/secret");

  let leakedMockRan = false;
  __resetSecretCacheForTests();
  __setSecretLoaderForTests(async () => { leakedMockRan = true; return { GITHUB_WEBHOOK_SECRET: "leaked" }; });
  __resetSecretCacheForTests();

  check("a reset uninstalls the previously injected loader",
    (await getWebhookSecret()) === "" && !leakedMockRan,
    "a later test block would silently inherit this block's mock");
}

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

  // The next three are behavioural rather than textual, because they are the
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
})();
