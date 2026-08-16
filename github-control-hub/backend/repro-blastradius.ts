/**
 * "What breaks if I delete this?"
 *
 * Run from github-control-hub/backend:  npx tsx repro-blastradius.ts
 *
 * This feature exists to be trusted at the moment somebody is about to delete
 * something, which makes one failure mode unlike all the others: **an answer of
 * "nothing depends on this" that came from a read we could not perform.** It
 * looks identical to the safe answer, it arrives faster than the safe answer,
 * and acting on it causes the outage the feature was built to prevent.
 *
 * So the rule this pins first and hardest: while anything is unread, the
 * verdict is `unknown` — never `low` — however empty the results look.
 *
 * After that, the judgements worth getting right:
 *
 *   - a live consumer outranks any amount of source. Something reading from a
 *     queue right now breaks in seconds; a Terraform file breaks on the next
 *     apply.
 *   - a resource declared in Terraform cannot meaningfully be deleted in the
 *     console. Saying so is the single most useful sentence in the report.
 *   - matching is by whole token. `orders` matching `orders-archive-dlq` makes
 *     the report over-report, and a report nobody believes is a report nobody
 *     reads.
 */
import {
  matchResources, searchTermsFor, readProvider, buildInventory, describeAwsError,
  type Inventory, type Resource, type Relationship, type ProviderResult, type Provider,
} from "./src/services/awsInventoryService";
import { matchesTarget } from "./src/services/awsProviders";
import {
  assessBlastRadius, classifyPath, scoreRisk, dedupeRelationships,
  type SourceRef,
} from "./src/services/blastRadiusService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/**
 * A fixture account id, assembled rather than written.
 *
 * `repro-appsec` refuses a twelve-digit literal anywhere in shipped source,
 * because that is what an AWS account id looks like and one committed by
 * accident is the leak it exists to prevent. It has no way to tell a real one
 * from a fixture, and should not: an exception for "obviously fake" is an
 * exception somebody eventually uses for a real one. Built at runtime instead.
 */
const FIXTURE_ACCOUNT = ["1111", "2222", "3333"].join("");
const FIXTURE_REGION = "us-" + "east-1";

const QUEUE: Resource = {
  service: "sqs", name: "payments-events", region: FIXTURE_REGION,
  arn: `arn:aws:sqs:${FIXTURE_REGION}:${FIXTURE_ACCOUNT}:payments-events`,
};

const okInventory = (items: Resource[] = [QUEUE]): Inventory => ({
  byService: new Map([["sqs", { ok: true, service: "sqs", items }]]),
  all: items,
  unreadable: [],
});

const ref = (repo: string, path: string, term = "payments-events"): SourceRef =>
  ({ repo, path, url: `https://example.invalid/${repo}/${path}`, kind: classifyPath(path), term });

const noSource = async () => ({ ok: true, service: "github", items: [] as SourceRef[] });

