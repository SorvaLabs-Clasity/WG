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
  //
  // The EBS-encryption and IMDSv2 checks that used to live here asserted
  // properties of the EC2 instance. The webhook-on-Lambda migration deleted
  // that instance outright, so there is no root volume and no instance
  // metadata service left to check.
  {
    // Every queue, not "the dead-letter queue": testing encryption/enforceSSL
    // against the whole file passes as soon as any one queue has them, so a
    // fourth queue added without either would pass unnoticed as long as an
    // already-compliant queue (guardrailDlq, say) still exists anywhere in
    // cdk-stack.ts. Each `new sqs.Queue(...)` call is sliced out by matching
    // parens rather than lines, since the deadLetterQueue block nests braces
    // of its own inside webhookQueue's constructor call.
    const queues: string[] = [];
    const marker = "new sqs.Queue(";
    for (let i = cdk.indexOf(marker); i !== -1; i = cdk.indexOf(marker, i + 1)) {
      let depth = 0, j = i + marker.length - 1; // start at the "("
      do {
        if (cdk[j] === "(") depth++;
        else if (cdk[j] === ")") depth--;
        j++;
      } while (depth > 0 && j < cdk.length);
      queues.push(cdk.slice(i, j));
    }

    check("at least one sqs.Queue was found to check", queues.length > 0, queues.length);

    for (const q of queues) {
      const name = /new sqs\.Queue\(this,\s*"([^"]+)"/.exec(q)?.[1] ?? "(unnamed queue)";
      check(`${name} is encrypted`,
        /encryption:\s*sqs\.QueueEncryption\./.test(q));
      check(`  and ${name} refuses plaintext transport`,
        /enforceSSL:\s*true/.test(q));
    }
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
    const verify   = read("github-control-hub/backend/src/webhooks/verify.ts");
    const receiver = read("github-control-hub/backend/src/webhooks/receiver.ts");
    const worker   = read("github-control-hub/backend/src/webhooks/worker.ts");

    // code() throughout this block: a comment can name the same call or
    // condition it documents, and a raw regex cannot tell a live line from
    // a dead one wearing its comment as camouflage.
    check("webhook signatures are compared in constant time",
      /timingSafeEqual/.test(code(verify)));
    check("  and a missing secret fails closed",
      /if \(!secret\) return false/.test(code(verify)), "an absent webhook secret would accept anything");

    // Sliced to the handler body: claimDelivery is also named in the import
    // statement above it, so a check against the full source would still
    // pass if the handler's own call to it were deleted and the now-unused
    // import were left behind.
    const workerCode = code(worker);
    const workerBody = workerCode.slice(workerCode.indexOf("export async function handler"));
    check("  replays are rejected",
      /claimDelivery/.test(workerBody));

    // Sliced to the handler body rather than checked against the whole file:
    // verifyGitHubSignature is also named in the import statement above the
    // handler, so a check against the full source would still pass if the
    // handler body itself called things in the wrong order.
    const receiverCode = code(receiver);
    const receiverBody = receiverCode.slice(receiverCode.indexOf("export async function handler"));

    // The receiver's whole job is to not put anything unverified on the queue.
    check("  nothing is queued before the signature verifies",
      receiverBody.indexOf("statusCode: 401") < receiverBody.indexOf("await send("),
      "an unverified payload would reach the worker");

    // The signature covers the bytes as sent. Parsing first breaks every one.
    check("  the body is not parsed before it is verified",
      receiverBody.indexOf("verifyGitHubSignature") < receiverBody.indexOf("JSON.parse"),
      "a re-serialised body is a different sequence of bytes");

    // A verified payload is authentic, not trustworthy. GitHub really sent it,
    // but its contents are whatever a person typed — and anyone who can push a
    // branch chooses that string. Git's ref rules forbid spaces and ~^:?*[\
    // and allow < > " ' &, so a branch name is the field here most able to
    // carry markup into a row the UI later renders.
    //
    // Nothing renders raw HTML today, so this is depth rather than a live
    // hole. It is pinned because the day something does — an HTML export, a
    // dangerouslySetInnerHTML — the gap would already be in the stored data.
    const deliveryCode = code(read("github-control-hub/backend/src/webhooks/processDelivery.ts"));

    // Only the calls that *store* something are checked. Comparing
    // payload.ref against a default-branch name, or testing ref_type, keeps
    // nothing and needs no sanitising — an earlier version of this check
    // flagged those too and failed against correct code.
    const STORING = /\b(logActivity|createAlert|addBranchEdge|removeBranchEdge)\s*\(/;
    const rawStores = deliveryCode
      .split("\n")
      .filter(l => STORING.test(l))
      // Blank out the wrapped uses; whatever payload reference survives is raw.
      .map(l => l.replace(/sanitizeField\([^)]*\)/g, "SAFE"))
      // A comparison keeps nothing. `payload.action === "created" ? a : b`
      // chooses between two literals, so the payload never reaches the row.
      .map(l => l.replace(/payload\.[\w?.]+\s*===/g, "CMP ==="))
      .filter(l => /payload\./.test(l))
      .map(l => l.trim().slice(0, 90));

    check("  nothing from a payload is stored without being sanitised",
      rawStores.length === 0,
      rawStores.length ? rawStores
        : "a branch or repository name would reach the activity log and graph raw");
  }

  // ── the org-wide token is never served over a socket ───────────────
  //
  // GET /auth/system-token returned the GitHub App installation token —
  // admin over every repository in the organisation — to anyone who could
  // reach the port, with no authentication of any kind. Its only caller runs
  // in the same process as the backend and now calls the function directly.
  {
    check("no route hands out the system token",
      !/router\.\w+\(\s*["'][^"']*system-token/.test(code(auth)),
      "an HTTP route returns the GitHub App token again");

    check("  the updater reads it in-process instead",
      /readSystemToken/.test(electron) && !/system-token/.test(code(electron)),
      "the desktop updater is fetching the token over HTTP again");
  }

  // ── the desktop app is not a network service ───────────────────────
  //
  // listen(port) with no host binds 0.0.0.0. On a laptop that published an
  // administrative API for a GitHub org and several AWS accounts to whatever
  // network it was joined to.
  {
    const desktopServer = read("github-control-hub/desktop/src/server.ts");
    check("the desktop backend binds loopback only",
      /listen\(\s*port\s*,\s*["']127\.0\.0\.1["']/.test(code(desktopServer)),
      "the desktop listener is bound to every interface");

    check("  and so does the dev server",
      /listen\(\s*PORT\s*,\s*["']127\.0\.0\.1["']/.test(code(server)),
      "the dev listener is bound to every interface");
  }

  // ── setup routes refuse cross-site callers ─────────────────────────
  //
  // These are reachable without a session by design, so CSRF was the whole
  // exposure: any open page could POST to localhost and disconnect AWS.
  {
    check("desktop setup routes check the request's origin",
      /sameOriginOnly/.test(code(auth)));

    const stateChanging = [
      "invalidate-aws", "reconnect-aws", "aws-sso-login",
      "aws-use-profile", "aws-access-keys", "aws-profiles",
    ];
    const unguarded = stateChanging.filter(r => {
      const m = auth.match(new RegExp(`router\\.\\w+\\(\\s*["']/${r}["'][^)]*`));
      return !m || !/sameOriginOnly/.test(m[0]);
    });
    check("  every one of them names the guard", unguarded.length === 0, unguarded);
  }

  // ── one-time codes are actually one-time ───────────────────────────
  //
  // Get-then-Delete returned the same code to two callers racing through the
  // gap, and a DynamoDB `ttl` is swept within ~48 hours rather than at the
  // moment it expires — so neither single use nor the five-minute window was
  // being enforced where it mattered.
  {
    check("auth codes are redeemed by the delete itself",
      /ReturnValues:\s*["']ALL_OLD["']/.test(code(auth)),
      "the code is read and then deleted, which is not single-use");

    check("  and their expiry is checked here, not left to DynamoDB",
      (code(auth).match(/item\.ttl \* 1000 < Date\.now\(\)/g) ?? []).length >= 2,
      "an expired code or state would still be accepted");
  }

  // ── tokens name their algorithm ────────────────────────────────────
  {
    const jwtSrc = read("github-control-hub/backend/src/utils/jwt.ts");
    check("JWTs are verified against an explicit algorithm",
      /algorithms:\s*\[ALGORITHM\]/.test(jwtSrc) && /ALGORITHM = "HS256"/.test(jwtSrc),
      "verification accepts whatever the library infers");
  }

  // The self-signed TLS key this block used to guard existed solely on the
  // EC2 instance's user-data: a chmod-644 check would have caught it being
  // made world-readable, and a chmod-600 check confirmed the correct mode.
  // The webhook-on-Lambda migration deleted that instance and its user-data
  // outright, so there is no key left to protect and nothing left to assert.

  // ── CI holds no more than it needs ─────────────────────────────────
  {
    const wf = read(".github/workflows/release.yml");
    const workflowLevel = wf.slice(0, wf.indexOf("jobs:"));
    check("the workflow's default token is read-only",
      /permissions:\s*\n\s*contents:\s*read/.test(workflowLevel),
      "every job, including the one that runs npm lifecycle scripts, can write to the repo");
    check("  and only the release job asks for write",
      /release:[\s\S]*?permissions:\s*\n\s*contents:\s*write/.test(wf));
  }

  // ── no invented AWS region ─────────────────────────────────────────
  {
    // A hardcoded fallback is worse than none: the SDK resolves a region from
    // the signed-in profile, and naming one here overrides that. A desktop user
    // whose profile lives in eu-west-1 read us-east-1 and found an empty
    // account, with nothing failing.
    const files = [
      "github-control-hub/backend/src", "github-control-hub/desktop/src",
      "github-control-hub/infra/cdk-app.ts", "github-control-hub/infra/cdk-stack.ts",
    ];
    const offenders: string[] = [];
    const walk = (rel: string) => {
      const full = path.join(ROOT, rel);
      if (fs.statSync(full).isDirectory()) {
        for (const e of fs.readdirSync(full)) walk(path.join(rel, e));
        return;
      }
      if (!/\.tsx?$/.test(rel)) return;
      for (const line of code(fs.readFileSync(full, "utf8")).split("\n")) {
        // The two legitimate ones: Organizations' endpoint really is us-east-1,
        // and S3 reports a us-east-1 bucket with an empty LocationConstraint.
        if (/OrganizationsClient|BucketRegion|console\.aws\.amazon\.com/.test(line)) continue;
        if (/(AWS_REGION|CDK_DEFAULT_REGION)[^\n]*\|\|[^\n]*["']us-east-1["']/.test(line)) {
          offenders.push(rel + ": " + line.trim().slice(0, 70));
        }
      }
    };
    files.forEach(walk);
    check("no code falls back to a region nobody chose", offenders.length === 0, offenders);

    const scripts = ["scripts/setup-aws-account.sh", "scripts/setup-cloudtrail.sh"];
    for (const sc of scripts) {
      const src = fs.readFileSync(path.join(ROOT, sc), "utf8");
      check(`  ${sc.split("/")[1]} requires a region rather than assuming one`,
        /region_or_die/.test(src) && !/AWS_REGION:-us-east-1/.test(src), sc);
    }

    const cdkApp = fs.readFileSync(path.join(ROOT, "github-control-hub/infra/cdk-app.ts"), "utf8");
    check("  and cdk refuses to deploy to a region nobody named",
      /Refusing to guess/.test(cdkApp), "cdk-app.ts still has a region default");
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
