/**
 * Correlating CI failures.
 *
 * The failure modes are all "a confident answer that sends people the wrong
 * way", which is worse than showing nothing:
 *
 *   - reporting one repository's own broken test as a correlated incident.
 *   - reporting the same incident three times under three groupings, so a
 *     single cause reads as three separate problems.
 *   - grouping failures hours apart that have nothing to do with each other.
 *   - naming the wrong step, because the step that failed is not the last one
 *     in the list.
 */
import fs from "fs";
import path from "path";
import {
  correlate, firstFailedStep, WINDOW_HOURS, MIN_REPOS, RETENTION_DAYS,
  type CiFailure,
} from "./src/services/ciFailureService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = Date.parse("2026-08-15T12:00:00Z");
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

let seq = 0;
const f = (over: Partial<CiFailure> = {}): CiFailure => ({
  id: `f${seq++}`, repo: "o/a", workflow: "ci.yml", job: "build",
  step: "Setup Node", labels: ["ubuntu-latest"],
  url: `https://x/${seq}`, failedAt: minsAgo(10), ttl: 0, ...over,
});

(async () => {
  // ── one repository failing is not a correlation ─────────────────────
  {
    // Ten failures in one repository is that repository's problem, and its
    // owner already knows. Reporting it as a correlated incident is noise that
    // trains people to ignore the panel.
    const same = Array.from({ length: 10 }, () => f({ repo: "o/only-one" }));
    check(`a single repository failing ${same.length} times is not reported`,
      correlate(same, NOW).length === 0, correlate(same, NOW));

    check(`  the threshold is ${MIN_REPOS} repositories`, MIN_REPOS >= 2);

    const two = [f({ repo: "o/a" }), f({ repo: "o/b" })];
    check("  two repositories failing the same way is",
      correlate(two, NOW).length === 1, correlate(two, NOW));
  }

  // ── the shape of a real incident ────────────────────────────────────
  {
    const burst = [
      ...Array.from({ length: 11 }, (_, i) =>
        f({ repo: `o/repo-${i}`, step: "Setup Node", labels: ["ubuntu-latest"], failedAt: minsAgo(30 - i) })),
      // Two unrelated failures in the same window, which must not be swept in.
      f({ repo: "o/other", step: "Run tests", labels: ["ubuntu-latest"], workflow: "nightly.yml" }),
      f({ repo: "o/other2", step: "Lint", labels: ["windows-latest"], workflow: "lint.yml" }),
    ];
    const clusters = correlate(burst, NOW);

    check("eleven repositories failing at one step form a cluster",
      clusters[0]?.repos.length === 11, clusters[0]?.repos.length);
    check("  described in words a person can act on",
      /11 failures across 11 repositories/.test(clusters[0]?.shared ?? "")
        && clusters[0].shared.includes("Setup Node")
        && clusters[0].shared.includes("ubuntu-latest"),
      clusters[0]?.shared);
    check("  with the matched attributes kept for filtering and alarms",
      clusters[0]?.key.step === "Setup Node" && clusters[0]?.key.label === "ubuntu-latest",
      clusters[0]?.key);
    check("  and example links so somebody can open one",
      (clusters[0]?.examples.length ?? 0) > 0 && clusters[0].examples.length <= 3,
      clusters[0]?.examples);
    check("  first and last seen bound the incident",
      clusters[0]?.firstAt < clusters[0]?.lastAt, [clusters[0]?.firstAt, clusters[0]?.lastAt]);

    // The two odd ones out share nothing with two repositories, so nothing.
    check("  the unrelated failures are not swept into it",
      !clusters[0]?.repos.includes("o/other") && !clusters[0]?.repos.includes("o/other2"),
      clusters[0]?.repos);
  }

  // ── one incident must not be reported three times ───────────────────
  {
    // These failures share a step, a runner and a workflow. All three groupings
    // match, and reporting each would turn one cause into three findings.
    const burst = Array.from({ length: 6 }, (_, i) =>
      f({ repo: `o/r${i}`, step: "Build", labels: ["ubuntu-latest"], workflow: "ci.yml" }));
    const clusters = correlate(burst, NOW);
    check("a failure joins only the most specific cluster it fits",
      clusters.length === 1, clusters.map(c => c.shared));
    check("  and that is the most specific one",
      clusters[0].key.step === "Build" && clusters[0].key.label === "ubuntu-latest",
      clusters[0].key);

    const total = clusters.reduce((n, c) => n + c.failures, 0);
    check("  so each failure is counted once, not once per grouping",
      total === burst.length, { total, expected: burst.length });
  }

  // ── less specific groupings still catch things ──────────────────────
  {
    // Same step, different runners — a shared action rather than a runner image.
    const mixed = [
      f({ repo: "o/a", step: "actions/checkout", labels: ["ubuntu-latest"] }),
      f({ repo: "o/b", step: "actions/checkout", labels: ["windows-latest"] }),
      f({ repo: "o/c", step: "actions/checkout", labels: ["macos-latest"] }),
    ];
    const c1 = correlate(mixed, NOW);
    check("the same step on different runners still correlates",
      c1.length === 1 && c1[0].repos.length === 3, c1);
    check("  and is described without naming a runner they do not share",
      !/ubuntu|windows|macos/.test(c1[0].shared), c1[0].shared);

    // No step at all — a job that failed before any step ran.
    const noStep = [
      f({ repo: "o/a", step: null, workflow: "deploy.yml" }),
      f({ repo: "o/b", step: null, workflow: "deploy.yml" }),
    ];
    const c2 = correlate(noStep, NOW);
    check("failures with no step fall back to the workflow name",
      c2.length === 1 && c2[0].key.workflow === "deploy.yml", c2);
  }

  // ── the time window ─────────────────────────────────────────────────
  {
    const old = [
      f({ repo: "o/a", failedAt: new Date(NOW - (WINDOW_HOURS + 1) * 3_600_000).toISOString() }),
      f({ repo: "o/b", failedAt: new Date(NOW - (WINDOW_HOURS + 1) * 3_600_000).toISOString() }),
    ];
    check(`failures older than ${WINDOW_HOURS}h are outside the window`,
      correlate(old, NOW).length === 0, correlate(old, NOW));

    // A shared cause does not hit every repository at the same instant, so the
    // window has to be generous enough to span a rollout.
    const spread = [
      f({ repo: "o/a", failedAt: minsAgo(5) }),
      f({ repo: "o/b", failedAt: minsAgo(90) }),
    ];
    check("  but ninety minutes apart still correlates",
      correlate(spread, NOW).length === 1, correlate(spread, NOW));

    check("  and an unparseable timestamp is dropped rather than treated as now",
      correlate([f({ repo: "o/a", failedAt: "banana" }), f({ repo: "o/b", failedAt: "banana" })], NOW).length === 0);
  }

  // ── ordering ────────────────────────────────────────────────────────
  {
    const many = [
      ...Array.from({ length: 2 }, (_, i) => f({ repo: `o/small-${i}`, step: "Lint" })),
      ...Array.from({ length: 7 }, (_, i) => f({ repo: `o/big-${i}`, step: "Deploy" })),
    ];
    const clusters = correlate(many, NOW);
    check("the largest correlation is reported first",
      clusters[0].repos.length === 7, clusters.map(c => c.repos.length));
  }

  // ── which step failed ───────────────────────────────────────────────
  {
    // The failing step is not the last in the list: GitHub records the steps
    // that came after it too, skipped. Taking the last one names a step that
    // never ran.
    // Two failing steps, not one. A job with `continue-on-error` keeps going
    // after the first failure, so several steps can be marked failed — and
    // with a single failing step the first and the last are the same value,
    // which makes the assertion pass whichever end it reads from.
    const steps = [
      { name: "Set up job", conclusion: "success" },
      { name: "Checkout", conclusion: "success" },
      { name: "Setup Node", conclusion: "failure" },
      { name: "Install", conclusion: "failure" },
      { name: "Complete job", conclusion: "skipped" },
    ];
    check("the first failing step is the one reported, not the last",
      firstFailedStep(steps) === "Setup Node", firstFailedStep(steps));
    check("  which is the one that actually broke, the rest being consequences",
      firstFailedStep(steps) !== "Install", firstFailedStep(steps));
    check("  a job with no failing step reports none",
      firstFailedStep([{ name: "a", conclusion: "success" }]) === null);
    check("  and a missing steps array does not throw",
      firstFailedStep(undefined) === null);
  }

  // ── the webhook only records what is worth recording ────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, "src/webhooks/processDelivery.ts"), "utf8");
    const code = src.split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s*\/\/.*$/, "")).join("\n");

    check("only completed jobs that failed are stored",
      /event === "workflow_job" && payload\.action === "completed"/.test(code)
        && /conclusion === "failure"/.test(code),
      "storing every job would be thousands of rows a day for nothing");

    // The run payload has neither runner labels nor per-step conclusions, so
    // correlating on it would lose the two most diagnostic fields.
    check("  workflow_job is used, not workflow_run",
      /event === "workflow_job"/.test(code) && !/event === "workflow_run"/.test(code),
      "workflow_run carries no labels and no steps");

    check("  and a recording failure cannot fail the delivery",
      /\[CI\] Recording a failed job failed/.test(src));

    check(`records expire after ${RETENTION_DAYS} days`, RETENTION_DAYS > 0 && RETENTION_DAYS <= 30);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
