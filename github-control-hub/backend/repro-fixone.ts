/**
 * Fixing one failing resource, without changing what the rule does next time.
 *
 * Deciding to correct *this* bucket is a different decision from deciding that
 * every future violation of the rule should be corrected automatically. The
 * rule's `mode` carries the second one, and this must not touch it — so a
 * setting changed back after a one-off fix is reported again rather than
 * silently re-corrected. A rule already in `enforce` re-corrects, because that
 * is what enforce means.
 *
 * The dangerous shape here is scope. `forceRemediate` without `resourceIds`
 * would quietly mean "enforce this whole rule" — one absent field turning a
 * button beside a single row into a policy change. That is refused outright.
 *
 * Run:  npx tsx repro-fixone.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { run } from "./src/aws-guardrails/engine";
import { CATALOG } from "./src/aws-guardrails/catalog";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (p: string) => fs.readFileSync(`${__dirname}/${p}`, "utf8");

const rule = (over: Partial<any> = {}): any => ({
  id: "r1", name: "Log retention", description: "", kind: "log_retention_min",
  enabled: true, mode: "report", applyOnCreate: false,
  params: { minDays: 365, setToDays: 365 }, exclusionLists: [], ...over,
});

/** A collector answering with one failing resource, and a recording fixer. */
function harness() {
  const fixed: string[] = [];
  return {
    fixed,
    deps: {
      // Keyed by resource type, as the engine keys them — not by rule kind.
      collectors: {
        // `{ resources, unswept }`, not a bare array — a collector reports what
        // it could not reach as well as what it found.
        "logs:log-group": async () => ({
          resources: [
            { id: "/aws/lambda/one", type: "logs:log-group", region: "us-east-1",
              tags: {}, state: { retentionInDays: 7 } },
          ],
          unswept: [],
        }),
      },
      remediate: async (_k: any, r: any) => {
        fixed.push(r.id);
        return { changed: true, description: `set retention on ${r.id}` };
      },
      canRemediate: () => true,
      // `enabled` and `regions` both matter: the engine filters on the first
      // and derives its scopes from the second.
      resolveAccounts: async () => [
        { accountId: "111111111111", name: "home", enabled: true, regions: ["us-east-1"] },
      ],
      credentialsFor: async () => undefined,
    } as any,
  };
}

(async () => {
  // ── scope: it cannot widen into enforcing a rule ────────────────────
  {
    let threw: any = null;
    try {
      await run([rule()], [], { ruleIds: ["r1"], forceRemediate: true }, undefined, harness().deps);
    } catch (e) { threw = e; }
    check("forcing a fix without naming resources is refused",
      /requires resourceIds/.test(threw?.message ?? ""), threw?.message);
  }

  // ── a report rule does not fix on an ordinary run ───────────────────
  {
    const h = harness();
    const r = await run([rule()], [], { ruleIds: ["r1"] }, undefined, h.deps);
    check("a report rule reports and does not fix", r.violations === 1 && h.fixed.length === 0,
      { violations: r.violations, fixed: h.fixed });
  }

  // ── the same rule, one named resource, forced ───────────────────────
  {
    const h = harness();
    const r = await run(
      [rule()], [],
      { ruleIds: ["r1"], resourceIds: ["/aws/lambda/one"], forceRemediate: true },
      undefined, h.deps,
    );
    check("forcing a named resource fixes it", h.fixed.join() === "/aws/lambda/one", h.fixed);
    check("  and reports it as remediated", r.remediated === 1, r.remediated);
  }

  // ── the rule's own mode is untouched ────────────────────────────────
  {
    const h = harness();
    const one = rule();
    await run([one], [], { ruleIds: ["r1"], resourceIds: ["/aws/lambda/one"], forceRemediate: true },
      undefined, h.deps);
    check("the rule is still in report mode afterwards", one.mode === "report", one.mode);

    // Which is what makes it one-off: the next ordinary sweep reports again.
    const h2 = harness();
    const again = await run([one], [], { ruleIds: ["r1"] }, undefined, h2.deps);
    check("  so a change back is reported, not silently re-corrected",
      again.violations === 1 && h2.fixed.length === 0,
      { violations: again.violations, fixed: h2.fixed });
  }

  // ── enforce still re-corrects, because that is what it means ────────
  {
    const h = harness();
    const r = await run([rule({ mode: "enforce" })], [], { ruleIds: ["r1"] }, undefined, h.deps);
    check("an enforce rule re-corrects on its own", h.fixed.length === 1 && r.remediated === 1,
      { fixed: h.fixed, remediated: r.remediated });
  }

  // ── dry run still wins ──────────────────────────────────────────────
  {
    const h = harness();
    await run([rule()], [], { ruleIds: ["r1"], resourceIds: ["/aws/lambda/one"], forceRemediate: true, dryRun: true },
      undefined, h.deps);
    check("a dry run is not overridden by forcing", h.fixed.length === 0, h.fixed);
  }

  // ── a report rule carries the parameters a fix needs ────────────────
  //
  // The thing that would make the button impossible: `setToDays` and `sid` are
  // the fields a report rule looks like it does not need, right up until
  // somebody presses Fix.
  {
    for (const kind of ["log_retention_min", "s3_https_only"]) {
      const entry: any = CATALOG.find(c => c.kind === kind);
      check(`${kind} defaults to report`, entry?.defaultMode === "report", entry?.defaultMode);
      const fixKeys = kind === "log_retention_min" ? ["setToDays"] : ["sid"];
      for (const k of fixKeys) {
        check(`  and still carries "${k}" by default`,
          entry?.defaultParams?.[k] !== undefined, entry?.defaultParams);
        check(`    with a field on the form`,
          (entry?.paramSchema ?? []).some((f: any) => f.key === k),
          (entry?.paramSchema ?? []).map((f: any) => f.key));
      }
    }

    const page = read("../frontend/src/pages/AwsPage.tsx");
    check("the form fills them from the catalog rather than leaving them blank",
      /useState<Record<string, any>>\(rule\?\.params \?\? entry\?\.defaultParams/.test(page));
    check("  and the server stores them even when the caller omits them",
      /CATALOG\.find\(c => c\.kind === kind\)\?\.defaultParams/.test(read("src/routes/awsGuardrails.ts")),
      "a rule made through the API would otherwise lean on a fallback that can drift");
  }

  // ── the button ──────────────────────────────────────────────────────
  {
    const page = read("../frontend/src/pages/AwsPage.tsx");
    check("a Fix button is offered per failing resource",
      /onClick=\{\(\) => fixOne\(f\)\}/.test(page));
    check("  only where a fix exists", /entry\?\.canRemediate/.test(page));
    check("  only on a resource that is actually failing",
      /f\.verdict === "violation"\s*\n?\s*&& !f\.excluded && !f\.remediated/.test(page));
    check("  and only for an admin", /isAdmin && entry\?\.canRemediate/.test(page));
    check("  a fix that changed nothing says so rather than claiming success",
      /Nothing was changed/.test(page),
      "the resource may already have been compliant by the time it ran");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
