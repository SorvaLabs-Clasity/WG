/**
 * Tests for the guardrail engine's safety properties.
 *
 * These are the behaviours that, if wrong, cause real damage in a production
 * account: writing when the rule said report-only, remediating something the
 * user excluded, or letting one broken rule stop every other rule running.
 */
import { run } from "./src/aws-guardrails/engine";
import type { Guardrail, AwsExclusionList, ResourceSnapshot } from "./src/aws-guardrails/types";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const rule = (over: Partial<Guardrail> = {}): Guardrail => ({
  id: "r1", name: "Log retention >= 1y", description: "",
  kind: "log_retention_min", enabled: true, mode: "report", applyOnCreate: true,
  params: { minDays: 365, leaveLongerAlone: true, neverExpireIsCompliant: true },
  exclusionLists: [], createdBy: "t", createdAt: "", updatedAt: "", ...over,
});

const logGroup = (id: string, retentionInDays?: number, tags: Record<string, string> = {}): ResourceSnapshot =>
  ({ id, type: "logs:log-group", tags, state: { retentionInDays } });

function fakeCollectors(resources: ResourceSnapshot[]) {
  return { "logs:log-group": async () => resources } as any;
}

(async () => {
  // ── report mode must never write ────────────────────────────────────
  {
    let called = 0;
    const r = await run([rule({ mode: "report" })], [], {}, undefined, {
      collectors: fakeCollectors([logGroup("app-logs", 30)]),
      remediate: async () => { called++; return { changed: true, description: "should not happen" }; },
      canRemediate: () => true,
    });
    check("report mode finds the violation", r.violations === 1, r);
    check("report mode does NOT remediate", called === 0, called);
    check("report mode reports remediated=0", r.remediated === 0, r.remediated);
  }

  // ── enforce mode writes ─────────────────────────────────────────────
  {
    let called = 0;
    const activity: string[] = [];
    const r = await run([rule({ mode: "enforce" })], [], {}, async (e) => { activity.push(e.description); }, {
      collectors: fakeCollectors([logGroup("app-logs", 30)]),
      remediate: async () => { called++; return { changed: true, description: "set retention to 365", undo: { action: "logs_restore_retention", params: {} } }; },
      canRemediate: () => true,
    });
    check("enforce mode remediates", called === 1 && r.remediated === 1, { called, r });
    check("enforce mode logs activity", activity.length === 1, activity);
  }

  // ── dryRun overrides enforce ────────────────────────────────────────
  {
    let called = 0;
    const r = await run([rule({ mode: "enforce" })], [], { dryRun: true }, undefined, {
      collectors: fakeCollectors([logGroup("app-logs", 30)]),
      remediate: async () => { called++; return { changed: true, description: "x" }; },
      canRemediate: () => true,
    });
    check("dryRun blocks writes even in enforce mode", called === 0, called);
    check("dryRun still reports the violation", r.violations === 1, r.violations);
  }

  // ── compliant resources are never touched ───────────────────────────
  {
    let called = 0;
    const r = await run([rule({ mode: "enforce" })], [], {}, undefined, {
      collectors: fakeCollectors([logGroup("kept-forever", undefined), logGroup("long", 3653)]),
      remediate: async () => { called++; return { changed: true, description: "x" }; },
      canRemediate: () => true,
    });
    check("never-expire and longer retention are left alone", called === 0 && r.violations === 0, { called, r });
  }

  // ── exclusions suppress remediation ─────────────────────────────────
  {
    const list: AwsExclusionList = {
      id: "x1", name: "Sandbox", description: "", resources: [],
      patterns: [{ id: "p", type: "starts_with", value: "tmp-" }], whitelist: [],
      createdBy: "t", createdAt: "", updatedAt: "",
    };
    let called = 0;
    const r = await run([rule({ mode: "enforce", exclusionLists: ["x1"] })], [list], {}, undefined, {
      collectors: fakeCollectors([logGroup("tmp-scratch", 1), logGroup("app-logs", 1)]),
      remediate: async () => { called++; return { changed: true, description: "x" }; },
      canRemediate: () => true,
    });
    check("excluded resource is not remediated", called === 1, called);
    check("excluded resource is counted as excluded", r.excluded === 1, r.excluded);
    check("excluded finding records why", (r.findings.find(f => f.resourceId === "tmp-scratch")?.excludedBy ?? "").includes("Sandbox"), r.findings);
    check("non-excluded resource still remediated", r.remediated === 1, r.remediated);
  }

  // ── a kind with no remediator is never auto-fixed ──────────────────
  // Every catalog entry can be remediated now, but the engine must still
  // refuse to call a remediator that does not exist rather than assuming one.
  {
    let called = 0;
    const r = await run([rule({ mode: "enforce" })], [], {}, undefined, {
      collectors: fakeCollectors([logGroup("app-logs", 1)]),
      remediate: async () => { called++; return { changed: false, description: "report only" }; },
      canRemediate: () => false,
    });
    check("a kind without a remediator is not remediated in enforce mode", called === 0, called);
    check("  and the violation is still reported", r.violations === 1, r.violations);
  }

  // ── disabled rules do nothing ───────────────────────────────────────
  {
    const r = await run([rule({ enabled: false, mode: "enforce" })], [], {}, undefined, {
      collectors: fakeCollectors([logGroup("app-logs", 1)]),
      remediate: async () => ({ changed: true, description: "x" }),
      canRemediate: () => true,
    });
    check("disabled rule produces no findings", r.findings.length === 0, r.findings);
  }

  // ── a failing collector must not stop other rules ───────────────────
  {
    const r = await run(
      [rule({ id: "broken", kind: "s3_https_only" }), rule({ id: "fine" })],
      [], {}, undefined,
      {
        collectors: {
          "s3:bucket": async () => { throw new Error("AccessDenied"); },
          "logs:log-group": async () => [logGroup("app-logs", 30)],
        } as any,
        remediate: async () => ({ changed: true, description: "x" }),
        canRemediate: () => true,
      });
    check("collector failure is recorded as an error", r.errors.some(e => e.includes("AccessDenied")), r.errors);
    check("collector failure does not stop the other rule", r.findings.some(f => f.ruleId === "fine"), r.findings);
  }

  // ── a failing remediation is recorded, run continues ────────────────
  {
    const activity: { failed: boolean }[] = [];
    const r = await run([rule({ mode: "enforce" })], [], {}, async (e) => { activity.push({ failed: e.failed }); }, {
      collectors: fakeCollectors([logGroup("a", 1), logGroup("b", 1)]),
      remediate: async (_k, res) => {
        if (res.id === "a") throw new Error("AccessDeniedException");
        return { changed: true, description: "fixed b" };
      },
      canRemediate: () => true,
    });
    check("failed remediation is recorded as an error", r.errors.some(e => e.includes("AccessDeniedException")), r.errors);
    check("failed remediation logs a failed activity entry", activity.some(a => a.failed), activity);
    check("run continues past the failure", r.remediated === 1, r.remediated);
  }

  // ── resourceIds narrows the run ─────────────────────────────────────
  {
    const r = await run([rule()], [], { resourceIds: ["only-me"] }, undefined, {
      collectors: fakeCollectors([logGroup("only-me", 1), logGroup("not-me", 1)]),
      remediate: async () => ({ changed: true, description: "x" }),
      canRemediate: () => true,
    });
    check("resourceIds limits which resources are evaluated",
      r.findings.length === 1 && r.findings[0].resourceId === "only-me", r.findings);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
