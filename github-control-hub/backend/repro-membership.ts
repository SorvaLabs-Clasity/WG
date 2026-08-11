/**
 * Tests for the org membership re-check.
 *
 * Two ways to get this wrong, in opposite directions: cache so eagerly that a
 * removed user keeps working, or fail so closed that a GitHub blip signs out
 * the company. Both are pinned here.
 */
import { isStillOrgMember, clearMembershipCache, forgetMembership, type MembershipDeps } from "./src/services/orgMembership";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const MINUTE = 60 * 1000;

/** Controllable clock and a call counter, so caching is observable. */
function harness(answers: (boolean | "error")[]) {
  let t = 0;
  let calls = 0;
  const deps: MembershipDeps = {
    now: () => t,
    check: async () => {
      const a = answers[Math.min(calls, answers.length - 1)];
      calls++;
      if (a === "error") throw new Error("GitHub unreachable");
      return a;
    },
  };
  return { deps, advance: (ms: number) => { t += ms; }, calls: () => calls };
}

(async () => {
  // ── the answer is cached, but not forever ───────────────────────────
  {
    clearMembershipCache();
    const h = harness([true]);
    await isStillOrgMember(1, "amy", "tok", h.deps);
    await isStillOrgMember(1, "amy", "tok", h.deps);
    await isStillOrgMember(1, "amy", "tok", h.deps);
    check("repeat requests do not hammer GitHub", h.calls() === 1, h.calls());

    h.advance(6 * MINUTE);
    await isStillOrgMember(1, "amy", "tok", h.deps);
    check("the answer is re-checked after the TTL", h.calls() === 2, h.calls());
  }

  // ── removal takes effect within the window ──────────────────────────
  {
    clearMembershipCache();
    const h = harness([true, false]);
    check("a member is allowed", await isStillOrgMember(2, "bo", "tok", h.deps) === true);

    h.advance(1 * MINUTE);
    check("  and stays allowed inside the TTL", await isStillOrgMember(2, "bo", "tok", h.deps) === true);

    h.advance(5 * MINUTE);
    check("removal takes effect once the TTL lapses",
      await isStillOrgMember(2, "bo", "tok", h.deps) === false);
  }

  // ── a definite no is never softened ─────────────────────────────────
  {
    clearMembershipCache();
    const h = harness([false]);
    check("a non-member is denied", await isStillOrgMember(3, "cy", "tok", h.deps) === false);
  }

  // ── a GitHub outage does not sign out the company ───────────────────
  {
    clearMembershipCache();
    const h = harness([true, "error", "error"]);
    await isStillOrgMember(4, "dee", "tok", h.deps);

    h.advance(6 * MINUTE);
    check("an unreachable GitHub falls back to the last known yes",
      await isStillOrgMember(4, "dee", "tok", h.deps) === true);

    h.advance(2 * 60 * MINUTE);
    check("  but the fallback expires rather than lasting forever",
      await isStillOrgMember(4, "dee", "tok", h.deps) === false);
  }

  // ── an outage cannot manufacture access ─────────────────────────────
  {
    clearMembershipCache();
    const h = harness(["error"]);
    check("with nothing cached, an unreachable GitHub denies",
      await isStillOrgMember(5, "eve", "tok", h.deps) === false);
  }

  {
    clearMembershipCache();
    const h = harness([false, "error"]);
    await isStillOrgMember(6, "fi", "tok", h.deps);
    h.advance(6 * MINUTE);
    check("a cached no is not upgraded by an outage",
      await isStillOrgMember(6, "fi", "tok", h.deps) === false);
  }

  // ── users are cached apart ──────────────────────────────────────────
  {
    clearMembershipCache();
    const h = harness([true, false]);
    check("first user allowed", await isStillOrgMember(7, "gus", "tok", h.deps) === true);
    check("a second user gets their own answer",
      await isStillOrgMember(8, "hal", "tok", h.deps) === false);
  }

  // ── signing out forgets the verdict ─────────────────────────────────
  {
    clearMembershipCache();
    const h = harness([true, false]);
    await isStillOrgMember(9, "ida", "tok", h.deps);
    forgetMembership(9);
    check("forgetting forces a fresh check before the TTL",
      await isStillOrgMember(9, "ida", "tok", h.deps) === false, h.calls());
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
