/**
 * Tests for what the sign-in page says in each state.
 *
 * This is a message-ordering test, which sounds trivial and is not: the two
 * bugs it locks down both told someone to go and fix the wrong thing.
 *
 * The OAuth secrets are read from Secrets Manager, so `ghConfigured` is false
 * whenever AWS is down — for a reason that has nothing to do with the build.
 * Checking that condition first produced "OAuth is not configured on this
 * build" on any machine that had not signed in to AWS yet, which is a sentence
 * about packaging pointing at a problem that is one card above it.
 *
 * The logic is mirrored here rather than imported, because it lives inside a
 * TSX subtitle expression. So the test also asserts the source still has the
 * branches in this order — a mirror that can drift silently is worse than no
 * test.
 */
import fs from "fs";
import path from "path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** The GitHub card's subtitle, in the order LoginPage evaluates it. */
function githubSubtitle(s: {
  ghAuthed: boolean; org?: string | null; awsOk: boolean;
  ghConfigured: boolean; settling: boolean; reason?: string;
}): string {
  if (s.ghAuthed) return s.org ? `Member of ${s.org}` : "Authenticated";
  if (!s.awsOk) return "Unlocks once AWS is connected";
  if (!s.ghConfigured) {
    if (s.settling) return "Loading credentials…";
    if (s.reason === "secret_missing") return "No GitHub credentials stored yet — run scripts/migrate-to-account.sh";
    if (s.reason === "secret_unreadable") return "The credentials secret exists but could not be read — check this account's permissions";
    if (s.reason === "secret_incomplete") return "The credentials secret is missing its OAuth keys";
    return "OAuth is not configured on this build";
  }
  return "Your own account — the app acts as you, never as someone else";
}

const base = { ghAuthed: false, awsOk: false, ghConfigured: false, settling: true };

(async () => {
  // ── a fresh machine, nobody signed in to anything ─────────────────
  {
    const msg = githubSubtitle(base);
    check("with AWS down, the page blames AWS rather than the build",
      msg === "Unlocks once AWS is connected", msg);
    check("  and never says the build lacks OAuth, which it cannot know yet",
      !msg.includes("this build"), msg);
  }

  // ── AWS up, secrets still loading ─────────────────────────────────
  {
    const msg = githubSubtitle({ ...base, awsOk: true, settling: true });
    check("AWS up and secrets in flight reads as loading",
      msg === "Loading credentials…", msg);
  }

  // ── AWS up, secrets loaded ────────────────────────────────────────
  {
    const msg = githubSubtitle({ ...base, awsOk: true, ghConfigured: true });
    check("AWS up and OAuth configured invites a sign-in",
      msg.startsWith("Your own account"), msg);
  }

  // ── AWS up, but nobody has run setup yet ──────────────────────────
  {
    const msg = githubSubtitle({ ...base, awsOk: true, settling: false, reason: "secret_missing" });
    check("an install whose secret was never created names the setup step",
      msg.includes("migrate-to-account.sh"), msg);
    check("  and does not blame the build for a step nobody has run",
      !msg.includes("this build"), msg);

    const unreadable = githubSubtitle({ ...base, awsOk: true, settling: false, reason: "secret_unreadable" });
    check("  a secret that exists but cannot be read says so",
      unreadable.includes("permissions"), unreadable);
  }

  // ── AWS up, genuinely no OAuth secrets ────────────────────────────
  {
    // No reason given: the secret loaded and simply had no OAuth keys in it,
    // which really is a build or configuration fault.
    const msg = githubSubtitle({ ...base, awsOk: true, settling: false });
    check("only a build that truly shipped without credentials is blamed",
      msg === "OAuth is not configured on this build", msg);
  }

  // ── signed in ─────────────────────────────────────────────────────
  {
    check("a signed-in user sees their organization",
      githubSubtitle({ ...base, ghAuthed: true, awsOk: true, ghConfigured: true, org: "acme" })
        === "Member of acme");
    check("  and still resolves when the org is unknown",
      githubSubtitle({ ...base, ghAuthed: true, awsOk: true, ghConfigured: true, org: null })
        === "Authenticated");
  }

  // ── the mirror matches the page ───────────────────────────────────
  {
    const src = fs.readFileSync(
      path.join(__dirname, "../frontend/src/pages/LoginPage.tsx"), "utf8");
    // The GitHub card only — the AWS card has a subtitle block too, and
    // slicing loosely picked that one up instead.
    const start = src.indexOf("subtitle={", src.indexOf("ph-fill ph-github-logo"));
    const sub = src.slice(start, src.indexOf("never as someone else", start));

    check("the page checks AWS before it checks OAuth",
      sub.indexOf("!awsOk") < sub.indexOf("!ghConfigured"),
      "LoginPage reports a missing OAuth config before checking AWS");

    check("  and does not poll for secrets while AWS is the blocker",
      /if \(!awsOk\) return;/.test(src),
      "the settling poll runs before AWS is up, wasting its timeout");

    check("  nor spins the GitHub card while AWS is the blocker",
      /busy=\{loading \|\| refreshing === "github" \|\| \(awsOk && !ghConfigured && settling\)\}/.test(src),
      "the GitHub card shows busy when AWS is what is missing");
  }

  // ── native dropdowns are told which scheme they are in ────────────
  {
    const css = fs.readFileSync(
      path.join(__dirname, "../frontend/src/index.css"), "utf8");
    check("color-scheme is declared for both themes",
      /:root\s*\{\s*color-scheme:\s*light/.test(css) && /:root\.dark\s*\{\s*color-scheme:\s*dark/.test(css),
      "without this, Windows draws a light dropdown behind light text");
    check("  and option colours fall back to system colours",
      /select option[\s\S]{0,80}background-color:\s*Canvas/.test(css), "no option colour fallback");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
