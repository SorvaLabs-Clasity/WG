/**
 * Regression test: the synchronous getSystemToken() must never return an expired
 * GitHub App installation token.
 *
 * Installation tokens live one hour. Before the fix, getToken() returned
 * `this.cachedToken` with no expiry check, so ~25 synchronous call sites
 * (webhooks auto-apply, templates, compliance, alerts) kept using a dead token
 * and every GitHub call failed with 401 Bad credentials until a restart.
 *
 * Two separate stub files are used because client.ts loads @octokit/auth-app via
 * dynamic ESM import(), whose module cache cannot be invalidated per-run.
 */
process.env.GITHUB_ORG = "test-org";
process.env.SYSTEM_GITHUB_TOKEN = "ghp_fallback";

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
  const staleOk = stale === "ghp_fallback";
  console.log("expired App token -> getSystemToken():", stale);
  console.log(staleOk
    ? "  PASS: fell back to the PAT instead of handing out a dead token"
    : "  FAIL: returned an expired App token (every call would 401)");
  if (!staleOk) failures++;

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
