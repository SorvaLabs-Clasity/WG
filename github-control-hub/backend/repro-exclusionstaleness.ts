/**
 * A finding that says "skipped" after nothing is skipping it any more.
 *
 * Reported from a live account: an exclusion list was attached to a rule, a
 * non-compliant resource correctly appeared as skipped, and then the list was
 * taken off the rule again. The resource stayed marked skipped. Pressing
 * refresh did not change it. Only "Sweep all" eventually reported it as
 * failing.
 *
 * The cause is that refresh and sweep are different operations and only one of
 * them produces findings. `GET /findings` reads what the last sweep stored, and
 * a stored finding carries the reason it was excluded as flat text — it has no
 * way to notice that the list naming that reason is no longer attached to
 * anything. So the row was not stale, it was wrong, and the only thing that
 * could correct it was a full sweep over every rule in the account.
 *
 * What is asserted here is the decision of *when* to re-check, which is where
 * this can go wrong in both directions: missing a change leaves the wrong
 * verdict on screen, and re-checking on every save spends a collector pass over
 * AWS every time somebody renames a rule.
 *
 * Run:  npx tsx repro-exclusionstaleness.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import {
  ruleExclusionsChanged, listContentChanged, rulesUsingList,
} from "./src/aws-guardrails/staleness";
import type { AwsExclusionList, Guardrail } from "./src/aws-guardrails/types";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const rule = (over: Partial<Guardrail> = {}): Guardrail => ({
  id: "r1", name: "No public buckets", description: "", kind: "s3-public",
  mode: "report", enabled: true, applyOnCreate: false, params: {},
  exclusionLists: [], accounts: [], createdBy: "a-person",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  ...over,
} as Guardrail);

const list = (over: Partial<AwsExclusionList> = {}): AwsExclusionList => ({
  id: "l1", name: "Sandbox", description: "",
  resources: [], patterns: [], whitelist: [],
  createdBy: "a-person",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

(async () => {
  // ── the reported bug ────────────────────────────────────────────────
  {
    const before = rule({ exclusionLists: ["l1"] });
    const after = rule({ exclusionLists: [] });
    check("taking an exclusion list off a rule needs a re-check",
      ruleExclusionsChanged(before, after),
      "this is the reported bug: the resource stayed marked skipped");

    check("  and putting one on does too",
      ruleExclusionsChanged(after, before),
      "otherwise a newly excluded resource keeps reporting as a violation");

    check("  swapping one list for another counts",
      ruleExclusionsChanged(rule({ exclusionLists: ["l1"] }), rule({ exclusionLists: ["l2"] })));
    check("  as does adding a second alongside the first",
      ruleExclusionsChanged(rule({ exclusionLists: ["l1"] }), rule({ exclusionLists: ["l1", "l2"] })));
  }

  // ── and the other direction, which costs an AWS pass ────────────────
  //
  // Every yes here is a collector pass over the rule's resources. A rule with
  // eight fields somebody might edit must not sweep on all eight.
  {
    check("renaming a rule sweeps nothing",
      !ruleExclusionsChanged(rule({ exclusionLists: ["l1"] }),
                             rule({ name: "Renamed", exclusionLists: ["l1"] })));
    check("  nor does changing its mode",
      !ruleExclusionsChanged(rule({ exclusionLists: ["l1"] }),
                             rule({ mode: "enforce", exclusionLists: ["l1"] })));
    check("  nor re-saving it unchanged",
      !ruleExclusionsChanged(rule({ exclusionLists: ["l1"] }), rule({ exclusionLists: ["l1"] })));

    // Order is not meaning. A form that serialises the same two lists the other
    // way round would otherwise sweep on every save.
    check("  nor listing the same lists in a different order",
      !ruleExclusionsChanged(rule({ exclusionLists: ["l1", "l2"] }),
                             rule({ exclusionLists: ["l2", "l1"] })),
      "order is not meaning, and re-sweeping for it is pure cost");
  }

  // ── editing the list itself, rather than which lists a rule uses ────
  {
    check("adding a resource to a list needs a re-check",
      listContentChanged(list(), list({ resources: ["my-bucket"] })));
    check("  removing one does too, which is the same bug one level down",
      listContentChanged(list({ resources: ["my-bucket"] }), list()));
    check("  a whitelist entry counts, because it pulls a resource back in",
      listContentChanged(list({ patterns: [{ type: "starts_with", value: "dev-" }] as any }),
                         list({ patterns: [{ type: "starts_with", value: "dev-" }] as any,
                                whitelist: ["dev-prod-mirror"] })));
    check("  and so does a pattern",
      listContentChanged(list(), list({ patterns: [{ type: "contains", value: "temp" }] as any })));
    check("  including one that only changes what it matches on",
      listContentChanged(list({ patterns: [{ type: "starts_with", value: "dev-" }] as any }),
                         list({ patterns: [{ type: "contains", value: "dev-" }] as any })));

    check("re-saving a list unchanged sweeps nothing",
      !listContentChanged(list({ resources: ["a"], whitelist: ["b"] }),
                          list({ resources: ["a"], whitelist: ["b"] })));
    // The reason text on a finding goes stale, and that is accepted: it is a
    // display name, not a verdict, and the next sweep restates it.
    check("  nor does renaming the list, which changes no verdict",
      !listContentChanged(list({ name: "Sandbox" }), list({ name: "Sandboxes" })),
      "a stale display name is not worth a sweep over every rule using it");
  }

  // ── which rules a list edit reaches ─────────────────────────────────
  {
    const rules = [
      rule({ id: "a", exclusionLists: ["l1"] }),
      rule({ id: "b", exclusionLists: ["l2"] }),
      rule({ id: "c", exclusionLists: ["l1", "l2"] }),
      rule({ id: "d", exclusionLists: ["l1"], enabled: false }),
    ];
    check("every enabled rule using the list is re-checked",
      JSON.stringify(rulesUsingList("l1", rules)) === '["a","c"]',
      rulesUsingList("l1", rules));
    check("  a rule that does not use it is left alone",
      !rulesUsingList("l1", rules).includes("b"));
    // The engine filters on `enabled` before evaluating anything, so naming a
    // disabled rule reads every resource it covers and writes nothing.
    check("  and a disabled rule is not, because the engine would produce nothing",
      !rulesUsingList("l1", rules).includes("d"),
      "it would cost a collector pass and leave the same findings behind");
    check("  a list nothing points at re-checks nothing",
      rulesUsingList("l9", rules).length === 0);
  }

  // ── the routes actually do it ───────────────────────────────────────
  //
  // The predicates above being right is worth nothing if nobody calls them.
  {
    const route = fs.readFileSync("./src/routes/awsGuardrails.ts", "utf8");

    check("saving a rule re-checks it when its exclusions moved",
      /ruleExclusionsChanged\(existing, updated\)/.test(route));
    check("  and only then",
      /ruleExclusionsChanged\(existing, updated\) && updated\.enabled \? \[updated\.id\] : \[\]/.test(route),
      "an unconditional re-check sweeps AWS on every rename");
    check("saving a list re-checks the rules using it",
      /listContentChanged\(existing, updated\)/.test(route)
      && /rulesUsingList\(updated\.id, await listGuardrails\(\)\)/.test(route));

    check("the re-check is scoped, not a whole sweep",
      /invokeEngine\(\{ ruleIds \}\)/.test(route),
      "sweeping everything to fix one rule is what the user was doing by hand");

    // The save has already succeeded by this point. Rejecting it would report
    // a failure that did not happen.
    check("a failed re-check does not fail the save",
      /catch \(err\) \{[\s\S]{0,220}return false;/.test(route),
      "the change is stored and correct; only the re-check did not run");
    check("  and the caller is told which it got",
      /findingsRefreshed/.test(route),
      "silently returning implies the findings are current when they may not be");

    const hook = fs.readFileSync("../frontend/src/hooks/useAws.ts", "utf8");
    const save = hook.slice(hook.indexOf("export function useSaveAwsExclusion"));
    check("the exclusion form refetches findings, not only the lists",
      /queryKey: \["aws"\]/.test(save.slice(0, save.indexOf("export function useDeleteAwsExclusion"))),
      "the server re-checked and the screen still showed the old verdicts");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
