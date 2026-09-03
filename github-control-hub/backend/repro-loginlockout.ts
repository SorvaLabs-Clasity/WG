/**
 * Locked out of the login screen after leaving the app open.
 *
 * Leave the desktop app running long enough for the session token to expire,
 * come back to the login screen, and the AWS profile list is empty with
 * "Missing or invalid Authorization header". The screen whose whole job is
 * getting a session cannot draw itself without one.
 *
 * `setupOrAuthMiddleware` opened these endpoints in two cases: nothing
 * configured yet, and AWS unusable. Both are about AWS. Neither covers the
 * third way to arrive at the login screen, which is the ordinary one: AWS is
 * perfectly healthy and the *GitHub session* is what expired. So the endpoints
 * that exist to establish a connection demanded the thing that connection
 * produces.
 *
 * The rest of the file already assumed otherwise. `sameOriginOnly`, which
 * guards the same routes, documents them as "reachable without a session by
 * design, since reconnecting AWS is how you get a session back", and defends
 * them accordingly. This aligns the two.
 *
 * What actually keeps these safe is where they can run, not who is calling:
 * `serverModeGuard` refuses them outright on a server deployment, so the only
 * caller is the desktop app reading the ~/.aws/config of the machine it is
 * installed on. Any local process able to reach that port can already read
 * that file directly. Losing serverModeGuard is the thing that would matter,
 * so this pins it on every one of them.
 */
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const auth = fs.readFileSync(path.join(__dirname, "src/routes/auth.ts"), "utf8");

/** The routes that exist to establish or repair a connection. */
const CONNECTION_ROUTES = [
  "/aws-profiles",
  "/reconnect-aws",
  "/aws-sso-start",
  "/aws-sso-poll",
  "/aws-sso-create-profile",
  // Found by this test rather than by reading: the first list was written from
  // memory and missed three, which is exactly why the set is asserted in both
  // directions below instead of spot-checked.
  "/aws-sso-login",
  "/aws-use-profile",
  "/aws-access-keys",
];

console.log("the screen that gets you a session does not require one");
{
  const guard = auth.slice(auth.indexOf("const setupOrAuthMiddleware"));
  const body = guard.slice(0, guard.indexOf("\n};"));

  // The specific bug: falling through to authMiddleware left the login screen
  // unable to list profiles once the app was configured and AWS was fine.
  check("the connection endpoints never fall through to a session check",
    !/authMiddleware\(req, res, next\)/.test(body), body.slice(-400));

  // And every one of them still carries it, so a later route added by copying
  // one of these inherits the guard rather than the hole.
  for (const route of CONNECTION_ROUTES) {
    const at = auth.indexOf(`"${route}"`);
    const decl = auth.slice(at, auth.indexOf("async", at) + 5);
    check(`  ${route} is still desktop-only`, /serverModeGuard/.test(decl), decl.slice(0, 160));
    check(`  ${route} still refuses cross-site requests`, /sameOriginOnly/.test(decl), decl.slice(0, 160));
  }
}

console.log("\nand nothing else was opened along with them");
{
  // The blast radius of this change is exactly the routes that carry this
  // middleware, so that is what is pinned. Auditing every other route's guard
  // is repro-authz's job, and duplicating it here found only false positives:
  // /verify checks the header inline, /invalidate-aws is deliberately
  // session-free behind the same two guards, and the OAuth callback cannot
  // have a session by definition.
  const carriers = [...auth.matchAll(/router\.(?:get|post|put|delete)\("([^"]+)"([^)]*)/g)]
    .filter(m => /setupOrAuthMiddleware/.test(m[2]))
    .map(m => m[1]);

  check("only the connection endpoints use this middleware",
    carriers.every(r => CONNECTION_ROUTES.includes(r)), carriers);
  check("  and all of them still do, so none drifted onto a different guard",
    CONNECTION_ROUTES.every(r => carriers.includes(r)), carriers);
}

console.log("\nthe reason is written down where the next person will change it");
{
  const at = auth.indexOf("const setupOrAuthMiddleware");
  const guard = auth.slice(Math.max(0, at - 2200), at + 200);

  // Somebody will read this middleware and wonder why it does nothing but call
  // next(). Without the reason, restoring the session check looks like a fix.
  check("the guard says why it cannot require a session",
    /login screen|session/i.test(guard) && /serverModeGuard/.test(guard));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
