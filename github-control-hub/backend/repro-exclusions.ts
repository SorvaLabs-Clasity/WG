/**
 * Guardrail exclusion lists, which had never been exercised.
 *
 * An exclusion is the one guardrail feature whose failure is silent in the
 * dangerous direction. A list that does not match leaves a resource being
 * reported, which somebody notices. A list that matches too widely quietly
 * stops checking things nobody meant to stop checking, and the finding simply
 * is not there to be missed.
 *
 * So the tests below care most about the boundaries: what a pattern must not
 * catch, what happens when a list is deleted while a rule still names it, and
 * whether an excluded resource can still be written to by the per-resource fix
 * button.
 *
 * Run:  npx tsx repro-exclusions.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { isExcluded } from "./src/aws-guardrails/exclusions";
import { run } from "./src/aws-guardrails/engine";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const res = (id: string, tags: Record<string, string> = {}): any =>
  ({ id, type: "logs:log-group", tags, state: { retentionInDays: 7 } });

const list = (over: Partial<any> = {}): any =>
  ({ id: "L1", name: "Scratch", description: "", resources: [], patterns: [], whitelist: [], ...over });

const rule = (over: Partial<any> = {}): any => ({
  id: "r1", name: "Log retention", description: "", kind: "log_retention_min",
  enabled: true, mode: "report", applyOnCreate: false,
  params: { minDays: 365, setToDays: 365 }, exclusionLists: [], ...over,
});

function harness(resources: any[]) {
  const fixed: string[] = [];
  return {
    fixed,
    deps: {
      collectors: {
        "logs:log-group": async () => ({ resources, unswept: [] }),
      },
      remediate: async (_k: any, r: any) => { fixed.push(r.id); return { changed: true, description: "fixed" }; },
      canRemediate: () => true,
      resolveAccounts: async () => [
        { accountId: "111111111111", name: "home", enabled: true, regions: ["us-east-1"] },
      ],
      credentialsFor: async () => undefined,
    } as any,
  };
}

(async () => {
  // ── matching, and what it must not catch ────────────────────────────
  {
    check("an exact name is excluded",
      isExcluded(res("/aws/lambda/one"), [list({ resources: ["/aws/lambda/one"] })]).excluded);
    check("  and a different name is not",
      !isExcluded(res("/aws/lambda/two"), [list({ resources: ["/aws/lambda/one"] })]).excluded);
    check("  the reason names the list, for the findings table",
      /Scratch/.test(isExcluded(res("x"), [list({ resources: ["x"] })]).reason ?? ""));

    const starts = [list({ patterns: [{ type: "starts_with", value: "tmp-" }] })];
    check("starts_with matches a prefix", isExcluded(res("tmp-scratch"), starts).excluded);
    check("  and does not match the same text in the middle",
      !isExcluded(res("keep-tmp-scratch"), starts).excluded,
      "a prefix rule that matched anywhere would silently stop checking real resources");

    const contains = [list({ patterns: [{ type: "contains", value: "sandbox" }] })];
    check("contains matches anywhere", isExcluded(res("eu-sandbox-2"), contains).excluded);

    check("an unknown pattern type matches nothing",
      !isExcluded(res("anything"), [list({ patterns: [{ type: "regex", value: ".*" }] })]).excluded,
      "failing open here would exclude everything from a typo");
  }

  // ── tags ────────────────────────────────────────────────────────────
  {
    const tagged = [list({ patterns: [{ type: "tag_equals", value: "Env=dev" }] })];
    check("tag_equals matches key and value", isExcluded(res("a", { Env: "dev" }), tagged).excluded);
    check("  not a different value", !isExcluded(res("a", { Env: "prod" }), tagged).excluded);
    check("  not a missing tag", !isExcluded(res("a"), tagged).excluded);

    const present = [list({ patterns: [{ type: "tag_equals", value: "Temporary" }] })];
    check("a bare key matches the tag being set at all",
      isExcluded(res("a", { Temporary: "yes" }), present).excluded
      && isExcluded(res("a", { Temporary: "" }), present).excluded,
      "an empty tag value is still the tag being present");
    check("  and not a resource without it", !isExcluded(res("a", { Other: "x" }), present).excluded);

    check("a resource with no tags at all does not throw",
      !isExcluded({ id: "a", type: "t", tags: {}, state: {} } as any, tagged).excluded);
  }

  // ── the whitelist ───────────────────────────────────────────────────
  {
    const l = [list({ patterns: [{ type: "starts_with", value: "tmp-" }], whitelist: ["tmp-keep"] })];
    check("a whitelisted resource is pulled back in past a pattern",
      !isExcluded(res("tmp-keep"), l).excluded,
      "this is the whole reason a whitelist exists");
    check("  while its neighbours stay excluded", isExcluded(res("tmp-other"), l).excluded);

    const both = [list({ resources: ["a"], whitelist: ["a"] })];
    check("  and it wins over an explicit entry too", !isExcluded(res("a"), both).excluded);

    // Deliberate, and worth stating: the whitelist is scoped to its own list.
    const two = [
      list({ id: "L1", name: "A", whitelist: ["x"] }),
      list({ id: "L2", name: "B", resources: ["x"] }),
    ];
    check("a whitelist in one list does not override another list",
      isExcluded(res("x"), two).excluded,
      "each list is read on its own terms; a rule naming both gets both");
  }

  // ── through the engine ──────────────────────────────────────────────
  {
    const resources = [res("/aws/lambda/one"), res("tmp-scratch")];
    const lists = [list({ id: "L1", patterns: [{ type: "starts_with", value: "tmp-" }] })];

    const h = harness(resources);
    const out: any = await run([rule({ exclusionLists: ["L1"] })], lists, {}, undefined, h.deps);
    const byId = Object.fromEntries(out.findings.map((f: any) => [f.resourceId, f]));

    check("the engine excludes what the list matches",
      byId["tmp-scratch"]?.excluded === true, byId["tmp-scratch"]);
    check("  reports it as not applicable rather than compliant",
      byId["tmp-scratch"]?.verdict === "not_applicable",
      "compliant would claim it was checked and passed");
    check("  says which list and clause, on the finding",
      /Scratch/.test(byId["tmp-scratch"]?.excludedBy ?? ""));
    check("  counts it as excluded, not as a violation",
      out.excluded === 1 && out.violations === 1, { excluded: out.excluded, violations: out.violations });
    check("  and the unexcluded one is still a violation",
      byId["/aws/lambda/one"]?.verdict === "violation");

    // A rule that names no list must not pick up a list that exists.
    const h2 = harness(resources);
    const out2: any = await run([rule({ exclusionLists: [] })], lists, {}, undefined, h2.deps);
    check("a rule naming no list excludes nothing",
      out2.excluded === 0 && out2.violations === 2, { excluded: out2.excluded, violations: out2.violations });
  }

  // ── an excluded resource cannot be written to ───────────────────────
  //
  // The per-resource Fix button names a resource and forces a remediation on a
  // rule still set to report. If exclusion were checked after that, the one
  // resource somebody had deliberately carved out would be the one it changed.
  {
    const lists = [list({ id: "L1", resources: ["tmp-scratch"] })];
    const h = harness([res("tmp-scratch")]);
    const out: any = await run(
      [rule({ exclusionLists: ["L1"] })],
      lists,
      { ruleIds: ["r1"], resourceIds: ["tmp-scratch"], forceRemediate: true },
      undefined, h.deps);

    check("forcing a fix on an excluded resource changes nothing",
      h.fixed.length === 0, h.fixed);
    check("  and it is still reported as excluded",
      out.findings[0]?.excluded === true && out.findings[0]?.remediated === false,
      out.findings[0]);
  }

  // ── enforce mode respects exclusions too ────────────────────────────
  {
    const lists = [list({ id: "L1", patterns: [{ type: "contains", value: "sandbox" }] })];
    const h = harness([res("prod-logs"), res("eu-sandbox-1")]);
    await run([rule({ mode: "enforce", exclusionLists: ["L1"] })], lists, {}, undefined, h.deps);
    check("an enforcing rule fixes only what it is allowed to touch",
      h.fixed.length === 1 && h.fixed[0] === "prod-logs", h.fixed);
  }

  // ── the routes, which the engine tests cannot reach ─────────────────
  {
    const routes = fs.readFileSync(`${__dirname}/src/routes/awsGuardrails.ts`, "utf8");
    const code = routes.split("\n").filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");

    // A rule stores lists by id and resolves them with a filter, so an id
    // naming a deleted list silently matches nothing. Deleting a list in use
    // therefore widens every rule that named it, with no sign but findings
    // appearing for resources somebody had carved out.
    check("a list still used by a rule cannot be deleted",
      /r\.exclusionLists\?\.includes\(req\.params\.id\)/.test(code)
      && /409/.test(code),
      "the sweep would quietly stop excluding what those rules exclude today");
    check("  and the refusal names the rules, so the fix is obvious",
      /rules: inUse/.test(code));

    check("a malformed list is refused rather than stored",
      /badExclusionShape/.test(code));
    check("  a string where an array belongs is caught",
      /!Array\.isArray\(v\)/.test(code),
      '"prod" as a whitelist would match on substrings and throw on .some');
    check("  and an unknown pattern type is refused at the door",
      /allowed\.has\(p\.type\)/.test(code),
      "storing one leaves a rule somebody believes is excluding when it is not");
    check("  as is an empty pattern value",
      /p\.value === ""/.test(code),
      'an empty starts_with would match every resource');
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