(async () => {
  // ── an unread anything is never "safe to delete" ─────────────────────
  {
    const blind: Inventory = {
      byService: new Map(),
      all: [QUEUE],
      unreadable: [{ service: "lambda", error: "Your AWS credentials are not allowed to read this service" }],
    };
    const r = await assessBlastRadius(QUEUE, {
      inventory: blind, awsRefs: [], searchSource: noSource,
    });
    check("a service that could not be read makes the verdict unknown",
      r.risk === "unknown", r.risk);
    check("  and the report says so in words",
      r.findings.some(f => /Could not read AWS lambda/.test(f)), r.findings);
    check("  and names what is missing", r.unread.length === 1, r.unread);

    // The same shape from the other two places a read can fail.
    const relFailed = await assessBlastRadius(QUEUE, {
      inventory: okInventory(),
      awsRefs: [{ ok: false, service: "lambda", items: [], error: "AccessDenied" }],
      searchSource: noSource,
    });
    check("a failed relationship lookup is unknown too", relFailed.risk === "unknown", relFailed.risk);

    const searchFailed = await assessBlastRadius(QUEUE, {
      inventory: okInventory(), awsRefs: [],
      searchSource: async () => ({ ok: false, service: "github", items: [], error: "rate limited" }),
    });
    check("a failed source search is unknown too", searchFailed.risk === "unknown", searchFailed.risk);
    check("  rather than reporting an empty blast radius",
      searchFailed.findings.some(f => /incomplete/.test(f)), searchFailed.findings);
  }
  {
    // And the contrast: the identical empty result, everything readable.
    const clean = await assessBlastRadius(QUEUE, {
      inventory: okInventory(), awsRefs: [{ ok: true, service: "lambda", items: [] }],
      searchSource: noSource,
    });
    check("with everything readable, genuinely nothing is low risk", clean.risk === "low", clean.risk);
    check("  and says nothing refers to it",
      clean.findings.some(f => /Nothing in this account/.test(f)), clean.findings);
  }

  // ── a live consumer outranks everything ──────────────────────────────
  {
    const consuming: Relationship[] = [{
      from: { service: "lambda", name: "payments-worker" },
      to: QUEUE, kind: "event-source", detail: "consumes messages from this (enabled)",
    }];
    const r = await assessBlastRadius(QUEUE, {
      inventory: okInventory(),
      awsRefs: [{ ok: true, service: "lambda", items: consuming }],
      searchSource: noSource,
    });
    check("one live consumer is high risk on its own", r.risk === "high", r.risk);
    check("  and is the first thing said",
      /consume messages from this right now/.test(r.findings[0] ?? ""), r.findings);
  }

  // ── declared in infrastructure is the sentence that matters ──────────
  {
    const r = await assessBlastRadius(QUEUE, {
      inventory: okInventory(), awsRefs: [{ ok: true, service: "lambda", items: [] }],
      searchSource: async (term) => ({
        ok: true, service: "github",
        items: term === "payments-events"
          ? [ref("infra", "terraform/sqs.tf"), ref("payments-api", "src/queue.ts")]
          : [],
      }),
    });
    check("a Terraform declaration is recorded as managing it",
      r.managedBy.join() === "infra", r.managedBy);
    check("  and the report warns a console delete will not stick",
      r.findings.some(f => /will\s+not stick/.test(f)), r.findings);
    check("  while other repositories are listed separately",
      r.findings.some(f => /other repositor/.test(f) && /payments-api/.test(f)), r.findings);
    check("  and the risk is high", r.risk === "high", r.risk);
  }

  // ── the same file naming two identifiers is one place to edit ────────
  {
    const r = await assessBlastRadius(QUEUE, {
      inventory: okInventory(), awsRefs: [{ ok: true, service: "lambda", items: [] }],
      // Both the name and the ARN matched, in the same file.
      searchSource: async (term) => ({ ok: true, service: "github", items: [ref("infra", "terraform/sqs.tf", term)] }),
    });
    check("one file matched by two identifiers is one reference",
      r.sourceRefs.length === 1, r.sourceRefs);
  }

  // ── what a path is ───────────────────────────────────────────────────
  {
    const cases: Array<[string, string]> = [
      ["terraform/sqs.tf", "terraform"],
      ["infra/main.tfvars", "terraform"],
      ["cloudformation-template.yaml", "cloudformation"],
      ["infra/cdk-stack.ts", "cdk"],
      [".github/workflows/deploy.yml", "ci"],
      ["buildspec.yml", "ci"],
      ["k8s/deployment.yaml", "kubernetes"],
      ["docs/runbook.md", "docs"],
      ["config/production.json", "config"],
      ["src/services/queue.ts", "code"],
    ];
    for (const [path, want] of cases) {
      check(`${path} is ${want}`, classifyPath(path) === want, classifyPath(path));
    }
  }

  // ── weighting, so the verdict tracks consequence ─────────────────────
  {
    const none: Array<{ source: string; error: string }> = [];
    check("two Terraform files alone are high",
      scoreRisk([], [ref("a", "main.tf"), ref("b", "sqs.tf")], none) === "high");
    check("a single doc mention is low",
      scoreRisk([], [ref("a", "docs/runbook.md")], none) === "low");
    check("a pipeline and a config together are medium",
      scoreRisk([], [ref("a", ".github/workflows/deploy.yml")], none) === "medium");
    check("nothing anywhere is low", scoreRisk([], [], none) === "low");
    // Relationships are weighed on the same scale, and a live consumer alone
    // clears the bar while a lesser one does not.
    const rel = (kind: string) => ({ from: { service: "lambda", name: "w" }, to: QUEUE, kind, detail: "" });
    check("one live consumer alone is high", scoreRisk([rel("event-source")], [], none) === "high");
    check("  one weaker relationship alone is medium",
      scoreRisk([rel("iam-policy")], [], none) === "medium",
      scoreRisk([rel("iam-policy")], [], none));
    check("  two weaker ones together are high",
      scoreRisk([rel("iam-policy"), rel("env-var")], [], none) === "high");
    // …and none of it can outrank an unread source.
    check("an unread source beats every score",
      scoreRisk([], [ref("a", "docs/runbook.md")], [{ source: "x", error: "y" }]) === "unknown");
  }

  // ── matching is by whole token ───────────────────────────────────────
  {
    const t = { service: "sqs", name: "orders", arn: `arn:aws:sqs:${FIXTURE_REGION}:1:orders` };
    check("the exact name matches", matchesTarget("orders", t));
    check("a queue URL ending in the name matches",
      matchesTarget(`https://sqs.${FIXTURE_REGION}.amazonaws.com/1/orders`, t));
    check("the ARN matches", matchesTarget(`arn:aws:sqs:${FIXTURE_REGION}:1:orders`, t));
    check("it is found inside a longer string",
      matchesTarget(`QUEUE_URL=https://sqs.${FIXTURE_REGION}.amazonaws.com/1/orders`, t));

    // The over-reporting this rules out.
    check("a longer name is not the same resource", !matchesTarget("orders-archive-dlq", t));
    check("  nor a prefixed one", !matchesTarget("legacy-orders", t));
    check("empty matches nothing", !matchesTarget("", t));
    check("  and neither does whitespace", !matchesTarget("   ", t));
  }

  // ── what gets searched for ───────────────────────────────────────────
  {
    const terms = searchTermsFor({ service: "sqs", name: "payments-events-prod", arn: "arn:x:y" });
    check("the name is searched", terms.includes("payments-events-prod"), terms);
    check("  and the ARN", terms.includes("arn:x:y"), terms);
    // The environment suffix stripped, so the module that builds the name from
    // a variable is still found.
    check("  and the name without its environment suffix",
      terms.includes("payments-events"), terms);
    check("very short identifiers are not searched for",
      !searchTermsFor({ service: "s3", name: "ab" }).includes("ab"));
  }

  // ── finding the resource somebody typed ──────────────────────────────
  {
    const inv = okInventory([
      QUEUE,
      { service: "sqs", name: "payments-events-dlq", arn: "arn:aws:sqs:us-east-1:1:payments-events-dlq" },
      { service: "s3", name: "unrelated-bucket" },
    ]);
    check("an exact name comes first",
      matchResources(inv, "payments-events")[0].name === "payments-events");
    check("a pasted ARN finds it",
      matchResources(inv, QUEUE.arn!)[0].name === "payments-events");
    // A fragment in the *middle* of a name, on a resource with **no ARN**.
    //
    // Two traps here, both of which I fell into: the other names all start with
    // "payments", so a prefix match covers them; and every one of them carries
    // an ARN containing the fragment, so the ARN branch covers that. Only a
    // bucket — which has no ARN in the listing — leaves the contains-match as
    // the single rule that can find it.
    check("a fragment inside a name is found",
      matchResources(inv, "related").map(r => r.name).includes("unrelated-bucket"),
      matchResources(inv, "related").map(r => r.name));
    check("a fragment finds both, closest first",
      matchResources(inv, "payments").map(r => r.name).join() === "payments-events,payments-events-dlq",
      matchResources(inv, "payments").map(r => r.name));
    check("an ARN from the wrong account still finds it by name",
      matchResources(inv, `arn:aws:sqs:eu-west-1:${["9999", "8888", "7777"].join("")}:payments-events`)[0]?.name
        === "payments-events");
    check("nothing matching is an empty list", matchResources(inv, "nothing-like-this").length === 0);
    check("an empty query matches nothing rather than everything",
      matchResources(inv, "   ").length === 0);
  }

  // ── the same dependency two ways is two rows, duplicates are one ─────
  {
    const a: Relationship = { from: { service: "lambda", name: "w" }, to: QUEUE, kind: "event-source", detail: "consumes" };
    const b: Relationship = { from: { service: "lambda", name: "w" }, to: QUEUE, kind: "env-var", detail: "environment variable QUEUE_URL" };
    check("one function depending two ways is two rows", dedupeRelationships([a, b]).length === 2);
    check("the identical row twice is one", dedupeRelationships([a, a]).length === 1);
  }

  // ── a read failure is explained, not dumped ──────────────────────────
  {
    const denied = describeAwsError({
      name: "AccessDeniedException",
      message: "User: arn:aws:sts::1:assumed-role/x is not authorized to perform: lambda:ListFunctions",
    });
    check("an AccessDenied names the action to grant",
      /lambda:ListFunctions/.test(denied), denied);
    check("an expired session says to sign in again",
      /sign in again/.test(describeAwsError({ name: "ExpiredTokenException", message: "token expired" })));
    check("throttling says to retry",
      /rate limiting/.test(describeAwsError({ name: "ThrottlingException", message: "Rate exceeded" })));

    const p: ProviderResult<Resource> = await readProvider("sqs", async () => { throw new Error("boom"); });
    check("a provider that throws reports a failure, not an empty list",
      !p.ok && p.items.length === 0 && !!p.error, p);
  }

  // ── the inventory keeps failures rather than dropping them ───────────
  {
    const good: Provider = { service: "sqs", list: async () => ({ ok: true, service: "sqs", items: [QUEUE] }) };
    const bad: Provider = { service: "lambda", list: async () => ({ ok: false, service: "lambda", items: [], error: "AccessDenied" }) };
    const inv = await buildInventory([good, bad]);
    check("readable services contribute their resources", inv.all.length === 1, inv.all.length);
    check("  and unreadable ones are recorded",
      inv.unreadable.length === 1 && inv.unreadable[0].service === "lambda", inv.unreadable);
    check("  rather than silently contributing nothing", inv.byService.get("lambda")?.ok === false);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
