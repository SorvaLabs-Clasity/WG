/**
 * Tests for remembering which AWS profile you signed in with.
 *
 * The bug was quiet and daily: the choice lived in process.env, the embedded
 * backend dies with the window, and so every launch fell back to "default" and
 * asked again. The tests that matter here are the ones about *when* something
 * is remembered — storing a profile that never worked, or keeping one after
 * someone deliberately signed out, are both worse than forgetting.
 */
import fs from "fs";
import os from "os";
import path from "path";

const FILE = path.join(os.homedir(), ".github-control-hub", "desktop.json");

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

// Never clobber a real one: this runs on the machine it is describing.
const had = fs.existsSync(FILE);
const previous = had ? fs.readFileSync(FILE, "utf8") : null;

(async () => {
  const prefs = await import("./src/services/desktopPrefs");
  try {
    // ── round trip ───────────────────────────────────────────────────
    {
      prefs.rememberAwsProfile("work-admin");
      check("a profile survives being written and read back",
        prefs.readDesktopPrefs().awsProfile === "work-admin", prefs.readDesktopPrefs());

      check("  the file is not world-readable",
        (fs.statSync(FILE).mode & 0o077) === 0,
        (fs.statSync(FILE).mode & 0o777).toString(8));
    }

    // ── restoring at startup ─────────────────────────────────────────
    {
      delete process.env.AWS_PROFILE;
      delete process.env.__SERVER_MODE__;
      check("startup restores the remembered profile",
        prefs.restoreAwsProfile() === "work-admin" && process.env.AWS_PROFILE === "work-admin",
        process.env.AWS_PROFILE);

      // Someone who set AWS_PROFILE is being deliberate; a remembered click
      // must not quietly override them.
      process.env.AWS_PROFILE = "explicit";
      check("  an explicit AWS_PROFILE wins over the remembered one",
        prefs.restoreAwsProfile() === "explicit" && process.env.AWS_PROFILE === "explicit",
        process.env.AWS_PROFILE);

      // On EC2 there are no profiles, only the instance role. Setting one
      // would point the whole server at a profile that does not exist there.
      delete process.env.AWS_PROFILE;
      process.env.__SERVER_MODE__ = "1";
      check("  a server deployment ignores it entirely",
        prefs.restoreAwsProfile() === undefined && !process.env.AWS_PROFILE,
        process.env.AWS_PROFILE);
      delete process.env.__SERVER_MODE__;
    }

    // ── signing out ──────────────────────────────────────────────────
    {
      prefs.rememberAwsProfile("work-admin");
      prefs.forgetAwsProfile();
      delete process.env.AWS_PROFILE;
      check("signing out of AWS forgets the profile",
        prefs.restoreAwsProfile() === undefined, prefs.readDesktopPrefs());
      check("  so the next launch does not reconnect to the account you left",
        !process.env.AWS_PROFILE, process.env.AWS_PROFILE);
    }

    // ── the file is a convenience, never a dependency ────────────────
    {
      fs.writeFileSync(FILE, "{ this is not json");
      check("a corrupt preferences file reads as no preference, not a crash",
        JSON.stringify(prefs.readDesktopPrefs()) === "{}", prefs.readDesktopPrefs());

      fs.rmSync(FILE, { force: true });
      delete process.env.AWS_PROFILE;
      check("  and a missing one does the same",
        prefs.restoreAwsProfile() === undefined);

      // Writing over the corrupt file must still work, or one bad write would
      // mean it is never remembered again.
      prefs.rememberAwsProfile("recovered");
      check("  and a later write repairs it",
        prefs.readDesktopPrefs().awsProfile === "recovered", prefs.readDesktopPrefs());
    }

    // ── only profiles that worked ────────────────────────────────────
    {
      const auth = fs.readFileSync(path.join(__dirname, "src/routes/auth.ts"), "utf8");

      // Remembering on the way in would mean a typo becomes the profile you
      // are offered every launch from then on.
      const reconnect = auth.slice(auth.indexOf('router.post("/reconnect-aws"'),
                                   auth.indexOf('router.post("/aws-sso-login"'));
      check("the profile is remembered after DynamoDB answered, not before",
        reconnect.indexOf("ScanCommand") < reconnect.indexOf("rememberAwsProfile"),
        "rememberAwsProfile is called before the connection is proven");

      check("  and signing out calls forget",
        /invalidate-aws[\s\S]*?forgetAwsProfile/.test(auth),
        "invalidate-aws does not forget the profile");

      // Nothing secret belongs in a plain file in the home directory.
      const svc = fs.readFileSync(path.join(__dirname, "src/services/desktopPrefs.ts"), "utf8");
      for (const secret of ["AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "token"]) {
        check(`  no ${secret} is ever written to the preferences file`,
          !svc.includes(secret), secret);
      }
    }
  } finally {
    if (previous !== null) fs.writeFileSync(FILE, previous);
    else fs.rmSync(FILE, { force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
