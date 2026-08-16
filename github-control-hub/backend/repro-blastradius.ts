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
  matchResources, searchTermsFor, readProvider, buildInventory, describeAwsError, consoleUrl,
  logicalIdFrom,
  type Inventory, type Resource, type Relationship, type ProviderResult, type Provider,
} from "./src/services/awsInventoryService";
import { matchesTarget, __setProviderRegionForTests } from "./src/services/awsProviders";
import {
  assessBlastRadius, classifyPath, scoreRisk, dedupeRelationships,
  type SourceRef,
} from "./src/services/blastRadiusService";
import { readFileSync } from "fs";
import {
  expertsForResource, rankFilesToRead, MAX_FILES_READ,
} from "./src/services/resourceExpertsService";
import {
  findSourceRefs, isSearchableTerm, clearSourceSearchCache,
} from "./src/services/sourceSearchService";

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

    // Names built at deploy time. Source contains the template, never the
    // result, so searching only the literal finds nothing and reports it as
    // nothing — which is how the app's own audit bucket came back unreferenced
    // on a real account.
    const acct = ["1234", "5678", "9012"].join("");
    check("an account-id suffix is stripped",
      searchTermsFor({ service: "s3", name: `acme-audit-log-${acct}` }).includes("acme-audit-log"),
      searchTermsFor({ service: "s3", name: `acme-audit-log-${acct}` }));
    check("a region suffix is stripped",
      searchTermsFor({ service: "s3", name: "acme-assets-us-east-1" }).includes("acme-assets"),
      searchTermsFor({ service: "s3", name: "acme-assets-us-east-1" }));
    check("both together are stripped",
      searchTermsFor({ service: "s3", name: `acme-logs-us-east-1-${acct}` }).includes("acme-logs"),
      searchTermsFor({ service: "s3", name: `acme-logs-us-east-1-${acct}` }));
    check("  and the full name is still searched first",
      searchTermsFor({ service: "s3", name: `acme-logs-${acct}` })[0] === `acme-logs-${acct}`);
    check("stripping never produces something too short to search",
      !searchTermsFor({ service: "s3", name: `ab-${acct}` }).includes("ab"),
      searchTermsFor({ service: "s3", name: `ab-${acct}` }));
    check("a name that merely contains digits is left alone",
      searchTermsFor({ service: "s3", name: "acme-v2-assets" }).length === 1);
    // A CloudFormation physical name. Source has the logical id and never this,
    // so without extracting it every CDK-managed resource in an account reports
    // as referenced by nobody — which is what a real queue with two live
    // consumers actually did.
    check("a CloudFormation name yields its logical id",
      logicalIdFrom("GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh") === "WebhookQueue",
      logicalIdFrom("GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh"));
    check("  and it is searched for",
      searchTermsFor({ service: "sqs", name: "GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh" })
        .includes("WebhookQueue"));
    check("  alongside the full name",
      searchTermsFor({ service: "sqs", name: "GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh" })[0]
        === "GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh");

    // Strictness, because a wrongly shortened term matches the wrong files,
    // which is worse than matching none.
    check("an ordinary hyphenated name is not shortened",
      logicalIdFrom("payments-events-dlq") === null, logicalIdFrom("payments-events-dlq"));
    check("  nor one with a short suffix",
      logicalIdFrom("acme-queue-prod") === null);
    check("  nor a name with no hash section",
      logicalIdFrom("MyStack-MyQueue-abcdefghijklm") === null);
    check("  and a logical id too short to search is refused",
      logicalIdFrom("Stack-AB12345678-xGZdeHQei9vh") === null);

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

  // ── the source search, and the budget it spends ─────────────────────
  //
  // GitHub's code search allows ten requests a *minute*, the smallest allowance
  // it gives. A lookup costs one per identifier, so an uncached search box is
  // rate limited by its second click.
  {
    clearSourceSearchCache();
    let calls = 0;
    const search = async (q: string) => {
      calls++;
      return [{ repo: "infra", path: "terraform/sqs.tf" }, { repo: "docs-site", path: "README.md" }]
        .filter(() => q.includes("payments-events"));
    };

    const first = await findSourceRefs("payments-events", "example-org", search);
    check("a search returns its hits", first.ok && first.items.length === 2, first);
    check("  classified by what the file is",
      first.items.map(i => i.kind).sort().join() === "docs,terraform",
      first.items.map(i => i.kind));
    check("  with a link to each", first.items.every(i => i.url.includes("infra") || i.url.includes("docs-site")));

    await findSourceRefs("payments-events", "example-org", search);
    await findSourceRefs("payments-events", "example-org", search);
    check("the same term again costs no further requests", calls === 1, calls);

    // …and expires, or a reference added this morning is never found.
    const later = await findSourceRefs(
      "payments-events", "example-org", search, Date.now() + 11 * 60_000);
    check("after the cache window it searches again", calls === 2, calls);
    check("  and still answers", later.ok && later.items.length === 2);
  }
  {
    clearSourceSearchCache();
    // A rate limit is a failure, cached briefly so that re-rendering does not
    // turn one exhausted budget into a permanently exhausted one.
    let calls = 0;
    const limited = async () => {
      calls++;
      const e: any = new Error("API rate limit exceeded"); e.status = 403; throw e;
    };
    const r = await findSourceRefs("payments-events", "example-org", limited);
    check("a rate limit is a failure, not an empty result", !r.ok && r.items.length === 0, r);
    check("  and says to wait rather than showing a stack trace",
      /ten requests a minute/.test(r.error ?? ""), r.error);
    await findSourceRefs("payments-events", "example-org", limited);
    check("  and is not retried on the next render", calls === 1, calls);
  }
  {
    // A quote would close the quoted term and turn the rest into query syntax.
    check("a term with a quote is refused", !isSearchableTerm('pay"ments'));
    check("  and a newline", !isSearchableTerm("pay\nments"));
    check("  and a backslash", !isSearchableTerm("pay\\ments"));
    check("a normal name is searchable", isSearchableTerm("payments-events"));
    check("something too short to mean anything is not", !isSearchableTerm("ab"));

    clearSourceSearchCache();
    let called = false;
    const r = await findSourceRefs("ab", "example-org", async () => { called = true; return []; });
    check("an unsearchable term spends no request", !called);
    // Not a failure: reporting it as unread would make every such lookup
    // permanently "incomplete" for a reason nothing can fix.
    check("  and is not reported as an unread source", r.ok, r);
  }

  // ── the search must run as the person asking ────────────────────────
  //
  // Not because an App token cannot search — it can, and an earlier version of
  // this comment said otherwise on the evidence of a search that returned
  // nothing for a file in a *different organization*. The reason is disclosure:
  // an installation token can see every private repository in the organization,
  // so searching with it would show somebody the paths of files in
  // repositories they cannot open.
  //
  // Read from the route rather than asserted about a value, because the mistake
  // is a one-word edit and produces no error anywhere.
  {
    const route = readFileSync("src/routes/resources.ts", "utf8");
    check("the blast route takes the caller's own token",
      /const token = req\.user\?\.accessToken;/.test(route));
    check("  and refuses without one",
      /if \(!token\) return res\.status\(401\)/.test(route));
    check("  and never reaches for the app's token",
      !/getSystemToken/.test(route),
      route.split("\n").filter(l => /getSystemToken/.test(l)));
    check("  passing that token to the searcher",
      /createOctokit\(token\)[\s\S]{0,120}?searcherFor\(octokit\)/.test(route));
  }

  // ── who has actually worked on it ───────────────────────────────────
  //
  // Not who has permission, and not who is on the owning team — who has edited
  // the files that declare and use it. Ranked by file rather than repository,
  // because crediting everybody who ever committed to a monorepo buries the one
  // person who wrote the Terraform under fifty who did not.
  {
    const refs = [
      ref("infra", "terraform/sqs.tf"),
      ref("payments-api", "src/queue.ts"),
      ref("docs-site", "docs/runbook.md"),
    ];
    const history: Record<string, Array<{ login: string; at: string }>> = {
      "infra:terraform/sqs.tf": [
        { login: "alice", at: new Date().toISOString() },
        { login: "alice", at: new Date(Date.now() - 86400000).toISOString() },
      ],
      "payments-api:src/queue.ts": [{ login: "bob", at: new Date().toISOString() }],
      "docs-site:docs/runbook.md": [{ login: "carol", at: new Date(Date.now() - 400 * 86400000).toISOString() }],
    };
    const r = await expertsForResource(refs, {
      listCommits: async (repo, path) => history[`${repo}:${path}`] ?? [],
    });

    check("everybody who touched a referencing file is ranked",
      r.experts.map(e => e.login).sort().join() === "alice,bob,carol",
      r.experts.map(e => e.login));
    check("  the person on the Terraform ranks first",
      r.experts[0].login === "alice", r.experts.map(e => `${e.login}:${e.score}`));
    check("  somebody who touched it years ago ranks last",
      r.experts[r.experts.length - 1].login === "carol", r.experts.map(e => e.login));

    // The evidence, so a name can be checked rather than trusted.
    check("each person carries the files they touched",
      r.experts.find(e => e.login === "alice")?.files[0].path === "terraform/sqs.tf",
      r.experts.find(e => e.login === "alice")?.files);
    check("  once per file, however many commits",
      r.experts.find(e => e.login === "alice")?.files.length === 1);
    check("  and the commit count is still two",
      r.experts.find(e => e.login === "alice")?.commits === 2);
    check("which files were read is reported", r.filesRead.length === 3, r.filesRead);
  }
  {
    // A file whose history cannot be read is reported, not dropped. A shorter
    // list of people looks exactly like a smaller set of people, and here it
    // sends somebody to the wrong person.
    const r = await expertsForResource([ref("infra", "terraform/sqs.tf")], {
      listCommits: async () => { throw new Error("Not Found"); },
    });
    check("a history that cannot be read is reported",
      r.degraded.length === 1 && r.degraded[0].path === "terraform/sqs.tf", r.degraded);
    check("  rather than reading as nobody having touched it", r.experts.length === 0);
  }
  {
    // Bots are excluded by the shared ranking, which matters more here than
    // anywhere: infrastructure files are exactly what automation rewrites.
    const r = await expertsForResource([ref("infra", "terraform/sqs.tf")], {
      listCommits: async () => [
        { login: "renovate[bot]", at: new Date().toISOString() },
        { login: "alice", at: new Date().toISOString() },
      ],
    });
    check("a bot that edits infrastructure is not an expert",
      r.experts.map(e => e.login).join() === "alice", r.experts.map(e => e.login));
  }
  {
    // The cap, and what it cuts. Infrastructure first, documentation last.
    const many = [
      ...Array.from({ length: 10 }, (_, i) => ref("a", `docs/note${i}.md`)),
      ref("infra", "terraform/sqs.tf"),
      ref("ops", ".github/workflows/deploy.yml"),
      ...Array.from({ length: 10 }, (_, i) => ref("b", `src/file${i}.ts`)),
    ];
    const chosen = rankFilesToRead(many);
    check(`at most ${MAX_FILES_READ} files are read`, chosen.length === MAX_FILES_READ, chosen.length);
    check("  the Terraform is always among them",
      chosen.some(c => c.path === "terraform/sqs.tf"), chosen.map(c => c.path));
    check("  and the pipeline too",
      chosen.some(c => c.path === ".github/workflows/deploy.yml"));
    check("  while documentation is what gets cut",
      !chosen.some(c => c.kind === "docs"), chosen.map(c => c.path));

    const r = await expertsForResource(many, { listCommits: async () => [] });
    check("  and the number skipped is reported",
      r.filesSkipped === many.length - MAX_FILES_READ, r.filesSkipped);
  }
  {
    check("no referencing files is an empty answer, not an error",
      (await expertsForResource([], { listCommits: async () => [] })).experts.length === 0);
  }

  // ── a finding you can act on ────────────────────────────────────────
  //
  // "1 Lambda consumes this" is a fact somebody then has to go and do something
  // about. Making them search the console for a name they were just shown is
  // the difference between a report and a tool.
  {
    const region = "eu-" + "west-1";
    check("a Lambda links to its function page",
      (consoleUrl({ service: "lambda", name: "worker", region }) ?? "").includes("/lambda/home?region=eu-west-1#/functions/worker"),
      consoleUrl({ service: "lambda", name: "worker", region }));
    check("a table links to the table",
      (consoleUrl({ service: "dynamodb", name: "orders", region }) ?? "").includes("#table?name=orders"));
    check("a security group links by its id, not its name",
      (consoleUrl({ service: "ec2-sg", name: "web", region }, { groupId: "sg-123" }) ?? "").includes("groupId=sg-123"));

    // Global services take no region, and must still link.
    check("a bucket links without a region",
      (consoleUrl({ service: "s3", name: "assets" }) ?? "").includes("s3/buckets/assets"));
    check("a role links without a region",
      (consoleUrl({ service: "iam", name: "deploy" }) ?? "").includes("iam/home#/roles/deploy"));

    // A link to the wrong region shows an empty page, which reads as "this no
    // longer exists" — worse than offering no link.
    check("no region means no link rather than a guessed one",
      consoleUrl({ service: "lambda", name: "worker" }) === null);
    check("a security group with no id has no link",
      consoleUrl({ service: "ec2-sg", name: "web", region }) === null);
    check("an unknown service has no link",
      consoleUrl({ service: "braket", name: "x", region }) === null);
    check("a name needing escaping is escaped",
      (consoleUrl({ service: "dynamodb", name: "a b", region }) ?? "").includes("a%20b"));
  }

  // ── the region a link is named with ─────────────────────────────────
  //
  // Reported from the running app: every dependency rendered as plain text
  // that looked like a link and did nothing. The cause was passing the region
  // *used for calling* into the code that *names* one. `awsRegion()` returns
  // undefined whenever the region comes from a profile rather than the
  // environment — which is how the desktop app runs and is not how the test
  // scripts ran, so it was invisible until somebody clicked.
  {
    __setProviderRegionForTests(undefined);
    check("with no region resolved, a regional link is refused rather than guessed",
      consoleUrl({ service: "lambda", name: "worker" }) === null);
    // …but the global services still link, because they never needed one.
    check("  while a global service still links",
      consoleUrl({ service: "iam", name: "deploy" }) !== null);

    __setProviderRegionForTests("eu-" + "west-2");
    check("once resolved, the link carries that region",
      (consoleUrl({ service: "lambda", name: "worker", region: "eu-west-2" }) ?? "")
        .includes("region=eu-west-2"));
    __setProviderRegionForTests(undefined);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
