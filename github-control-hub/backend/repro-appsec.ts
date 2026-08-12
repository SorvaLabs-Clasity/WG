/**
 * Application-security controls, asserted against the shipped source.
 *
 * A sibling to repro-leastprivilege.ts, which does the same for IAM. Both
 * exist because these properties are invisible: nothing fails, no test goes
 * red, and a regression is only discovered by someone reading the code a year
 * later — or not at all.
 *
 * The finding that prompted most of this: index.html loaded
 * `<script src="https://unpkg.com/@phosphor-icons/web">`, unpinned and with no
 * integrity hash, into an application holding an administrative session for a
 * GitHub organisation and several AWS accounts.
 */
import fs from "fs";
import path from "path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const ROOT = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Source with comments removed.
 *
 * These assertions look for the absence of things, and prose explaining why a
 * thing is absent contains the thing. The first run of this file failed on its
 * own comment saying "with shell:true the argument list is flattened".
 */
const code = (src: string) => src
  .split("\n")
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s*\/\/.*$/, ""))
  .join("\n");

const html   = read("github-control-hub/frontend/index.html");
const mainTs = read("github-control-hub/frontend/src/main.tsx");
const server = read("github-control-hub/backend/src/server.ts");
const auth   = read("github-control-hub/backend/src/routes/auth.ts");
const cdk    = read("github-control-hub/infra/cdk-stack.ts");
const electron = read("github-control-hub/desktop/src/main.ts");

(async () => {
  // ── nothing is fetched from anyone else ────────────────────────────
  {
    const remote = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)/g)].map(m => m[1]);
    check("index.html references no remote origin",
      remote.length === 0, remote);

    check("  and pulls no remote script",
      !/<script[^>]+src=["']https?:/i.test(html), "a remote <script> is back in index.html");

    for (const pkg of ["@fontsource/inter", "@phosphor-icons/web", "@fortawesome/fontawesome-free"]) {
      check(`  ${pkg} is bundled from node_modules`, mainTs.includes(pkg), pkg);
    }
  }

  // ── the policy that would have stopped it ──────────────────────────
  {
    check("a content-security-policy is configured",
      !/contentSecurityPolicy:\s*false/.test(server) && /contentSecurityPolicy:\s*\{/.test(server),
      "helmet's CSP is disabled");

    const csp = server.slice(server.indexOf("contentSecurityPolicy"), server.indexOf("hsts:"));
    check("  script may only come from this origin",
      /scriptSrc:\s*\["'self'"\]/.test(csp), csp.match(/scriptSrc:[^\]]*\]/)?.[0]);
    check("  and never inline or evaluated",
      !/unsafe-inline|unsafe-eval/.test(csp.slice(csp.indexOf("scriptSrc"), csp.indexOf("styleSrc"))),
      "scriptSrc permits inline or eval");
    check("  the page cannot be framed",
      /frameAncestors:\s*\["'none'"\]/.test(csp));
    check("  objects are forbidden",
      /objectSrc:\s*\["'none'"\]/.test(csp));
    check("  connections go only to this origin",
      /connectSrc:\s*\["'self'"\]/.test(csp));
  }

  // ── no shell between user input and a process ──────────────────────
  {
    check("nothing is spawned through a shell",
      !/shell:\s*true/.test(code(auth)), "spawn uses shell: true");
    check("  and the one spawned argument is allow-listed first",
      /isValidAwsProfile/.test(auth) && /\^\[a-zA-Z0-9\._-\]\{1,64\}\$/.test(auth),
      "the AWS profile name is not validated against an allow-list");
  }

  // ── infrastructure at rest ─────────────────────────────────────────
  {
    check("the instance root volume is encrypted",
      /encrypted:\s*true/.test(cdk), "EBS encryption is not requested");
    check("instance metadata requires v2",
      /requireImdsv2:\s*true/.test(cdk),
      "IMDSv1 would turn any SSRF into instance-role credentials");
    check("the dead-letter queue is encrypted",
      /encryption:\s*sqs\.QueueEncryption\./.test(cdk));
    check("  and refuses plaintext transport",
      /enforceSSL:\s*true/.test(cdk));
  }

  // ── the renderer cannot reach node ─────────────────────────────────
  {
    check("context isolation is on",
      /contextIsolation:\s*true/.test(electron));
    check("node integration is off",
      /nodeIntegration:\s*false/.test(electron));
    check("  and the renderer is never given a node-enabled window",
      !/nodeIntegration:\s*true/.test(code(electron)));
  }

  // ── the webhook cannot be forged ───────────────────────────────────
  {
    const hook = read("github-control-hub/backend/src/routes/webhooks.ts");
    check("webhook signatures are compared in constant time",
      /timingSafeEqual/.test(hook));
    check("  and a missing secret fails closed",
      /if \(!secret\) return false/.test(hook), "an absent webhook secret would accept anything");
    check("  replays are rejected",
      /isDuplicateDelivery/.test(hook));
  }

  // ── nothing hardcoded ──────────────────────────────────────────────
  {
    const files = ["github-control-hub/backend/src", "github-control-hub/frontend/src",
                   "github-control-hub/desktop/src", "github-control-hub/infra/cdk-stack.ts"];
    const bad: string[] = [];
    const walk = (p: string) => {
      const full = path.join(ROOT, p);
      if (fs.statSync(full).isDirectory()) {
        for (const e of fs.readdirSync(full)) walk(path.join(p, e));
        return;
      }
      if (!/\.(ts|tsx)$/.test(p)) return;
      const src = fs.readFileSync(full, "utf8");
      // Real credential shapes, not the words used to describe them.
      if (/gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(src)) {
        bad.push(p);
      }
    };
    files.forEach(walk);
    check("no credential is committed in source", bad.length === 0, bad);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
