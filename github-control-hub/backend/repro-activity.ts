/**
 * Regression test: an activity entry must reflect what actually happened.
 *
 * Auto-apply logs its entry BEFORE running (child entries need a parent id), so
 * the entry starts as a claim about unfinished work. Previously nothing rewrote
 * it, so a failed auto-apply still read "Auto-applied template ... to new repo",
 * which is what made a broken auto-apply look successful in the UI.
 */
process.env.GITHUB_ORG = "test-org";
delete process.env.ACTIVITY_TABLE; // in-memory store, no AWS

import { logActivity, updateActivityOutcome, getActivity } from "./src/services/activityService";

(async () => {
  let failures = 0;
  const check = (name: string, ok: boolean, got: unknown) => {
    console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
    if (!ok) failures++;
  };

  // --- failed apply ---
  const a = await logActivity("template.apply", "system (auto-apply)", "repo-a", "Test",
    `Applying template "Test" to new repo "repo-a"…`);
  await updateActivityOutcome(a.id, {
    details: `Failed to auto-apply template "Test" to "repo-a"`,
    failed: true,
    errorMessage: "Bad credentials",
  });
  const afterFail = (await getActivity(50)).find(e => e.id === a.id)!;
  check("failed apply is marked failed", afterFail.failed === true, afterFail.failed);
  check("failed apply no longer claims success",
    !/^Auto-applied/.test(afterFail.details || "") && /^Failed to auto-apply/.test(afterFail.details || ""),
    afterFail.details);
  check("failed apply records the error", afterFail.errorMessage === "Bad credentials", afterFail.errorMessage);

  // --- successful apply ---
  const b = await logActivity("template.apply", "system (auto-apply)", "repo-b", "Test",
    `Applying template "Test" to new repo "repo-b"…`);
  await updateActivityOutcome(b.id, {
    details: `Auto-applied template "Test" to new repo "repo-b"`,
    failed: false,
  });
  const afterOk = (await getActivity(50)).find(e => e.id === b.id)!;
  check("successful apply is not marked failed", !afterOk.failed, afterOk.failed);
  check("successful apply reads as applied", /^Auto-applied/.test(afterOk.details || ""), afterOk.details);
  check("successful apply carries no error", !afterOk.errorMessage, afterOk.errorMessage);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
