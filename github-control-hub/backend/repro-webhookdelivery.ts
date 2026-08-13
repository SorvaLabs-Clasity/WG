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

// ── claimDelivery does not swallow errors that are not lock contention ──
//
// ConditionalCheckFailedException means "someone else holds it", and false is
// the correct, quiet answer. Any other DynamoDB error — a throttle, for
// instance — must not also collapse to false: the worker would skip the
// delivery, return normally, and SQS would delete the message with the event
// lost and no trace of it anywhere.
{
  process.env.WEBHOOK_DELIVERIES_TABLE = "test-deliveries";
  const { docClient } = await import("./src/utils/dynamo");
  const { claimDelivery } = await import("./src/webhooks/deliveryLock");

  (docClient as any).send = async () => {
    const e: any = new Error("throughput exceeded");
    e.name = "ProvisionedThroughputExceededException";
    throw e;
  };

  let rejected = false;
  try {
    await claimDelivery("d-throttled");
  } catch {
    rejected = true;
  }
  check("claimDelivery rethrows a non-conditional DynamoDB error rather than resolving false",
    rejected,
    "swallowing it would make the worker skip the delivery and SQS would delete the message");
}

// ── a failed delivery is retryable, a duplicate is not reprocessed ──
{
  const src = await import("fs").then(fs =>
    fs.readFileSync(new URL("./src/webhooks/worker.ts", `file://${__filename}`), "utf8"));

  // Sliced to the handler body rather than checked against the whole file: the
  // import statements alone name claimDelivery before processDelivery, so a
  // check against the full source would still pass if the handler body called
  // them in the wrong order. bootstrapOnce above it throws, too, so a
  // whole-file check for a rethrow is satisfied by code the handler does not
  // run.
  //
  // Comments stripped for the same reason as elsewhere in this file: the prose
  // explaining why the completeDelivery failure is *not* rethrown contains
  // "rethrow", which matches /throw / and makes the assertion below unable to
  // fail.
  const handlerBody = code(src);
  const handlerSrc = handlerBody.slice(handlerBody.indexOf("export async function handler"));

  check("the worker claims before processing",
    handlerSrc.indexOf("claimDelivery") < handlerSrc.indexOf("processDelivery"));

  check("  releases the claim when processing throws",
    /releaseDelivery\(/.test(handlerSrc) && /throw /.test(handlerSrc),
    "a swallowed error would delete the message and lose the event");

  check("  and resolves the token once per invocation",
    /await getSystemTokenAsync\(\)/.test(src),
    "the synchronous getter returns a stale token on a warm container");

  check("  bootstrapping happens once per container",
    /bootstrapped/.test(src),
    "re-reading Secrets Manager per message wastes the warm container");
}

// ── the lease sits between the worker timeout and the visibility timeout ──
//
// Three numbers in two repositories that only work as an ordering, so all three
// are read from source rather than restated here: the test has to break when
// any one of them drifts, not agree with a stale copy of itself.
//
// The lease clock starts at claimDelivery, the visibility clock at
// ReceiveMessage — one pre-claim latency δ earlier (cold start, bootstrapOnce,
// getSystemTokenAsync). A redelivery lands at receive + visibility, the lease
// expires at receive + δ + lease, and re-claiming needs expiresAt < now. So
// lease == visibility fails for every δ including zero, and a worker killed
// without releasing its claim leaves a delivery its own redelivery cannot
// re-take: the worker skips it, returns success, SQS deletes the message and
// the event is gone with no DLQ entry and no alarm.
{
  const fs = await import("fs");
  const nodePath = await import("path");

  const lockSrc = fs.readFileSync(
    nodePath.join(__dirname, "src", "webhooks", "deliveryLock.ts"), "utf8");
  const cdkSrc = fs.readFileSync(
    nodePath.join(__dirname, "..", "infra", "cdk-stack.ts"), "utf8");

  const seconds = (expr: string | undefined): number => {
    const m = /cdk\.Duration\.(seconds|minutes)\((\d+)\)/.exec(expr ?? "");
    return m ? Number(m[2]) * (m[1] === "minutes" ? 60 : 1) : NaN;
  };

  const leaseSec = Number(/^const LEASE_SEC = (\d+);/m.exec(lockSrc)?.[1] ?? NaN);
  const visibilitySec = seconds(/visibilityTimeout:\s*([^,\n]+)/.exec(cdkSrc)?.[1]);
  // Sliced to the worker's own construct: the receiver above it has a timeout
  // too, and the stack declares several others.
  const workerSrc = cdkSrc.slice(cdkSrc.indexOf('"WebhookWorker"'));
  const workerTimeoutSec = seconds(/\btimeout:\s*([^,\n]+)/.exec(workerSrc)?.[1]);

  check("the three durations are all readable from source",
    [leaseSec, workerTimeoutSec, visibilitySec].every(Number.isFinite),
    { leaseSec, workerTimeoutSec, visibilitySec });

  check("  the lease outlives the worker's own timeout",
    workerTimeoutSec < leaseSec,
    `worker timeout ${workerTimeoutSec}s, lease ${leaseSec}s — a lease at or under the ` +
    `function timeout lets a second worker claim a delivery the first is still processing`);

  check("  and expires before the queue redelivers",
    leaseSec < visibilitySec,
    `lease ${leaseSec}s, visibility timeout ${visibilitySec}s — a dead worker's claim is ` +
    `still held when the redelivery lands, so the event is dropped with no DLQ entry`);

  check("  and the done marker outlives the visibility timeout",
    Number(/^const DONE_SEC = (\d+);/m.exec(lockSrc)?.[1] ?? NaN) > visibilitySec,
    "an expired marker lets an at-least-once redelivery apply the templates twice");
}

// ── a container whose first bootstrap loaded nothing retries on the next message ──
//
// fetchBundle in secret.ts swallows a Secrets Manager failure so a transient
// error cannot discard a working secret, which means a first-ever fetch that
// failed returns an empty bundle rather than throwing. Memoising that poisons
// the container for its whole life: GITHUB_ORG never gets set, nothing re-reads
// secrets, and every delivery that container handles throws at getOrg().
{
  process.env.WEBHOOK_DELIVERIES_TABLE = "test-deliveries";
  delete process.env.GITHUB_ORG;

  const { docClient } = await import("./src/utils/dynamo");
  (docClient as any).send = async () => ({});

  const { __setSecretLoaderForTests, __resetSecretCacheForTests } =
    await import("./src/webhooks/secret");
  const { handler } = await import("./src/webhooks/worker");

  const message = (id: string) => ({
    Records: [{ body: JSON.stringify({ deliveryId: id, event: "ping", payload: {} }) }],
  }) as any;

  __resetSecretCacheForTests();
  __setSecretLoaderForTests(async () => { throw new Error("throttled"); });

  let firstFailed = false;
  try { await handler(message("d-boot-1")); } catch { firstFailed = true; }
  check("an invocation whose secrets did not load fails rather than half-working", firstFailed);

  // Same container, next message. Secrets Manager has recovered.
  __setSecretLoaderForTests(async () =>
    ({ GITHUB_ORG: "acme-corp", SYSTEM_GITHUB_TOKEN: "system-token" }));

  let secondError: string | null = null;
  try { await handler(message("d-boot-2")); } catch (e) { secondError = (e as Error).message; }
  check("  and the next one retries the load instead of reusing the empty result",
    secondError === null,
    secondError ?? "a memoised empty bootstrap dead-letters every delivery this container sees");

  check("  which is what puts GITHUB_ORG in the environment processDelivery reads",
    process.env.GITHUB_ORG === "acme-corp", process.env.GITHUB_ORG);
}

// ── failing to mark a delivery done must not reprocess it ──
//
// The work is finished by then: activity rows written, templates applied.
// Releasing the claim and rethrowing would hand the message back to SQS and
// guarantee all of it happens a second time.
{
  process.env.WEBHOOK_DELIVERIES_TABLE = "test-deliveries";
  const { docClient } = await import("./src/utils/dynamo");
  const { handler } = await import("./src/webhooks/worker");

  let releases = 0;
  (docClient as any).send = async (cmd: any) => {
    const kind = cmd.constructor.name;
    if (kind === "DeleteCommand") { releases++; return {}; }
    // The claim carries a ConditionExpression; marking done does not.
    if (kind === "PutCommand" && !cmd.input.ConditionExpression) {
      const e: any = new Error("throughput exceeded");
      e.name = "ProvisionedThroughputExceededException";
      throw e;
    }
    return {};
  };

  let threw = false;
  try {
    await handler({
      Records: [{ body: JSON.stringify({ deliveryId: "d-done-fails", event: "ping", payload: {} }) }],
    } as any);
  } catch { threw = true; }

  check("a completeDelivery failure does not fail the invocation", !threw,
    "rethrowing here redelivers work that already happened");
  check("  and does not release the claim", releases === 0, releases);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
})();
