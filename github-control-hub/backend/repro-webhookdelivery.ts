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

  __setSecretLoaderForTests(async () => { throw new Error("throttled"); });
  __resetSecretCacheForTests({ keepValue: true });
  check("a fetch failure keeps the last known secret", (await getWebhookSecret()) === "good");

  __resetSecretCacheForTests();
  check("  but no secret at all still fails closed", (await getWebhookSecret()) === "");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
})();
