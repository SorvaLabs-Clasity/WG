/**
 * The GitHub App's installation token, and the fact that it is the only one.
 *
 * Installation tokens live one hour, and getToken() once returned
 * `this.cachedToken` with no expiry check — so ~25 synchronous call sites kept
 * using a dead token and every GitHub call failed with 401 until a restart. That
 * was fixed by falling back to a `SYSTEM_GITHUB_TOKEN` personal access token.
 *
 * That fallback has since been removed. It was a second, broader credential held
 * permanently for a case that should be rare, and because it *worked*, a broken
 * App could go unnoticed for weeks. The App is now the only credential.
 *
 * So the assertion has inverted: nothing must reach for a PAT, and the env var
 * is set here to a value that would be obvious if anything did.
 *
 * Two separate stub files are used because client.ts loads @octokit/auth-app via
 * dynamic ESM import(), whose module cache cannot be invalidated per-run.
 */
process.env.GITHUB_ORG = "test-org";
// Deliberately set. If any code path still consults it, a check below fails.
process.env.SYSTEM_GITHUB_TOKEN = "ghp_should_never_be_used";

import fs from "fs";
import path from "path";
import { initTokenManager, getSystemToken } from "./src/github/client";

const dir = __dirname;
const expiredStub = path.join(dir, "stub-expired.cjs");
const freshStub = path.join(dir, "stub-fresh.cjs");

fs.writeFileSync(expiredStub,
  `exports.createAppAuth = () => async () => ({ token: "ghs_app_expired",
     expiresAt: new Date(Date.now() - 3600e3).toISOString() });`);
fs.writeFileSync(freshStub,
  `exports.createAppAuth = () => async () => ({ token: "ghs_app_fresh",
     expiresAt: new Date(Date.now() + 3600e3).toISOString() });`);

let target = expiredStub;
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req: string, ...rest: any[]) {
  if (req === "@octokit/auth-app") return target;
  return origResolve.call(this, req, ...rest);
};

(async () => {
  let failures = 0;

  target = expiredStub;
  await initTokenManager("1", "key", "1");
  const stale = getSystemToken();
  // The expired App token, not a PAT. GitHub answers 401 and the App looks
  // broken — which it is. Quietly succeeding on a personal access token is the
  // outcome this removal exists to prevent.
  const staleOk = stale === "ghs_app_expired";
  console.log("expired App token -> getSystemToken():", stale);
  console.log(staleOk
    ? "  PASS: returns the App's own token, with no PAT fallback"
    : "  FAIL: reached for something other than the App token");
  if (!staleOk) failures++;

  const noPat = stale !== "ghp_should_never_be_used";
  console.log(noPat
    ? "  PASS: SYSTEM_GITHUB_TOKEN is not consulted"
    : "  FAIL: a personal access token is still being used as a fallback");
  if (!noPat) failures++;

  target = freshStub;
  await initTokenManager("1", "key", "1");
  const fresh = getSystemToken();
  const freshOk = fresh === "ghs_app_fresh";
  console.log("valid App token   -> getSystemToken():", fresh);
  console.log(freshOk
    ? "  PASS: uses the App token (keeps the 12,500/hr limit)"
    : "  FAIL: did not use the live App token");
  if (!freshOk) failures++;

  fs.unlinkSync(expiredStub);
  fs.unlinkSync(freshStub);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
